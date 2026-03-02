/**
 * gitdelivr.net - A Cloudflare Workers-based caching proxy for Git smart HTTP protocol.
 *
 * Read-only. Content-addressable caching via R2.
 * Think "jsDelivr but for git".
 *
 * Cache strategy:
 *   /info/refs         → short TTL (configurable, default 120s) — this is the only mutable data
 *   /git-upload-pack   → CAS keyed on SHA-256 of request body — immutable, cache forever
 *   /archive/*         → keyed on ref string — 24h TTL
 *
 * All write operations (git-receive-pack, push) are rejected with 403.
 */

import { handleInfoRefs } from './refs';
import { handleUploadPack } from './upload-pack';
import { handleArchive } from './archive';
import { handleLfs } from './lfs';
import { resolveOrigin } from './config';
import { Cache } from './cache';
import { renderLandingPage } from './landing';

export interface Env {
  CACHE_BUCKET: R2Bucket;
  /** Comma-separated list of allowed origins, e.g. "gitlab.gnome.org,codeberg.org" */
  ALLOWED_ORIGINS?: string;
  /** TTL in seconds for /info/refs responses (default: 120) */
  REFS_TTL?: string;
  /** Optional: require this token in X-GitCDN-Token header */
  AUTH_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Git-Protocol',
        },
      });
    }

    // Optional auth gate
    if (env.AUTH_TOKEN) {
      const token = request.headers.get('X-GitCDN-Token');
      if (token !== env.AUTH_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    const url = new URL(request.url);
    if (url.host === 'www.gitdelivr.net') {
      url.host = 'gitdelivr.net';
      return Response.redirect(url.toString(), 301);
    }

    const path = url.pathname;

    // Health check
    if (path === '/') {
      return renderLandingPage(url.host);
    }

    if (path === '/health') {
      return Response.json({
        service: 'gitdelivr.net',
        status: 'ok',
        version: '0.1.0',
      });
    }

    // Parse: /:origin/:owner/:repo.git/... or /:origin/:owner/:repo/...
    const parsed = parseGitPath(path);
    if (!parsed) {
      return new Response('Not found. Expected: /<origin-host>/<owner>/<repo>/info/refs', {
        status: 404,
      });
    }

    const { origin, owner, repo, gitPath } = parsed;

    // Validate origin against allowlist
    if (env.ALLOWED_ORIGINS) {
      const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim().toLowerCase());
      if (!allowed.includes(origin.toLowerCase())) {
        return new Response(`Origin "${origin}" is not in the allowed list`, { status: 403 });
      }
    }

    const originUrl = resolveOrigin(origin, owner, repo);
    const cache = new Cache(env.CACHE_BUCKET, origin, owner, repo);
    const refsTtl = parseInt(env.REFS_TTL || '60', 10);

    // ── Block all write operations ──────────────────────────────────────
    if (gitPath === '/git-receive-pack') {
      return new Response('This is a read-only cache. Push operations are not supported.', {
        status: 403,
      });
    }

    // Block receive-pack via service parameter too
    if (gitPath.startsWith('/info/refs') && url.searchParams.get('service') === 'git-receive-pack') {
      return new Response('This is a read-only cache. Push operations are not supported.', {
        status: 403,
      });
    }

    // ── Dumb protocol detection ─────────────────────────────────────────
    // Very old clients (pre-1.6.6, ~2009) request /objects/* or /HEAD directly
    if (gitPath.startsWith('/objects/') || gitPath === '/HEAD') {
      return new Response(
        'Dumb HTTP protocol is not supported. gitdelivr.net requires git 1.6.6+ (smart HTTP).',
        { status: 400 }
      );
    }

    // ── Route ───────────────────────────────────────────────────────────
    try {
      // GET /info/refs?service=git-upload-pack
      if (gitPath.startsWith('/info/refs')) {
        if (request.method !== 'GET') {
          return new Response('Method not allowed', { status: 405 });
        }
        return handleInfoRefs(request, { originUrl, cache, refsTtl, ctx });
      }

      // POST /git-upload-pack (the expensive one — clone/fetch packfiles)
      if (gitPath === '/git-upload-pack') {
        if (request.method !== 'POST') {
          return new Response('Method not allowed', { status: 405 });
        }
        return handleUploadPack(request, { originUrl, cache, ctx });
      }

      // GET /archive/* (tar.gz / zip downloads by ref)
      if (gitPath.startsWith('/-/archive/') || gitPath.startsWith('/archive/')) {
        if (request.method !== 'GET') {
          return new Response('Method not allowed', { status: 405 });
        }
        return handleArchive(request, { originUrl, cache, ctx, gitPath });
      }

      // Git LFS: batch API passthrough, object downloads cached by OID
      if (gitPath.startsWith('/info/lfs/') || gitPath.startsWith('/.git/info/lfs/')) {
        return handleLfs(request, { originUrl, cache, ctx, gitPath });
      }

      return new Response('Not found', { status: 404 });
    } catch (err: any) {
      console.error(`gitdelivr.net error: ${err.message}`, err.stack);
      return new Response(`Internal error: ${err.message}`, { status: 502 });
    }
  },
};

// ── Path parsing ──────────────────────────────────────────────────────────

export interface ParsedPath {
  origin: string; // e.g. "gitlab.gnome.org"
  owner: string; // e.g. "GNOME"
  repo: string; // e.g. "gtk" (stripped of .git)
  gitPath: string; // e.g. "/info/refs" or "/git-upload-pack"
}

const GIT_PATH_MARKERS = ['/info/refs', '/git-upload-pack', '/git-receive-pack', '/-/archive/', '/archive/', '/objects/', '/HEAD', '/info/lfs/'];

export function parseGitPath(path: string): ParsedPath | null {
  // Remove leading slash, split
  const stripped = path.startsWith('/') ? path.slice(1) : path;
  const parts = stripped.split('/');

  if (parts.length < 3) return null;

  const origin = parts[0];
  const owner = parts[1];
  if (!origin || !owner) return null;

  // Find where the git-specific path starts
  // The repo name is everything between owner and the git path marker
  let repoEndIdx = -1;
  let gitPathStart = '';

  for (const marker of GIT_PATH_MARKERS) {
    const markerClean = marker.startsWith('/') ? marker.slice(1) : marker;
    const idx = stripped.indexOf(markerClean, origin.length + owner.length + 2);
    if (idx !== -1 && (repoEndIdx === -1 || idx < repoEndIdx)) {
      repoEndIdx = idx;
      gitPathStart = stripped.slice(idx);
    }
  }

  if (repoEndIdx === -1) return null;

  // Extract repo name (between owner/ and /info/refs or /git-upload-pack etc.)
  const afterOwner = origin.length + 1 + owner.length + 1; // "origin/owner/"
  let repo = stripped.slice(afterOwner, repoEndIdx);
  if (repo.endsWith('/')) repo = repo.slice(0, -1);
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);
  if (!repo) return null;

  // Reconstruct gitPath with query string
  const gitPath = '/' + gitPathStart;
  // The query string is already in the URL, we need to check the raw path
  return { origin, owner, repo, gitPath };
}
