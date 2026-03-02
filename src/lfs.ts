/**
 * Git LFS handler with full caching.
 *
 * Two mechanisms:
 *
 * 1. BATCH API INTERCEPTION (POST /info/lfs/objects/batch)
 *    The batch API returns download hrefs pointing to the forge's storage
 *    (e.g. GitHub S3 presigned URLs). We intercept the response and rewrite
 *    these hrefs to point through gitdelivr.net. This way the LFS client downloads
 *    objects through us and we can cache them.
 *
 *    Original:  "href": "https://github-cloud.s3.amazonaws.com/..."
 *    Rewritten: "href": "https://gitdelivr.net/<origin>/<owner>/<repo>/info/lfs/objects/<oid>"
 *
 *    For objects already cached in R2, we omit the actions entirely — the
 *    LFS spec says servers should omit actions for objects they already have.
 *    Wait, that's for uploads. For downloads, we rewrite to point to us.
 *
 * 2. DIRECT OID DOWNLOAD (GET /info/lfs/objects/<oid>)
 *    When the LFS client follows the rewritten href, we serve from R2 cache
 *    or fetch from the ORIGINAL href (stored in R2 metadata) and cache.
 */

import { Cache } from './cache';
import { originEndpoint } from './config';

interface LfsContext { originUrl: string; cache: Cache; ctx: ExecutionContext; gitPath: string; }

const LFS_BUFFER_THRESHOLD = 16 * 1024 * 1024;
const PART_SIZE = 10 * 1024 * 1024;
const MULTIPART_MAX_INFLIGHT = 2;

export async function handleLfs(request: Request, ctx: LfsContext): Promise<Response> {
  // Direct OID download: GET /info/lfs/objects/<oid>
  const oidMatch = ctx.gitPath.match(/\/info\/lfs\/objects\/([a-f0-9]{64})$/);
  if (oidMatch && request.method === 'GET') {
    return handleLfsDownload(request, ctx, oidMatch[1]!);
  }

  // Batch API: POST /info/lfs/objects/batch
  if (ctx.gitPath.endsWith('/info/lfs/objects/batch') && request.method === 'POST') {
    return handleLfsBatch(request, ctx);
  }

  // Everything else: passthrough
  return handleLfsPassthrough(request, ctx);
}

/**
 * Intercept the batch API response and rewrite download hrefs.
 */
async function handleLfsBatch(request: Request, ctx: LfsContext): Promise<Response> {
  // Forward to origin
  const upstreamUrl = ctx.originUrl + ctx.gitPath;

  const upResp = await fetch(upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': request.headers.get('Content-Type') || 'application/vnd.git-lfs+json',
      'Accept': 'application/vnd.git-lfs+json',
      'User-Agent': 'git-lfs/3.4.0 gitdelivr.net/1.0',
      'Authorization': request.headers.get('Authorization') || '',
    },
    body: request.body,
  });

  if (!upResp.ok) {
    return new Response(upResp.body, { status: upResp.status, headers: { 'Content-Type': 'application/vnd.git-lfs+json' } });
  }

  // Parse the batch response
  let batchResp: any;
  try {
    batchResp = await upResp.json();
  } catch {
    return new Response('Failed to parse LFS batch response', { status: 502 });
  }

  if (!batchResp.objects || !Array.isArray(batchResp.objects)) {
    return Response.json(batchResp, { status: 200, headers: { 'Content-Type': 'application/vnd.git-lfs+json' } });
  }

  // Build our base URL from the request
  const reqUrl = new URL(request.url);
  const pathParts = reqUrl.pathname.split('/info/lfs/')[0]; // e.g. /github.com/owner/repo
  const baseUrl = `${reqUrl.origin}${pathParts}`;

  // Always rewrite download hrefs through gitdelivr.net. The download path checks
  // cache first, which avoids an extra R2 HEAD for every object in the batch.
  for (const obj of batchResp.objects) {
    if (!obj.oid || !obj.actions?.download?.href) continue;
    const gitcdnHref = `${baseUrl}/info/lfs/objects/${obj.oid}`;
    const originalHref = obj.actions.download.href;
    const originalHeaders = obj.actions.download.header || {};

    obj.actions.download = {
      href: `${gitcdnHref}?_origin_href=${encodeURIComponent(originalHref)}&_origin_headers=${encodeURIComponent(JSON.stringify(originalHeaders))}`,
      authenticated: true,
    };
  }

  return Response.json(batchResp, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.git-lfs+json',
      'X-GitCDN-Cache': 'LFS-BATCH-REWRITE',
    },
  });
}

/**
 * Direct LFS object download with caching.
 */
async function handleLfsDownload(request: Request, ctx: LfsContext, oid: string): Promise<Response> {
  // Check cache first
  const cached = await ctx.cache.getLfsObject(oid);
  if (cached) {
    return new Response(cached.body, {
      status: 200,
      headers: lfsH('HIT', cached.tier, oid, cached.size),
    });
  }

  // Cache miss — we need the origin href
  // It's either in the query params (from batch rewrite) or we construct it
  const url = new URL(request.url);
  let originHref = url.searchParams.get('_origin_href');
  let originHeaders: Record<string, string> = {};

  if (url.searchParams.get('_origin_headers')) {
    try { originHeaders = JSON.parse(url.searchParams.get('_origin_headers')!); } catch {}
  }

  if (!originHref) {
    // No origin href — try fetching from the forge's LFS endpoint directly
    originHref = `${ctx.originUrl}/info/lfs/objects/${oid}`;
  }

  // Fetch from origin
  const upResp = await fetch(originHref, {
    headers: {
      ...originHeaders,
      'User-Agent': 'git-lfs/3.4.0 gitdelivr.net/1.0',
      'Accept': 'application/octet-stream',
    },
    redirect: 'follow',
  });

  if (!upResp.ok) {
    return new Response(`LFS upstream error: ${upResp.status}`, { status: upResp.status >= 500 ? 502 : upResp.status });
  }

  const cl = parseInt(upResp.headers.get('content-length') || '0', 10);

  // Small object: buffer + cache
  if (cl > 0 && cl < LFS_BUFFER_THRESHOLD) {
    const body = await upResp.arrayBuffer();
    ctx.ctx.waitUntil(ctx.cache.putLfsObject(oid, body).catch(() => {}));
    return new Response(body, { status: 200, headers: lfsH('MISS', 'buffer', oid, body.byteLength) });
  }

  // Large object: stream to client, cache with TransformStream inline
  if (!upResp.body) return new Response('Empty LFS response', { status: 502 });

  if (cl > 0 && cl <= 2 * 1024 * 1024 * 1024) {
    // Use the same inline caching pattern as upload-pack
    const { readable, writable } = new TransformStream();
    const cacheWriter = new LfsMultipartWriter(ctx.cache, oid);

    const pump = pumpLfsWithCaching(upResp.body.getReader(), writable.getWriter(), cacheWriter);
    ctx.ctx.waitUntil(pump.catch(() => {}));

    return new Response(readable, { status: 200, headers: lfsH('MISS', 'cache-fill', oid, cl) });
  }

  // Too large or unknown: passthrough
  return new Response(upResp.body, { status: 200, headers: lfsH('MISS', 'passthrough', oid, cl) });
}

async function pumpLfsWithCaching(reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array>, cw: LfsMultipartWriter): Promise<void> {
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
  }
}

class LfsMultipartWriter {
  private cache: Cache; private oid: string;
  private upload: R2MultipartUpload | null = null;
  private parts: { partNumber: number; etag: string }[] = [];
  private inflight: Promise<void>[] = [];
  private pn = 1; private buf = new Uint8Array(PART_SIZE); private off = 0;

  constructor(cache: Cache, oid: string) { this.cache = cache; this.oid = oid; }
  async begin() { this.upload = await this.cache.createMultipartLfs(this.oid); }

  async write(chunk: Uint8Array) {
    if (!this.upload) throw new Error('Not started');
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

  private async drainOne(): Promise<void> {
    const next = this.inflight.shift();
    if (next) await next;
  }
}

async function handleLfsPassthrough(request: Request, ctx: LfsContext): Promise<Response> {
  const upResp = await fetch(ctx.originUrl + ctx.gitPath, {
    method: request.method,
    headers: { 'User-Agent': 'git-lfs/3.4.0 gitdelivr.net/1.0', 'Accept': request.headers.get('Accept') || 'application/vnd.git-lfs+json', 'Content-Type': request.headers.get('Content-Type') || '', 'Authorization': request.headers.get('Authorization') || '' },
    body: ['POST', 'PUT', 'PATCH'].includes(request.method) ? request.body : undefined,
    redirect: 'follow',
  });
  return new Response(upResp.body, { status: upResp.status, headers: { 'Content-Type': upResp.headers.get('Content-Type') || 'application/vnd.git-lfs+json', 'X-GitCDN-Cache': 'PASSTHROUGH' } });
}

function lfsH(cache: string, tier: string, oid: string, size?: number): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-GitCDN-Cache': cache,
    'X-GitCDN-Tier': tier,
    'X-GitCDN-Source': lfsSourceForTier(tier),
    'X-GitCDN-Edge-Eligible': lfsEdgeEligibility(tier, size),
    'X-GitCDN-LFS-OID': oid.slice(0, 12),
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
  if (size) h['Content-Length'] = String(size);
  return h;
}

function lfsSourceForTier(tier: string): string {
  if (tier.includes('edge')) return 'edge';
  if (tier.includes('r2')) return 'r2';
  return 'origin';
}

function lfsEdgeEligibility(tier: string, size?: number): string {
  if (tier === 'passthrough') return 'unknown';
  if (size !== undefined && size > 500 * 1024 * 1024) return 'no';
  return 'yes';
}
