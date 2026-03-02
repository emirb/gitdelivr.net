/**
 * Two-tier caching with distributed lock for thundering herd protection.
 *
 *   Tier 1: Cloudflare Cache API — edge-local, 300+ PoPs, <10ms
 *   Tier 2: R2 — durable, single region, streams via ReadableStream
 *
 * Distributed lock:
 *   Uses R2 conditional put (onlyIf: { etagDoesNotMatch: '*' }) to
 *   atomically acquire a "fill lock" — only one Worker fills the cache,
 *   all others passthrough or wait briefly then recheck.
 */

const CACHE_URL_BASE = 'https://gitcdn-cache.internal';
const EDGE_PROMOTE_MAX = 500 * 1024 * 1024;
const EDGE_CACHE_MAX = 500 * 1024 * 1024;
const PENDING_TTL_SECONDS = 3600;
const LOCK_TTL_SECONDS = 300; // 5 min lock

export class Cache {
  private bucket: R2Bucket;
  private prefix: string;
  private edgeCache: globalThis.Cache | null = null;

  constructor(bucket: R2Bucket, origin: string, owner: string, repo: string) {
    this.bucket = bucket;
    this.prefix = `${origin}/${owner}/${repo}`;
  }

  private async getEdgeCache(): Promise<globalThis.Cache> {
    if (!this.edgeCache) this.edgeCache = await caches.open('gitcdn');
    return this.edgeCache;
  }
  private cacheUrl(key: string): string { return `${CACHE_URL_BASE}/${key}`; }

  // ── Edge helpers ────────────────────────────────────────────────────
  private async edgeGet(key: string): Promise<Response | undefined> {
    return (await this.getEdgeCache()).match(new Request(this.cacheUrl(key)));
  }
  private async edgeDelete(key: string): Promise<boolean> {
    return (await this.getEdgeCache()).delete(new Request(this.cacheUrl(key)));
  }
  private async edgePut(key: string, body: ArrayBuffer | ReadableStream, ct: string, ttl: number, size?: number): Promise<void> {
    const h: Record<string, string> = { 'Content-Type': ct, 'Cache-Control': `public, max-age=${ttl}` };
    if (size !== undefined) h['Content-Length'] = String(size);
    await (await this.getEdgeCache()).put(new Request(this.cacheUrl(key)), new Response(body, { headers: h }));
  }

  // ── Refs ────────────────────────────────────────────────────────────
  private refsKey(): string { return `refs/${this.prefix}`; }

  async getRefs(): Promise<{ body: ArrayBuffer; contentType: string; tier: 'edge' | 'r2' } | null> {
    const key = this.refsKey();
    const er = await this.edgeGet(key);
    if (er) return { body: await er.arrayBuffer(), contentType: er.headers.get('content-type') || 'application/x-git-upload-pack-advertisement', tier: 'edge' };
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { body: await obj.arrayBuffer(), contentType: obj.httpMetadata?.contentType || 'application/x-git-upload-pack-advertisement', tier: 'r2' };
  }

  async putRefs(body: ArrayBuffer, headers: Record<string, string>, ttl: number): Promise<void> {
    const key = this.refsKey();
    const ct = headers['content-type'] || 'application/x-git-upload-pack-advertisement';
    await Promise.all([
      this.bucket.put(key, body, { httpMetadata: { contentType: ct, cacheControl: `public, max-age=${ttl}` }, customMetadata: { cachedAt: new Date().toISOString(), ttl: String(ttl) } }),
      this.edgePut(key, body, ct, ttl),
    ]);
  }

  async isRefsFresh(ttl: number): Promise<boolean> {
    if (await this.edgeGet(this.refsKey())) return true;
    const obj = await this.bucket.head(this.refsKey());
    if (!obj?.customMetadata?.cachedAt) return false;
    return (Date.now() - new Date(obj.customMetadata.cachedAt).getTime()) / 1000 < ttl;
  }

  promoteRefsToEdge(body: ArrayBuffer, ttl: number): Promise<void> {
    return this.edgePut(this.refsKey(), body, 'application/x-git-upload-pack-advertisement', ttl);
  }

  // ── Protocol v2 metadata (short TTL) ────────────────────────────────
  private v2Key(bodyHash: string): string { return `v2/${this.prefix}/${bodyHash}`; }

  async getV2Command(bodyHash: string): Promise<{ body: ArrayBuffer; contentType: string; tier: 'edge' | 'r2' } | null> {
    const key = this.v2Key(bodyHash);
    const er = await this.edgeGet(key);
    if (er) {
      return {
        body: await er.arrayBuffer(),
        contentType: er.headers.get('content-type') || 'application/x-git-upload-pack-result',
        tier: 'edge',
      };
    }
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return {
      body: await obj.arrayBuffer(),
      contentType: obj.httpMetadata?.contentType || 'application/x-git-upload-pack-result',
      tier: 'r2',
    };
  }

  async putV2Command(bodyHash: string, body: ArrayBuffer, contentType: string, ttl: number): Promise<void> {
    const key = this.v2Key(bodyHash);
    await Promise.all([
      this.bucket.put(key, body, {
        httpMetadata: { contentType, cacheControl: `public, max-age=${ttl}` },
        customMetadata: { cachedAt: new Date().toISOString(), ttl: String(ttl) },
      }),
      this.edgePut(key, body, contentType, ttl, body.byteLength),
    ]);
  }

  async isV2CommandFresh(bodyHash: string, ttl: number): Promise<boolean> {
    if (await this.edgeGet(this.v2Key(bodyHash))) return true;
    const obj = await this.bucket.head(this.v2Key(bodyHash));
    if (!obj?.customMetadata?.cachedAt) return false;
    return (Date.now() - new Date(obj.customMetadata.cachedAt).getTime()) / 1000 < ttl;
  }

  // ── Pack cache (STREAMING) ──────────────────────────────────────────
  private packKey(h: string): string { return `pack/${this.prefix}/${h}`; }

  async getPackStream(bodyHash: string): Promise<{ body: ReadableStream; size: number; tier: 'edge' | 'r2' } | null> {
    const key = this.packKey(bodyHash);
    const er = await this.edgeGet(key);
    if (er?.body) return { body: er.body, size: parseInt(er.headers.get('content-length') || '0', 10), tier: 'edge' };
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { body: obj.body, size: obj.size, tier: 'r2' };
  }

  async putPack(bodyHash: string, body: ArrayBuffer): Promise<void> {
    const key = this.packKey(bodyHash);
    const ct = 'application/x-git-upload-pack-result';
    await Promise.all([
      this.bucket.put(key, body, { httpMetadata: { contentType: ct }, customMetadata: { cachedAt: new Date().toISOString() } }),
      body.byteLength < EDGE_CACHE_MAX ? this.edgePut(key, body, ct, 31536000, body.byteLength) : Promise.resolve(),
    ]);
  }

  async createMultipartPack(bodyHash: string): Promise<R2MultipartUpload> {
    return this.bucket.createMultipartUpload(this.packKey(bodyHash), {
      httpMetadata: { contentType: 'application/x-git-upload-pack-result' },
      customMetadata: { cachedAt: new Date().toISOString() },
    });
  }

  async promoteStreamToEdge(bodyHash: string, size: number): Promise<void> {
    if (size > EDGE_PROMOTE_MAX) return;
    const obj = await this.bucket.get(this.packKey(bodyHash));
    if (!obj) return;
    await this.edgePut(this.packKey(bodyHash), obj.body, 'application/x-git-upload-pack-result', 31536000, obj.size);
  }

  // ── Distributed lock (thundering herd protection) ───────────────────
  // Uses R2 conditional put: only succeeds if key doesn't exist yet.
  // This is atomic — only one Worker wins the race.

  private lockKey(bodyHash: string): string { return `lock/${this.prefix}/${bodyHash}`; }

  /**
   * Try to acquire a fill lock for this bodyHash.
   * Returns true if we got the lock (we should fill the cache).
   * Returns false if someone else has the lock (we should passthrough or wait).
   */
  async tryAcquireLock(bodyHash: string): Promise<boolean> {
    const key = this.lockKey(bodyHash);
    try {
      const result = await this.bucket.put(key, new Date().toISOString(), {
        customMetadata: { lockedAt: new Date().toISOString() },
        onlyIf: { etagDoesNotMatch: '*' }, // only if key doesn't exist
      });
      return result !== null; // null = condition failed (lock exists)
    } catch {
      return false; // any error = assume locked
    }
  }

  /**
   * Check if a lock exists and hasn't expired.
   */
  async isLocked(bodyHash: string): Promise<boolean> {
    const obj = await this.bucket.head(this.lockKey(bodyHash));
    if (!obj?.customMetadata?.lockedAt) return false;
    const age = (Date.now() - new Date(obj.customMetadata.lockedAt).getTime()) / 1000;
    return age < LOCK_TTL_SECONDS;
  }

  /**
   * Release lock after successful cache fill.
   */
  async releaseLock(bodyHash: string): Promise<void> {
    await this.bucket.delete(this.lockKey(bodyHash));
  }

  // ── Pending markers (cache-aside) ───────────────────────────────────
  private pendingKey(h: string): string { return `pending/${this.prefix}/${h}`; }

  async markPending(bodyHash: string): Promise<void> {
    await this.bucket.put(this.pendingKey(bodyHash), '', { customMetadata: { createdAt: new Date().toISOString() } });
  }

  async isPending(bodyHash: string): Promise<boolean> {
    const obj = await this.bucket.head(this.pendingKey(bodyHash));
    if (!obj?.customMetadata?.createdAt) return false;
    return (Date.now() - new Date(obj.customMetadata.createdAt).getTime()) / 1000 < PENDING_TTL_SECONDS;
  }

  async getFillState(bodyHash: string): Promise<{ pending: boolean; locked: boolean }> {
    const [pendingObj, lockObj] = await Promise.all([
      this.bucket.head(this.pendingKey(bodyHash)),
      this.bucket.head(this.lockKey(bodyHash)),
    ]);

    const pending = !!pendingObj?.customMetadata?.createdAt &&
      (Date.now() - new Date(pendingObj.customMetadata.createdAt).getTime()) / 1000 < PENDING_TTL_SECONDS;

    const locked = !!lockObj?.customMetadata?.lockedAt &&
      (Date.now() - new Date(lockObj.customMetadata.lockedAt).getTime()) / 1000 < LOCK_TTL_SECONDS;

    return { pending, locked };
  }

  async clearPending(bodyHash: string): Promise<void> {
    await this.bucket.delete(this.pendingKey(bodyHash));
  }

  async deleteRefs(): Promise<void> {
    const key = this.refsKey();
    await Promise.all([
      this.bucket.delete(key),
      this.edgeDelete(key),
    ]);
  }

  // ── LFS cache ───────────────────────────────────────────────────────
  private lfsKey(oid: string): string { return `lfs/${this.prefix}/${oid}`; }

  async getLfsObject(oid: string): Promise<{ body: ReadableStream; size: number; tier: 'edge' | 'r2' } | null> {
    const key = this.lfsKey(oid);
    const er = await this.edgeGet(key);
    if (er?.body) return { body: er.body, size: parseInt(er.headers.get('content-length') || '0', 10), tier: 'edge' };
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { body: obj.body, size: obj.size, tier: 'r2' };
  }

  async hasLfsObject(oid: string): Promise<boolean> {
    return (await this.bucket.head(this.lfsKey(oid))) !== null;
  }

  async putLfsObject(oid: string, body: ArrayBuffer): Promise<void> {
    const key = this.lfsKey(oid);
    await Promise.all([
      this.bucket.put(key, body, { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { cachedAt: new Date().toISOString(), oid } }),
      body.byteLength < EDGE_CACHE_MAX ? this.edgePut(key, body, 'application/octet-stream', 31536000, body.byteLength) : Promise.resolve(),
    ]);
  }

  async createMultipartLfs(oid: string): Promise<R2MultipartUpload> {
    return this.bucket.createMultipartUpload(this.lfsKey(oid), {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { cachedAt: new Date().toISOString(), oid },
    });
  }

  // ── Archive cache ───────────────────────────────────────────────────
  private archiveKey(ref: string, ext: string): string { return `archive/${this.prefix}/${ref}.${ext}`; }
  private archiveCt(ext: string): string {
    return ({ 'tar.gz': 'application/gzip', zip: 'application/zip', tar: 'application/x-tar', 'tar.bz2': 'application/x-bzip2' } as Record<string, string>)[ext] || 'application/octet-stream';
  }

  async getArchive(ref: string, ext: string): Promise<{ body: ReadableStream; size: number; tier: 'edge' | 'r2' } | null> {
    const key = this.archiveKey(ref, ext);
    const er = await this.edgeGet(key);
    if (er?.body) return { body: er.body, size: parseInt(er.headers.get('content-length') || '0', 10), tier: 'edge' };
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { body: obj.body, size: obj.size, tier: 'r2' };
  }

  async putArchive(ref: string, ext: string, body: ArrayBuffer): Promise<void> {
    const key = this.archiveKey(ref, ext);
    const ct = this.archiveCt(ext);
    await Promise.all([
      this.bucket.put(key, body, { httpMetadata: { contentType: ct }, customMetadata: { cachedAt: new Date().toISOString(), ref } }),
      body.byteLength < EDGE_CACHE_MAX ? this.edgePut(key, body, ct, 86400, body.byteLength) : Promise.resolve(),
    ]);
  }

  async createMultipartArchive(ref: string, ext: string): Promise<R2MultipartUpload> {
    return this.bucket.createMultipartUpload(this.archiveKey(ref, ext), {
      httpMetadata: { contentType: this.archiveCt(ext) },
      customMetadata: { cachedAt: new Date().toISOString(), ref },
    });
  }

  async promoteArchiveToEdge(ref: string, ext: string, size: number): Promise<void> {
    if (size > EDGE_PROMOTE_MAX) return;
    const key = this.archiveKey(ref, ext);
    const obj = await this.bucket.get(key);
    if (!obj) return;
    await this.edgePut(key, obj.body, this.archiveCt(ext), 86400, obj.size);
  }
}

// ── Hashing ─────────────────────────────────────────────────────────────
export async function hashBody(body: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', body);
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
}
