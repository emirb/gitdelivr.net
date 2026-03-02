/**
 * Handler for GET /<origin>/<owner>/<repo>/-/archive/<ref>.<ext>
 *
 * Archive downloads (tar.gz, zip) are common for CI and release downloads.
 * They're keyed by ref name — for tags this is effectively immutable,
 * for branches we cache with a moderate TTL.
 */

import { Cache } from './cache';
import { originEndpoint } from './config';

interface ArchiveContext {
  originUrl: string;
  cache: Cache;
  ctx: ExecutionContext;
  gitPath: string;
}

/** Max archive size to cache (1 GB) */
const MAX_ARCHIVE_SIZE = 1024 * 1024 * 1024;
const ARCHIVE_BUFFER_THRESHOLD = 16 * 1024 * 1024;
const ARCHIVE_EDGE_PROMOTE_MAX = 500 * 1024 * 1024;
const PART_SIZE = 10 * 1024 * 1024;
const MULTIPART_MAX_INFLIGHT = 2;

export async function handleArchive(request: Request, ctx: ArchiveContext): Promise<Response> {
  // Parse ref and extension from path
  // Patterns:
  //   /-/archive/<ref>.tar.gz
  //   /-/archive/<ref>.zip
  //   /archive/<ref>.tar.gz
  const parsed = parseArchivePath(ctx.gitPath);
  if (!parsed) {
    return new Response('Invalid archive path. Expected /-/archive/<ref>.<ext>', { status: 400 });
  }

  const { ref, ext } = parsed;

  // ── Check cache ─────────────────────────────────────────────────────
  const cached = await ctx.cache.getArchive(ref, ext);
  if (cached) {
    return new Response(cached.body, {
      status: 200,
      headers: {
        'Content-Length': String(cached.size),
        'Content-Type': archiveContentType(ext),
        'Content-Disposition': `attachment; filename="${ref}.${ext}"`,
        'X-GitCDN-Cache': 'HIT',
        'X-GitCDN-Tier': cached.tier,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  // ── Cache miss — fetch from origin ──────────────────────────────────
  // Different forges use different URL patterns:
  //   GitLab: /-/archive/<ref>.tar.gz
  //   GitHub: /archive/refs/tags/<ref>.tar.gz or /archive/<ref>.tar.gz
  //   Gitea:  /archive/<ref>.tar.gz
  // We try the path as-is first.
  const upstreamUrl = originEndpoint(ctx.originUrl.replace(/\.git$/, ''), ctx.gitPath);

  const upstreamResp = await fetch(upstreamUrl, {
    headers: {
      'User-Agent': 'git/2.43.0 gitcdn/0.1',
    },
    redirect: 'follow',
  });

  if (!upstreamResp.ok) {
    return new Response(`Upstream error: ${upstreamResp.status}`, {
      status: upstreamResp.status >= 500 ? 502 : upstreamResp.status,
    });
  }

  const cl = parseInt(upstreamResp.headers.get('content-length') || '0', 10);

  if (cl > 0 && cl <= ARCHIVE_BUFFER_THRESHOLD) {
    const body = await upstreamResp.arrayBuffer();
    ctx.ctx.waitUntil(ctx.cache.putArchive(ref, ext, body).catch((err) => {
      console.error('Failed to cache archive:', err);
    }));
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Length': String(body.byteLength),
        'Content-Type': upstreamResp.headers.get('content-type') || archiveContentType(ext),
        'Content-Disposition': `attachment; filename="${ref}.${ext}"`,
        'X-GitCDN-Cache': 'MISS',
        'X-GitCDN-Tier': 'buffer',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  if (!upstreamResp.body) return new Response('Empty archive response', { status: 502 });

  if (cl > 0 && cl <= MAX_ARCHIVE_SIZE) {
    const { readable, writable } = new TransformStream();
    const cacheWriter = new ArchiveMultipartWriter(ctx.cache, ref, ext);
    const pump = pumpArchiveWithCaching(upstreamResp.body.getReader(), writable.getWriter(), cacheWriter, ref, ext, ctx);
    ctx.ctx.waitUntil(pump.catch(() => {}));

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Length': String(cl),
        'Content-Type': upstreamResp.headers.get('content-type') || archiveContentType(ext),
        'Content-Disposition': `attachment; filename="${ref}.${ext}"`,
        'X-GitCDN-Cache': 'MISS',
        'X-GitCDN-Tier': 'cache-fill',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  return new Response(upstreamResp.body, {
    status: 200,
    headers: {
      ...(cl > 0 ? { 'Content-Length': String(cl) } : {}),
      'Content-Type': upstreamResp.headers.get('content-type') || archiveContentType(ext),
      'Content-Disposition': `attachment; filename="${ref}.${ext}"`,
      'X-GitCDN-Cache': 'MISS',
      'X-GitCDN-Tier': 'passthrough',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

// ── Path parsing ──────────────────────────────────────────────────────────

export function parseArchivePath(gitPath: string): { ref: string; ext: string } | null {
  // Match patterns like:
  //   /-/archive/v1.0.0.tar.gz
  //   /archive/main.zip
  //   /-/archive/refs/tags/v2.0.tar.gz
  const match = gitPath.match(/\/(?:-\/)?archive\/(.+)\.(tar\.gz|tar\.bz2|zip|tar)$/);
  if (!match) return null;

  return {
    ref: match[1]!,
    ext: match[2]!,
  };
}

export function archiveContentType(ext: string): string {
  return ({
    'tar.gz': 'application/gzip',
    zip: 'application/zip',
    tar: 'application/x-tar',
    'tar.bz2': 'application/x-bzip2',
  } as Record<string, string>)[ext] || 'application/octet-stream';
}

async function pumpArchiveWithCaching(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  cacheWriter: ArchiveMultipartWriter,
  ref: string,
  ext: string,
  ctx: ArchiveContext
): Promise<void> {
  let ok = true;
  try {
    await cacheWriter.begin();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
      if (ok) {
        try {
          await cacheWriter.write(value);
        } catch {
          ok = false;
          try { await cacheWriter.abort(); } catch {}
        }
      }
    }
    await writer.close();
    if (ok) {
      await cacheWriter.complete();
      if (cacheWriter.bytesWritten <= ARCHIVE_EDGE_PROMOTE_MAX) {
        await ctx.cache.promoteArchiveToEdge(ref, ext, cacheWriter.bytesWritten).catch(() => {});
      }
    }
  } catch (e) {
    try { await writer.abort(e); } catch {}
    try { await cacheWriter.abort(); } catch {}
  }
}

class ArchiveMultipartWriter {
  private cache: Cache;
  private ref: string;
  private ext: string;
  private upload: R2MultipartUpload | null = null;
  private parts: { partNumber: number; etag: string }[] = [];
  private inflight: Promise<void>[] = [];
  private pn = 1;
  private buf = new Uint8Array(PART_SIZE);
  private off = 0;
  private totalWritten = 0;

  constructor(cache: Cache, ref: string, ext: string) {
    this.cache = cache;
    this.ref = ref;
    this.ext = ext;
  }

  async begin() {
    this.upload = await this.cache.createMultipartArchive(this.ref, this.ext);
  }

  async write(chunk: Uint8Array) {
    if (!this.upload) throw new Error('Not started');
    this.totalWritten += chunk.byteLength;
    let p = 0;
    while (p < chunk.byteLength) {
      const n = Math.min(PART_SIZE - this.off, chunk.byteLength - p);
      this.buf.set(chunk.subarray(p, p + n), this.off);
      this.off += n;
      p += n;
      if (this.off === PART_SIZE) await this.flush();
    }
  }

  async complete() {
    if (!this.upload) return;
    if (this.off > 0) await this.flush();
    await Promise.all(this.inflight);
    this.parts.sort((a, b) => a.partNumber - b.partNumber);
    this.parts.length > 0 ? await this.upload.complete(this.parts) : await this.upload.abort();
  }

  async abort() {
    try { await this.upload?.abort(); } catch {}
  }

  get bytesWritten(): number {
    return this.totalWritten;
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
      const next = this.inflight.shift();
      if (next) await next;
    }
  }
}
