# gitdelivr.net Deployment Guide

## Step 1: Create a Cloudflare account (if you don't have one)

1. Go to https://dash.cloudflare.com/sign-up
2. Sign up with email
3. Go to **Workers & Pages** in the left sidebar
4. Click **Plans** → select **Workers Paid** ($5/month)
   - Free plan works but has 50 subrequest limit (too low for large repos)
   - Paid gives 10,000 subrequests, 30s CPU time, unlimited duration

## Step 2: Install Wrangler CLI

```bash
npm install -g wrangler

# Login (opens browser for OAuth)
wrangler login

# Verify
wrangler whoami
```

## Step 3: Set up the project

```bash
# Create project directory and copy the gitdelivr.net files into it
cd gitdelivr.net
npm install
```

## Step 4: Create the R2 bucket

```bash
wrangler r2 bucket create gitcdn-cache
```

You should see:
```
Created bucket 'gitcdn-cache' with default storage class of Standard.
```

## Step 5: Deploy to workers.dev (instant, no domain needed)

```bash
npx wrangler deploy
```

Output will show something like:
```
Uploaded gitcdn (1.23 sec)
Deployed gitcdn triggers (0.34 sec)
  https://gitdelivr.YOUR-SUBDOMAIN.workers.dev
```

**That URL works immediately.** No DNS, no waiting. Test it:

```bash
# Health check
curl https://gitdelivr.YOUR-SUBDOMAIN.workers.dev/

# Clone a small repo through gitdelivr.net
git clone https://gitdelivr.YOUR-SUBDOMAIN.workers.dev/github.com/tj/commander.js

# Check cache headers
curl -sI "https://gitdelivr.YOUR-SUBDOMAIN.workers.dev/github.com/torvalds/linux.git/info/refs?service=git-upload-pack" | grep -i 'x-gitcdn'
```

## Step 6: Test with the Linux kernel

```bash
# First clone — MISS, streams from origin (passthrough)
time git clone https://gitdelivr.YOUR-SUBDOMAIN.workers.dev/github.com/torvalds/linux /tmp/linux-test1

# Check the header — should say X-GitCDN-Tier: passthrough
# A "pending" marker is now in R2

# Second clone — MISS but fills R2 cache (cache-fill)
time git clone https://gitdelivr.YOUR-SUBDOMAIN.workers.dev/github.com/torvalds/linux /tmp/linux-test2

# Third clone — HIT from R2!
time git clone https://gitdelivr.YOUR-SUBDOMAIN.workers.dev/github.com/torvalds/linux /tmp/linux-test3
```

## Step 7: Set up R2 lifecycle rules (recommended)

1. Go to Cloudflare Dashboard → **R2** → **gitcdn-cache** → **Settings**
2. Under **Object lifecycle rules**, add:

| Rule name | Prefix | Action | Days |
|-----------|--------|--------|------|
| Expire packs | `pack/` | Delete | 30 |
| Expire archives | `archive/` | Delete | 7 |
| Expire refs | `refs/` | Delete | 1 |
| Expire pending markers | `pending/` | Delete | 1 |
| Expire locks | `lock/` | Delete | 1 |

## Step 8: Configure origin allowlist (recommended)

Edit `wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGINS = "github.com,gitlab.gnome.org,codeberg.org"
```

Then redeploy:

```bash
npx wrangler deploy
```

Without this, anyone can use your gitdelivr.net deployment to proxy any Git host.

---

## Adding a custom domain (gitdelivr.net)

You can do this tomorrow — the workers.dev URL works fine for testing
and even for your HN post. When you're ready:

### Step A: Buy the domain

Buy `gitdelivr.net` from any registrar (Cloudflare Registrar is cheapest,
no markup). If buying elsewhere, you'll change nameservers in step B.

### Step B: Add to Cloudflare

1. Dashboard → **Add a site** → enter `gitdelivr.net`
2. Select **Free** plan (the zone plan is separate from Workers plan)
3. Cloudflare gives you two nameservers, e.g.:
   ```
   ella.ns.cloudflare.com
   roger.ns.cloudflare.com
   ```
4. Go to your registrar and change nameservers to these
5. Wait for propagation (usually 5-30 minutes, up to 24h)

### Step C: Add a Custom Domain to the Worker

**Option 1 — Workers Custom Domain (easiest):**

1. Dashboard → **Workers & Pages** → **gitcdn** → **Settings** → **Domains & Routes**
2. Click **Add** → **Custom Domain**
3. Enter `gitdelivr.net`
4. Cloudflare automatically creates the DNS record and SSL cert

**Option 2 — Route-based (via wrangler.toml):**

Uncomment and update the production section in `wrangler.toml`:

```toml
[env.production]
name = "gitcdn"
routes = [
  { pattern = "gitdelivr.net/*", zone_name = "gitdelivr.net" }
]

[env.production.vars]
REFS_TTL = "30"
```

Deploy:
```bash
npx wrangler deploy --env production
```

### Step D: Verify

```bash
# Should work immediately after DNS propagates
curl https://gitdelivr.net/
git clone https://gitdelivr.net/github.com/torvalds/linux
```

### Both URLs work simultaneously

After adding the custom domain, both URLs work:
- `https://gitdelivr.YOUR-SUBDOMAIN.workers.dev/...` (permanent)
- `https://gitdelivr.net/...` (your custom domain)

Same Worker, same R2 bucket, same cache. No migration needed.

---

## Monitoring

### Live logs
```bash
npx wrangler tail
```

### Dashboard metrics
Dashboard → Workers & Pages → gitcdn → Metrics shows:
- Requests/second
- CPU time per request
- Error rate
- Subrequest count

### R2 usage
Dashboard → R2 → gitcdn-cache → Metrics shows:
- Storage used
- Operations (Class A writes, Class B reads)
- Objects stored

---

## Cost estimate after Linux kernel test

After running the three test clones, check your R2 metrics:

- **Storage:** ~3GB (one cached Linux kernel packfile)
- **Class A ops:** ~300 (multipart parts for cache fill)
- **Class B ops:** ~2 (cache hit reads)
- **Workers requests:** 3

Monthly cost if running continuously:
- Workers Paid: $5/month base
- R2 storage: 3GB × $0.015/GB = $0.045
- R2 ops: negligible at test scale

The Workers paid plan base fee dominates until you're doing millions of
requests. At GNOME-scale (50K clones/day), total is still ~$6/month.
