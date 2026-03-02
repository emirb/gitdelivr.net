/**
 * git-upload-pack handler with cache-aside pattern + distributed lock.
 *
 * Flow for large repos (>50MB):
 *
 *   Request 1 (cache miss, no lock):
 *     → tryAcquireLock() succeeds → mark pending
 *     → passthrough origin → client (full speed)
 *
 *   Request 2 (cache miss, pending, lock acquired):
 *     → tryAcquireLock() succeeds → stream via TransformStream
 *     → inline R2 multipart write → fills cache → release lock
 *
 *   Request 2b (concurrent with request 2, lock held by someone else):
 *     → tryAcquireLock() fails → isLocked() true
 *     → wait 500ms → recheck cache → if still miss, passthrough
 *
 *   Request 3+ (cache hit):
 *     → R2 stream → client (fast)
 */

import { Cache, hashBody } from './cache';
import { originEndpoint } from './config';

interface UploadPackContext {
  originUrl: string;
  cache: Cache;
  ctx: ExecutionContext;
  recordClone?: () => Promise<void> | void;
}

interface RequestInspection {
  protocol: string | null;
  bodyHash: string;
  command: string | null;
  cloneLike: boolean;
}

const PART_SIZE = 10 * 1024 * 1024;
const MAX_CACHE_SIZE = 5 * 1024 * 1024 * 1024;
const MAX_REQUEST_BODY = 10 * 1024 * 1024;
const BUFFER_THRESHOLD = 16 * 1024 * 1024;
const UNKNOWN_LENGTH_BUFFER_THRESHOLD = 4 * 1024 * 1024;
const EDGE_PROMOTE_MAX = 500 * 1024 * 1024;
const LOCK_WAIT_MS = 350;
const LOCK_RETRIES = 4;
const MULTIPART_MAX_INFLIGHT = 2;
const V2_META_TTL = 60;
const MAX_REDIRECTS = 5;

export async function handleUploadPack(request: Request, ctx: UploadPackContext): Promise<Response> {
  const requestBody = await request.arrayBuffer();
  console.log(`Upload-pack request: ${requestBody.byteLength} bytes, protocol: ${request.headers.get('Git-Protocol')}`);

  if (requestBody.byteLength > MAX_REQUEST_BODY) return new Response('Request body too large', { status: 413 });
  const inspection = await inspectRequest(requestBody, request.headers);
  const protocol = inspection.protocol;
  if (protocol === 'version=2') {
    return maybeRecordClone(await handleProtocolV2(request, ctx, requestBody, inspection), inspection.cloneLike, ctx);
  }

  // Empty or very small bodies (flush packets, done packets) are valid in git protocol v1
  // Proxy them straight through to origin without caching
  if (requestBody.byteLength === 0 || (requestBody.byteLength === 4 && new Uint8Array(requestBody)[0] === 0)) {
    console.log('Proxying empty/flush packet to origin');
    return maybeRecordClone(await proxyToOrigin(request, ctx, requestBody), inspection.cloneLike, ctx);
  }
  const bodyHash = inspection.bodyHash;

  // ── Cache check ─────────────────────────────────────────────────────
  const cached = await ctx.cache.getPackStream(bodyHash);
  if (cached) {
    return maybeRecordClone(new Response(cached.body, { status: 200, headers: packH('HIT', cached.tier, bodyHash, cached.size) }), inspection.cloneLike, ctx);
  }

  const waited = await waitForConcurrentFill(bodyHash, ctx);
  if (waited) {
    return maybeRecordClone(waited, inspection.cloneLike, ctx);
  }

  // ── Fetch from origin ───────────────────────────────────────────────
  console.log('Fetching from origin...');
  const upResp = await fetchUpstream(request, ctx, requestBody);
  console.log(`Upstream response: ${upResp.status}`);
  if (upResp.status !== 200) return maybeRecordClone(upResp, inspection.cloneLike, ctx);

  const cl = parseInt(upResp.headers.get('content-length') || '0', 10);

  // Skip negotiation rounds
  if (cl > 0 && cl < 1024)
    return maybeRecordClone(passthroughResponse(upResp, { 'X-GitCDN-Cache': 'NEGOTIATION', 'X-GitCDN-Tier': 'origin' }), inspection.cloneLike, ctx);

  // ── SMALL: buffer + cache ───────────────────────────────────────────
  if (cl > 0 && cl < BUFFER_THRESHOLD) return maybeRecordClone(await handleBufferPath(upResp, bodyHash, ctx), inspection.cloneLike, ctx);
  if (cl === 0) return maybeRecordClone(await handleChunkedPath(upResp, bodyHash, ctx), inspection.cloneLike, ctx);

  // ── LARGE: cache-aside with distributed lock ────────────────────────
  return maybeRecordClone(await handleLargePack(upResp, bodyHash, cl, ctx), inspection.cloneLike, ctx);
}

async function handleBufferPath(upResp: Response, bodyHash: string, ctx: UploadPackContext): Promise<Response> {
  const body = await upResp.arrayBuffer();
  ctx.ctx.waitUntil(ctx.cache.putPack(bodyHash, body).catch(() => {}));
  return new Response(body, { status: 200, headers: packH('MISS', 'buffer', bodyHash) });
}

async function handleProtocolV2(
  request: Request,
  ctx: UploadPackContext,
  requestBody: ArrayBuffer,
  inspection: RequestInspection
): Promise<Response> {
  console.log(`Protocol v2 command: ${inspection.command ?? 'unknown'}`);

  if (inspection.command === 'ls-refs') {
    return handleV2LsRefs(request, ctx, requestBody, inspection);
  }

  if (inspection.command && inspection.command !== 'fetch') {
    return proxyToOrigin(request, ctx, requestBody, { 'X-GitCDN-Cache': 'BYPASS', 'X-GitCDN-Tier': `v2-${inspection.command}` });
  }

  return handleCacheablePack(request, ctx, requestBody, inspection);
}

async function handleV2LsRefs(
  request: Request,
  ctx: UploadPackContext,
  requestBody: ArrayBuffer,
  inspection: RequestInspection
): Promise<Response> {
  const bodyHash = inspection.bodyHash;

  if (await ctx.cache.isV2CommandFresh(bodyHash, V2_META_TTL)) {
    const cached = await ctx.cache.getV2Command(bodyHash);
    if (cached) {
      return new Response(cached.body, {
        status: 200,
        headers: {
          'Content-Type': cached.contentType,
          'X-GitCDN-Cache': 'HIT',
          'X-GitCDN-Tier': `v2-${cached.tier}`,
          'X-GitCDN-Source': cached.tier,
          'X-GitCDN-Edge-Eligible': 'yes',
          'Cache-Control': `public, max-age=${V2_META_TTL}`,
        },
      });
    }
  }

  const upResp = await fetchUpstream(request, ctx, requestBody, { forceIdentityEncoding: true });
  if (upResp.status !== 200) return upResp;
  if (!isGitUploadPackContentType(upResp.headers.get('content-type'))) {
    return new Response('Origin returned a non-Git upload-pack response, likely an anti-bot or HTML page.', {
      status: 502,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-GitCDN-Cache': 'BYPASS',
        'X-GitCDN-Tier': 'origin-invalid',
      },
    });
  }

  const body = await upResp.arrayBuffer();
  const contentType = upResp.headers.get('content-type') || 'application/x-git-upload-pack-result';
  ctx.ctx.waitUntil(ctx.cache.putV2Command(bodyHash, body, contentType, V2_META_TTL).catch(() => {}));

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'X-GitCDN-Cache': 'MISS',
      'X-GitCDN-Tier': 'v2-ls-refs',
      'X-GitCDN-Source': 'origin',
      'X-GitCDN-Edge-Eligible': 'yes',
      'Cache-Control': `public, max-age=${V2_META_TTL}`,
    },
  });
}

async function handleCacheablePack(
  request: Request,
  ctx: UploadPackContext,
  requestBody: ArrayBuffer,
  inspection: RequestInspection
): Promise<Response> {
  const bodyHash = inspection.bodyHash;

  const cached = await ctx.cache.getPackStream(bodyHash);
  if (cached) {
    return new Response(cached.body, { status: 200, headers: packH('HIT', cached.tier, bodyHash, cached.size) });
  }

  const waited = await waitForConcurrentFill(bodyHash, ctx);
  if (waited) {
    return waited;
  }

  console.log('Fetching from origin...');
  const upResp = await fetchUpstream(request, ctx, requestBody, { forceIdentityEncoding: true });
  console.log(`Upstream response: ${upResp.status}`);
  if (upResp.status !== 200) return upResp;
  if (!isGitUploadPackContentType(upResp.headers.get('content-type'))) {
    return new Response('Origin returned a non-Git upload-pack response, likely an anti-bot or HTML page.', {
      status: 502,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-GitCDN-Cache': 'BYPASS',
        'X-GitCDN-Tier': 'origin-invalid',
      },
    });
  }

  const cl = parseInt(upResp.headers.get('content-length') || '0', 10);

  if (cl > 0 && cl < 1024) {
    return passthroughResponse(upResp, { 'X-GitCDN-Cache': 'NEGOTIATION', 'X-GitCDN-Tier': 'origin' });
  }

  if (cl > 0 && cl < BUFFER_THRESHOLD) return handleBufferPath(upResp, bodyHash, ctx);
  if (cl === 0) return handleChunkedPath(upResp, bodyHash, ctx);

  return handleLargePack(upResp, bodyHash, cl, ctx);
}

async function handleChunkedPath(upResp: Response, bodyHash: string, ctx: UploadPackContext): Promise<Response> {
  if (!upResp.body) return new Response('Empty upstream', { status: 502 });

  const isPending = await ctx.cache.isPending(bodyHash);
  if (!isPending) {
    await ctx.cache.markPending(bodyHash);
    const gotLock = await ctx.cache.tryAcquireLock(bodyHash);
    if (gotLock) {
      return startChunkedCacheFill(upResp, bodyHash, ctx);
    }
    return handleChunkedPassthrough(upResp, bodyHash, ctx);
  }

  const gotLock = await ctx.cache.tryAcquireLock(bodyHash);
  if (!gotLock) {
    const locked = await ctx.cache.isLocked(bodyHash);
    if (locked) {
      for (let i = 0; i < LOCK_RETRIES; i++) {
        await sleep(LOCK_WAIT_MS);
        const rechecked = await ctx.cache.getPackStream(bodyHash);
        if (rechecked) {
          return new Response(rechecked.body, { status: 200, headers: packH('HIT', 'waited-' + rechecked.tier, bodyHash, rechecked.size) });
        }
      }
    }
    return new Response(upResp.body, { status: 200, headers: packH('MISS', 'contended', bodyHash) });
  }

  return startChunkedCacheFill(upResp, bodyHash, ctx);
}

function startChunkedCacheFill(upResp: Response, bodyHash: string, ctx: UploadPackContext): Response {
  if (!upResp.body) return new Response('Empty upstream', { status: 502 });
  const { readable, writable } = new TransformStream();
  const cacheWriter = new R2MultipartWriter(ctx.cache, bodyHash);
  const pumpPromise = pumpWithCaching(upResp.body.getReader(), writable.getWriter(), cacheWriter);

  ctx.ctx.waitUntil(pumpPromise.then(async (ok) => {
    if (ok) {
      await ctx.cache.clearPending(bodyHash);
      if (cacheWriter.bytesWritten <= EDGE_PROMOTE_MAX) {
        await ctx.cache.promoteStreamToEdge(bodyHash, cacheWriter.bytesWritten).catch(() => {});
      }
    }
    await ctx.cache.releaseLock(bodyHash);
  }).catch(async () => { await ctx.cache.releaseLock(bodyHash).catch(() => {}); }));

  return new Response(readable, { status: 200, headers: packH('MISS', 'cache-fill-chunked', bodyHash) });
}

async function handleChunkedPassthrough(upResp: Response, bodyHash: string, ctx: UploadPackContext): Promise<Response> {
  if (!upResp.body) return new Response('Empty upstream', { status: 502 });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upResp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceededThreshold = false;

  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
        if (!exceededThreshold) {
          total += value.byteLength;
          if (total <= UNKNOWN_LENGTH_BUFFER_THRESHOLD) {
            chunks.push(value);
          } else {
            exceededThreshold = true;
            chunks.length = 0;
          }
        }
      }
      await writer.close();
    } catch (e) {
      try { await writer.abort(e); } catch {}
      throw e;
    }
  })();

  ctx.ctx.waitUntil(pump.then(async () => {
    if (!exceededThreshold && chunks.length > 0) {
      const body = concatChunks(chunks, total);
      await ctx.cache.putPack(bodyHash, body);
    }
  }).catch(() => {}));

  return new Response(readable, { status: 200, headers: packH('MISS', 'chunked', bodyHash) });
}

async function handleLargePack(upResp: Response, bodyHash: string, cl: number, ctx: UploadPackContext): Promise<Response> {
  if (!upResp.body) return new Response('Empty upstream', { status: 502 });

  const isPending = await ctx.cache.isPending(bodyHash);

  if (!isPending) {
    // First request ever: mark pending and try to become the cache-filler
    // immediately. This reduces origin stampedes on large cold misses.
    await ctx.cache.markPending(bodyHash);
    const gotLock = await ctx.cache.tryAcquireLock(bodyHash);
    if (!gotLock) {
      return new Response(upResp.body, { status: 200, headers: packH('MISS', 'contended', bodyHash) });
    }
    if (cl > MAX_CACHE_SIZE) {
      ctx.ctx.waitUntil(Promise.all([
        ctx.cache.clearPending(bodyHash),
        ctx.cache.releaseLock(bodyHash),
      ]));
      return new Response(upResp.body, { status: 200, headers: packH('MISS', 'too-large', bodyHash, cl) });
    }

    const { readable, writable } = new TransformStream();
    const cacheWriter = new R2MultipartWriter(ctx.cache, bodyHash);
    const pumpPromise = pumpWithCaching(upResp.body.getReader(), writable.getWriter(), cacheWriter);

    ctx.ctx.waitUntil(pumpPromise.then(async (ok) => {
      if (ok) {
        await ctx.cache.clearPending(bodyHash);
        if (cacheWriter.bytesWritten <= EDGE_PROMOTE_MAX) {
          await ctx.cache.promoteStreamToEdge(bodyHash, cacheWriter.bytesWritten).catch(() => {});
        }
      }
      await ctx.cache.releaseLock(bodyHash);
    }).catch(async () => { await ctx.cache.releaseLock(bodyHash).catch(() => {}); }));

    return new Response(readable, { status: 200, headers: packH('MISS', 'cache-fill', bodyHash, cl) });
  }

  // ── Pending exists — try to acquire fill lock ───────────────────────
  const gotLock = await ctx.cache.tryAcquireLock(bodyHash);

  if (!gotLock) {
    // Someone else is filling — wait briefly and recheck cache
    const locked = await ctx.cache.isLocked(bodyHash);
    if (locked) {
      for (let i = 0; i < LOCK_RETRIES; i++) {
        await sleep(LOCK_WAIT_MS);
        const rechecked = await ctx.cache.getPackStream(bodyHash);
        if (rechecked) {
          return new Response(rechecked.body, { status: 200, headers: packH('HIT', 'waited-' + rechecked.tier, bodyHash, rechecked.size) });
        }
      }
    }
    // Still no cache — passthrough (don't block the client)
    return new Response(upResp.body, { status: 200, headers: packH('MISS', 'contended', bodyHash) });
  }

  // ── We got the lock — fill the cache ────────────────────────────────
  if (cl > MAX_CACHE_SIZE) {
    ctx.ctx.waitUntil(Promise.all([
      ctx.cache.clearPending(bodyHash),
      ctx.cache.releaseLock(bodyHash),
    ]));
    return new Response(upResp.body, { status: 200, headers: packH('MISS', 'too-large', bodyHash) });
  }

  const { readable, writable } = new TransformStream();
  const cacheWriter = new R2MultipartWriter(ctx.cache, bodyHash);

  const pumpPromise = pumpWithCaching(upResp.body.getReader(), writable.getWriter(), cacheWriter);

  ctx.ctx.waitUntil(pumpPromise.then(async (ok) => {
    if (ok) {
      await ctx.cache.clearPending(bodyHash);
      if (cacheWriter.bytesWritten <= EDGE_PROMOTE_MAX) {
        await ctx.cache.promoteStreamToEdge(bodyHash, cacheWriter.bytesWritten).catch(() => {});
      }
    }
    await ctx.cache.releaseLock(bodyHash);
  }).catch(async () => { await ctx.cache.releaseLock(bodyHash).catch(() => {}); }));

  return new Response(readable, { status: 200, headers: packH('MISS', 'cache-fill', bodyHash) });
}

async function pumpWithCaching(reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array>, cw: R2MultipartWriter): Promise<boolean> {
  let ok = true;
  try {
    await cw.begin();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
      if (ok) { try { await cw.write(value); } catch { ok = false; try { await cw.abort(); } catch {} } }
    }
    await writer.close();
    if (ok) await cw.complete();
  } catch (e) {
    try { await writer.abort(e); } catch {}
    try { await cw.abort(); } catch {}
    ok = false;
  }
  return ok;
}

async function waitForConcurrentFill(bodyHash: string, ctx: UploadPackContext): Promise<Response | null> {
  const state = await ctx.cache.getFillState(bodyHash);
  if (!state.pending || !state.locked) {
    return null;
  }

  for (let i = 0; i < LOCK_RETRIES; i++) {
    await sleep(LOCK_WAIT_MS);
    const cached = await ctx.cache.getPackStream(bodyHash);
    if (cached) {
      return new Response(cached.body, {
        status: 200,
        headers: packH('HIT', 'waited-' + cached.tier, bodyHash, cached.size),
      });
    }

    if (!(await ctx.cache.getFillState(bodyHash)).locked) {
      break;
    }
  }

  return null;
}

class R2MultipartWriter {
  private cache: Cache; private hash: string;
  private upload: R2MultipartUpload | null = null;
  private parts: { partNumber: number; etag: string }[] = [];
  private inflight: Promise<void>[] = [];
  private pn = 1; private buf = new Uint8Array(PART_SIZE); private off = 0;
  private totalWritten = 0;

  constructor(cache: Cache, hash: string) { this.cache = cache; this.hash = hash; }

  async begin() { this.upload = await this.cache.createMultipartPack(this.hash); }

  async write(chunk: Uint8Array) {
    if (!this.upload) throw new Error('Not started');
    this.totalWritten += chunk.byteLength;
    let p = 0;
    while (p < chunk.byteLength) {
      const n = Math.min(PART_SIZE - this.off, chunk.byteLength - p);
      this.buf.set(chunk.subarray(p, p + n), this.off);
      this.off += n; p += n;
      if (this.off === PART_SIZE) await this.flush();
    }
  }

  private async flush() {
    if (!this.upload || this.off === 0) return;
    const partNumber = this.pn++;
    const data = this.buf.slice(0, this.off);
    this.off = 0;
    this.buf = new Uint8Array(PART_SIZE);

    const uploadPromise = this.upload.uploadPart(partNumber, data).then((part) => {
      this.parts.push({ partNumber, etag: part.etag });
    });
    this.inflight.push(uploadPromise);

    if (this.inflight.length >= MULTIPART_MAX_INFLIGHT) {
      await this.drainOne();
    }
  }

  async complete() {
    if (!this.upload) return;
    if (this.off > 0) await this.flush();
    await Promise.all(this.inflight);
    this.parts.sort((a, b) => a.partNumber - b.partNumber);
    this.parts.length > 0 ? await this.upload.complete(this.parts) : await this.upload.abort();
  }

  async abort() { try { await this.upload?.abort(); } catch {} }

  get bytesWritten(): number { return this.totalWritten; }

  private async drainOne(): Promise<void> {
    const next = this.inflight.shift();
    if (next) await next;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────
interface UpstreamFetchOptions { forceIdentityEncoding?: boolean; }

async function fetchUpstream(request: Request, ctx: UploadPackContext, body: ArrayBuffer, options: UpstreamFetchOptions = {}): Promise<Response> {
  const headers = buildUpstreamHeaders(request, options);
  const url = originEndpoint(ctx.originUrl, '/git-upload-pack');
  console.log(`Fetching upstream: ${url}, protocol: ${headers['Git-Protocol'] || 'v1'}, body size: ${body.byteLength}`);

  const resp = await fetchWithPreservedRedirects(url, headers, body);
  console.log(`Upstream response status: ${resp.status}`);
  if (!resp.ok) return passthroughResponse(resp);
  return resp;
}

function packH(cache: string, tier: string, hash: string, size?: number): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-git-upload-pack-result',
    'X-GitCDN-Cache': cache,
    'X-GitCDN-Tier': tier,
    'X-GitCDN-Source': cacheSourceForTier(tier),
    'X-GitCDN-Edge-Eligible': edgeEligibilityForTier(tier, size),
    'X-GitCDN-Hash': hash.slice(0, 12),
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
  if (size && size > 0) headers['Content-Length'] = String(size);
  return headers;
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function cacheSourceForTier(tier: string): string {
  if (tier.includes('edge')) return 'edge';
  if (tier.includes('r2')) return 'r2';
  return 'origin';
}

function edgeEligibilityForTier(tier: string, size?: number): string {
  if (size !== undefined) return size <= EDGE_PROMOTE_MAX ? 'yes' : 'no';
  if (tier === 'too-large') return 'no';
  if (tier.includes('r2') || tier.includes('edge') || tier === 'buffer' || tier === 'cache-fill' || tier === 'cache-fill-chunked' || tier === 'chunked') {
    return 'yes';
  }
  if (tier === 'passthrough' || tier === 'contended' || tier === 'origin') {
    return 'unknown';
  }
  return 'unknown';
}

// ── Proxy helper for empty/flush packets ─────────────────────────────────────
async function proxyToOrigin(
  request: Request,
  ctx: UploadPackContext,
  body: ArrayBuffer,
  extraHeaders: Record<string, string> = { 'X-GitCDN-Cache': 'BYPASS', 'X-GitCDN-Tier': 'origin' }
): Promise<Response> {
  const url = originEndpoint(ctx.originUrl, '/git-upload-pack');
  const headers = buildUpstreamHeaders(request);

  console.log(`Proxying to: ${url}, protocol: ${headers['Git-Protocol'] || 'v1'}, body size: ${body.byteLength}`);

  const resp = await fetchWithPreservedRedirects(url, headers, body);

  console.log(`Upstream response: ${resp.status} ${resp.statusText}`);
  return passthroughResponse(resp, extraHeaders);
}

async function fetchWithPreservedRedirects(url: string, headers: Record<string, string>, body: ArrayBuffer): Promise<Response> {
  let currentUrl = url;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const resp = await fetch(currentUrl, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
    });

    if (!isRedirect(resp.status)) return resp;

    const location = resp.headers.get('Location');
    if (!location) return resp;
    currentUrl = new URL(location, currentUrl).toString();
  }

  return new Response('Too many upstream redirects', { status: 502 });
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function inspectRequest(body: ArrayBuffer, headers: Headers): Promise<RequestInspection> {
  const protocol = headers.get('Git-Protocol');
  const normalizedBody = await decodeMaybeCompressed(body, headers.get('Content-Encoding'));
  const parsed = normalizedBody
    ? inspectPktLines(normalizedBody)
    : { command: null, hasWant: false, hasHave: false };
  const { command, hasWant, hasHave } = parsed;
  const cloneLike = protocol === 'version=2'
    ? command === 'fetch' && hasWant && !hasHave
    : hasWant && !hasHave;
  const bodyHash = protocol === 'version=2' && normalizedBody
    ? await hashWithPrefix(`git-upload-pack:${protocol}\n`, normalizedBody)
    : await hashBody(body);

  return {
    protocol,
    bodyHash,
    command,
    cloneLike,
  };
}

async function decodeMaybeCompressed(body: ArrayBuffer, contentEncoding: string | null): Promise<ArrayBuffer | null> {
  if (!contentEncoding || contentEncoding === 'identity') return body;
  if (contentEncoding === 'gzip') return gunzip(body);
  return null;
}

async function gunzip(body: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  await writer.write(new Uint8Array(body));
  await writer.close();
  return await new Response(ds.readable).arrayBuffer();
}

async function hashWithPrefix(prefix: string, body: ArrayBuffer): Promise<string> {
  const prefixBytes = new TextEncoder().encode(prefix);
  const combined = new Uint8Array(prefixBytes.byteLength + body.byteLength);
  combined.set(prefixBytes, 0);
  combined.set(new Uint8Array(body), prefixBytes.byteLength);
  return hashBody(combined.buffer);
}

function concatChunks(chunks: Uint8Array[], total: number): ArrayBuffer {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

function maybeRecordClone(response: Response, cloneLike: boolean, ctx: UploadPackContext): Response {
  if (cloneLike && response.ok && ctx.recordClone) {
    ctx.ctx.waitUntil(Promise.resolve().then(() => ctx.recordClone!()).catch((err) => {
      console.error('Failed to record clone stat:', err);
    }));
  }
  return response;
}

export function inspectPktLines(body: ArrayBuffer): { command: string | null; hasWant: boolean; hasHave: boolean } {
  const bytes = new Uint8Array(body);
  const decoder = new TextDecoder();
  let offset = 0;
  let command: string | null = null;
  let hasWant = false;
  let hasHave = false;

  while (offset + 4 <= bytes.byteLength) {
    const lenHex = decoder.decode(bytes.subarray(offset, offset + 4));
    const len = parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 0) break;
    offset += 4;

    if (len === 0 || len === 1) continue;
    if (len < 4 || offset + (len - 4) > bytes.byteLength) break;

    const payload = decoder.decode(bytes.subarray(offset, offset + len - 4));
    offset += len - 4;
    const line = payload.replace(/\n$/, '');
    if (!command && line.startsWith('command=')) command = line.slice('command='.length);
    else if (!hasWant && line.startsWith('want ')) hasWant = true;
    else if (!hasHave && line.startsWith('have ')) hasHave = true;
  }

  return { command, hasWant, hasHave };
}

function buildUpstreamHeaders(request: Request, options: UpstreamFetchOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  const contentType = request.headers.get('Content-Type') || 'application/x-git-upload-pack-request';
  headers['Content-Type'] = contentType;

  // Git may gzip protocol v2 request bodies for larger negotiations.
  // Forward the original encoding so the upstream can decode the body.
  const contentEncoding = request.headers.get('Content-Encoding');
  if (contentEncoding) headers['Content-Encoding'] = contentEncoding;

  const userAgent = request.headers.get('User-Agent') || 'git/2.43.0 gitcdn/1.0';
  headers['User-Agent'] = userAgent;

  const protocol = request.headers.get('Git-Protocol');
  if (protocol) headers['Git-Protocol'] = protocol;

  const accept = request.headers.get('Accept');
  if (accept) headers['Accept'] = accept;

  if (options.forceIdentityEncoding) {
    headers['Accept-Encoding'] = 'identity';
  } else {
    const encoding = request.headers.get('Accept-Encoding');
    if (encoding) headers['Accept-Encoding'] = encoding;
  }

  return headers;
}

function passthroughResponse(resp: Response, extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers(resp.headers);
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

function isGitUploadPackContentType(contentType: string | null): boolean {
  return !!contentType && contentType.toLowerCase().startsWith('application/x-git-upload-pack-result');
}
