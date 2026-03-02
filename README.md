# gitdelivr.net

**CDN for Git smart HTTP, built on Cloudflare Workers, Cache API, and R2.**

gitdelivr.net is a read-only caching proxy for public Git repositories. Put it in front of GitHub, GitLab, Codeberg, Forgejo, or Gitea and repeated clones/fetches get served from Cloudflare instead of hammering the origin. It was inspired by GNOME redirecting Git traffic to GitHub mirrors to cut bandwidth costs, covered by [Phoronix](https://www.phoronix.com/news/GNOME-GitHub-GitLab-Redirect).

It supports:
- smart HTTP clone/fetch caching
- protocol v2 `ls-refs` and `fetch`
- archive caching
- Git LFS batch rewrite plus object caching

## The Problem

Git hosting bandwidth is expensive. When GNOME's GitLab gets hammered by CI systems and developers worldwide, the data transfer costs add up fast — [they started redirecting git traffic to GitHub mirrors](https://www.phoronix.com/news/GNOME-GitHub-GitLab-Redirect) just to save on bandwidth.

There's a jsDelivr for npm packages, a CDN for Docker images, but nothing for Git. gitdelivr.net fixes this at the protocol level. No mirrors needed.

## How It Works

```
Developer            gitdelivr.net               Origin forge
   |                      |                           |
   | git clone            |                           |
   |--------------------->|                           |
   |                      | GET /info/refs           |
   |                      |-------------------------->| short TTL, refreshed on miss
   |                      |<--------------------------|
   |                      |                           |
   |                      | POST /git-upload-pack    |
   |                      | hash request body        |
   |                      | check edge / R2          |
   | packfile on HIT <----|                           |
   |                      |-------------------------->| MISS streams from origin
   |                      |                           |
```

### Key Insight

Git's upload-pack protocol is deterministic: the same wants and haves produce the same packfile. For fresh `git clone`, many clients send effectively identical requests, so one cached pack can serve repeated clones until refs move.

The request flow is:

1. `/info/refs` and protocol v2 `ls-refs` are cached briefly because refs are the only mutable part.
2. `/git-upload-pack` requests are keyed by a hash of the effective request body.
3. On a hit, the pack is served from Cloudflare edge or R2 without touching origin.
4. On a miss, the response streams from origin, and eligible responses are filled into cache for later requests.

### Cache Strategy

| Endpoint | Cache Key | TTL | Why |
|---|---|---|---|
| `/info/refs` | `refs/<origin>/<repo>` | 120s (configurable) | Only mutable data — branch/tag pointers |
| protocol v2 `ls-refs` | `v2/<origin>/<repo>/<sha256(body)>` | 60s | Mutable metadata, short-lived |
| `/git-upload-pack` | `pack/<sha256(normalized request)>` | Immutable (forever) | Same wants+haves = same packfile |
| `/archive/*` | `archive/<origin>/<repo>/<ref>` | 24h | Cached by ref name; tags are effectively immutable |
| LFS objects | `lfs/<origin>/<repo>/<oid>` | Immutable (forever) | OID is already SHA-256 of content |

## Streaming Architecture

gitdelivr.net handles multi-GB repos (like the Linux kernel) without buffering:

**Small repos (<50MB):** Buffer in memory, cache with a single R2 `put()`.

**Large known-length packs:** the first eligible request can become the cache-filler immediately. Concurrent followers wait briefly for the fill, then either hit cache or passthrough without stalling the client.

**Large chunked packs:** the worker coordinates a cache-fill path without buffering the full response in memory.

**Archives and LFS objects:** small responses buffer into R2; larger known-length responses stream to the client while multipart-uploading to R2.

This avoids `ReadableStream.tee()` which [crashes at ~128MB in Workers](https://github.com/honojs/hono/issues/3612).

## Quick Start

### Prerequisites

- A Cloudflare account (free plan works, paid plan recommended)
- Node.js ≥ 18
- Wrangler CLI (`npm install -g wrangler`)

### Deploy

```bash
# Clone
git clone https://github.com/emirb/gitdelivr.net
cd gitdelivr.net

# Install dependencies
npm install

# Login to Cloudflare
npx wrangler login

# Create the R2 bucket
npx wrangler r2 bucket create gitcdn-cache

# Deploy (gets a *.workers.dev URL immediately)
npm run deploy
```

That's it. You'll get a URL like `https://gitdelivr.<your-account>.workers.dev`.

### Test It

```bash
# Clone through gitdelivr.net
git clone https://gitdelivr.<your-account>.workers.dev/github.com/torvalds/linux

# Second clone of the same repo often fills or hits cache depending on request shape
git clone https://gitdelivr.<your-account>.workers.dev/github.com/torvalds/linux /tmp/linux2

# Third clone should be served from cache
git clone https://gitdelivr.<your-account>.workers.dev/github.com/torvalds/linux /tmp/linux3

# Check cache headers
curl -sI "https://gitdelivr.<your-account>.workers.dev/github.com/torvalds/linux.git/info/refs?service=git-upload-pack" | grep X-GitCDN

```

### Add a Custom Domain (optional)

```bash
# 1. Buy a domain (e.g., gitdelivr.net)
# 2. Add it to your Cloudflare account (change nameservers)
# 3. Deploy the configured production custom domains:
npm run deploy -- --env production
```

## URL Scheme

```
https://<your-gitdelivr-domain>/<origin-host>/<owner>/<repo>[.git]/<git-endpoint>
```

Examples:
```bash
# Clone from any forge
git clone https://gitdelivr.net/gitlab.gnome.org/GNOME/gtk
git clone https://gitdelivr.net/codeberg.org/forgejo/forgejo
git clone https://gitdelivr.net/github.com/torvalds/linux
git clone https://gitdelivr.net/git.mycompany.com/team/project

# Download archive
curl -LO https://gitdelivr.net/gitlab.gnome.org/GNOME/gtk/-/archive/main.tar.gz

# Client-side config (redirect all clones for a forge through gitdelivr.net)
git config --global url."https://gitdelivr.net/gitlab.gnome.org/".insteadOf "https://gitlab.gnome.org/"
```

## Architecture

```
src/
├── index.ts          # Request router, path parsing, read-only enforcement
├── refs.ts           # /info/refs — short-TTL edge + R2 cache
├── upload-pack.ts    # /git-upload-pack — CAS packfile caching (the big win)
├── archive.ts        # Archive downloads — ref-based caching
├── lfs.ts            # Git LFS — batch API passthrough + object caching by OID
├── cache.ts          # Two-tier storage: CF Cache API (edge) → R2 (durable)
└── config.ts         # Origin URL resolution
```

### Two-Tier Caching

```
Tier 1: Cloudflare Cache API — edge-local, 300+ PoPs, <10ms TTFB
Tier 2: R2 — single region, durable, $0 egress, 100-300ms TTFB
```

gitdelivr.net uses R2 Local Uploads for cache-fill writes, which reduces write latency from globally distributed Workers into the bucket. Popular packs can then be promoted into edge cache for low-latency repeat clones.

### Read-Only Enforcement

All write operations are rejected at the router level: `git push` → 403, `git-receive-pack` → 403. This is a read-only cache, not a mirror. Your origin remains the single source of truth.

## Response Headers

| Header | Values | Meaning |
|---|---|---|
| `X-GitCDN-Cache` | `HIT`, `MISS`, `NEGOTIATION`, `BYPASS`, `LFS-BATCH-REWRITE` | Cache status |
| `X-GitCDN-Tier` | `edge`, `r2`, `buffer`, `passthrough`, `cache-fill`, `chunked`, `cache-fill-chunked`, `contended`, `v2-edge`, `v2-ls-refs`, `waited-edge`, `waited-r2` | Which path handled the request |
| `X-GitCDN-Hash` | `<12-char hex>` | CAS key prefix (for debugging) |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_ORIGINS` | *(empty = allow all)* | Comma-separated list of allowed origin hostnames |
| `REFS_TTL` | `120` | Seconds to cache `/info/refs`. Set to `0` for always-fresh refs |
| `AUTH_TOKEN` | *(empty)* | Require this token in `X-GitCDN-Token` header |

### R2 Lifecycle Rules (recommended for production)

Set these in the Cloudflare dashboard under R2 → gitcdn-cache → Settings → Lifecycle:

```
Prefix: pack/      → Expire after 30 days
Prefix: archive/   → Expire after 7 days
Prefix: refs/      → Expire after 1 day
Prefix: pending/   → Expire after 1 day
Prefix: lock/      → Expire after 1 day
```

## Cost

| Scale | Clones/day | Monthly cost |
|---|---|---|
| Small OSS project | 1,000 | ~$5 (Workers paid plan base) |
| GNOME-scale | 50,000 | ~$6 |
| Heavy traffic | 500,000 | ~$26 |
| Massive | 5,000,000 | ~$140 |

R2 egress is $0. The entire economic thesis is that Cloudflare doesn't charge for bandwidth out of R2, while GitHub/GitLab/AWS pay $0.08-0.12/GB.

## Observability

Workers observability logs are enabled in `wrangler.toml`, and the worker exposes:
- `/health`

## CI

`.github/workflows/ci.yml` runs typechecking and unit tests with coverage on GitHub Actions.

## Limitations

- **Read-only**: No push support (by design)
- **Smart HTTP only**: SSH protocol not supported (can't proxy at the edge)
- **Public repos only**: no auth passthrough
- **Edge cache limit**: Objects > 512MB served from R2 (not edge), adding 100-300ms TTFB
- **Cache fill**: Second clone of a large repo is slightly slower (inline R2 write)

## License

MIT

---

*Built because GNOME shouldn't have to redirect to GitHub just to save on bandwidth.*
