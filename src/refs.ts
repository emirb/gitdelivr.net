/**
 * Handler for GET /<origin>/<owner>/<repo>/info/refs?service=git-upload-pack
 *
 * This is the ref advertisement — the list of branches/tags and their SHAs.
 * It's the only mutable part of the protocol, so we cache with a short TTL.
 *
 * On cache miss or expiry, we fetch from origin and store in R2.
 */

import { Cache } from './cache';
import { originEndpoint } from './config';

interface RefsContext {
  originUrl: string;
  cache: Cache;
  refsTtl: number;
  ctx: ExecutionContext;
}

export async function handleInfoRefs(request: Request, ctx: RefsContext): Promise<Response> {
  const url = new URL(request.url);
  const service = url.searchParams.get('service');

  // Only allow git-upload-pack (read)
  if (service && service !== 'git-upload-pack') {
    return new Response(`Service "${service}" is not supported. Read-only mirror.`, { status: 403 });
  }

  // TTL=0 means pass-through (no caching of refs, maximum freshness)
  if (ctx.refsTtl > 0) {
    const fresh = await ctx.cache.isRefsFresh(ctx.refsTtl);
    if (fresh) {
      const cached = await ctx.cache.getRefs();
      if (cached) {
        if (!isGitRefsContentType(cached.contentType)) {
          ctx.ctx.waitUntil(ctx.cache.deleteRefs().catch(() => {}));
        } else {
        // If served from R2, promote to edge cache for next request from this PoP
          if (cached.tier === 'r2') {
            ctx.ctx.waitUntil(
              ctx.cache.promoteRefsToEdge(cached.body, ctx.refsTtl).catch(() => {})
            );
          }
          return new Response(cached.body, {
            status: 200,
            headers: {
              'Content-Type': cached.contentType,
              'X-GitCDN-Cache': 'HIT',
              'X-GitCDN-Tier': cached.tier,
              'X-GitCDN-Source': cached.tier,
              'X-GitCDN-Edge-Eligible': 'yes',
              'Cache-Control': `public, max-age=${ctx.refsTtl}`,
            },
          });
        }
      }
    }
  }

  // Cache miss — fetch from origin
  const upstreamUrl = originEndpoint(ctx.originUrl, '/info/refs', `service=git-upload-pack`);

  const upstreamResp = await fetch(upstreamUrl, {
    headers: {
      'User-Agent': request.headers.get('User-Agent') || 'git/2.43.0 gitcdn/0.1',
      'Accept': request.headers.get('Accept') || '*/*',
      'Accept-Encoding': request.headers.get('Accept-Encoding') || 'deflate, gzip',
      'Pragma': request.headers.get('Pragma') || 'no-cache',
      'Git-Protocol': request.headers.get('Git-Protocol') || '',
    },
    redirect: 'follow',
  });

  if (!upstreamResp.ok) {
    return new Response(`Upstream error: ${upstreamResp.status} ${upstreamResp.statusText}`, {
      status: upstreamResp.status >= 500 ? 502 : upstreamResp.status,
    });
  }

  // Read full body for caching
  const body = await upstreamResp.arrayBuffer();
  const contentType =
    upstreamResp.headers.get('content-type') || 'application/x-git-upload-pack-advertisement';

  if (!isGitRefsContentType(contentType)) {
    return new Response('Origin returned a non-Git refs response, likely an anti-bot or HTML page.', {
      status: 502,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-GitCDN-Cache': 'BYPASS',
        'X-GitCDN-Tier': 'origin-invalid',
      },
    });
  }

  // Store in R2 (non-blocking), skip if TTL=0 (pass-through mode)
  if (ctx.refsTtl > 0) {
    ctx.ctx.waitUntil(
      ctx.cache.putRefs(body, { 'content-type': contentType }, ctx.refsTtl).catch((err) => {
        console.error('Failed to cache refs:', err);
      })
    );
  }

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'X-GitCDN-Cache': 'MISS',
      'X-GitCDN-Source': 'origin',
      'X-GitCDN-Edge-Eligible': 'yes',
      'Cache-Control': `public, max-age=${ctx.refsTtl}`,
    },
  });
}

function isGitRefsContentType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('application/x-git-upload-pack-advertisement');
}
