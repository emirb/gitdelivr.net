export function renderLandingPage(_host: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GitDelivr - CDN for Git</title>
<meta name="description" content="Like jsDelivr, but for git repositories. Cache git clones at Cloudflare's edge.">
<meta property="og:title" content="GitDelivr - CDN for Git">
<meta property="og:description" content="Cache git clone/fetch at Cloudflare's 300+ edge locations. Drop-in proxy for any public forge.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://gitdelivr.net">
<style>
*{margin:0;padding:0;box-sizing:border-box}

:root{
  --bg:#090b10;
  --bg2:#0f1218;
  --bg3:#161b24;
  --fg:#d4dbe5;
  --fg2:#a3afc2;
  --accent:#22c55e;
  --accent2:#16a34a;
  --accent-dim:rgba(34,197,94,.1);
  --blue:#8ab4ff;
  --border:#1e2532;
  --font:ui-monospace,SFMono-Regular,SF Mono,Menlo,Consolas,Liberation Mono,monospace;
  --max:720px;
}

html{font-size:16px;-webkit-text-size-adjust:100%}

body{
  background:var(--bg);
  color:var(--fg);
  font-family:var(--font);
  line-height:1.65;
  -webkit-font-smoothing:antialiased;
  overflow-x:hidden;
}

.w{
  max-width:var(--max);
  margin:0 auto;
  padding:0 20px;
}

header{
  padding:clamp(40px,10vw,80px) 0 clamp(24px,6vw,48px);
}

.tag{
  display:inline-block;
  font-size:10px;
  font-weight:500;
  letter-spacing:.1em;
  text-transform:uppercase;
  color:var(--accent);
  border:1px solid var(--accent2);
  border-radius:3px;
  padding:3px 10px;
  margin-bottom:20px;
  opacity:0;animation:fi .5s ease forwards;
}

h1{
  font-size:clamp(28px,7vw,48px);
  font-weight:600;
  letter-spacing:-.03em;
  line-height:1.1;
  margin-bottom:14px;
  opacity:0;animation:fi .5s ease .08s forwards;
}
h1 em{font-style:normal;color:var(--accent)}

.lead{
  font-size:clamp(14px,3.2vw,16px);
  color:var(--fg2);
  line-height:1.6;
  max-width:540px;
  opacity:0;animation:fi .5s ease .16s forwards;
}

.lead a{color:var(--blue);text-decoration:none}
.lead a:hover{text-decoration:underline}
.lead a:focus-visible,footer a:focus-visible,.cmd:focus-visible{
  outline:2px solid var(--blue);
  outline-offset:2px;
}

.term{
  background:var(--bg2);
  border:1px solid var(--border);
  border-radius:6px;
  margin:clamp(24px,5vw,40px) 0 clamp(32px,6vw,56px);
  overflow:hidden;
  opacity:0;animation:fi .5s ease .24s forwards;
}

.term-bar{
  display:flex;gap:6px;
  padding:10px 14px;
  background:var(--bg3);
  border-bottom:1px solid var(--border);
}
.dot{width:9px;height:9px;border-radius:50%;opacity:.5}
.dot:nth-child(1){background:#f87171}
.dot:nth-child(2){background:#fbbf24}
.dot:nth-child(3){background:#4ade80}

.term pre{
  padding:clamp(14px,3vw,20px);
  font-size:clamp(11.5px,2.6vw,13px);
  line-height:1.9;
  overflow-x:auto;
  -webkit-overflow-scrolling:touch;
  white-space:pre;
  color:var(--fg);
}
.term .c{color:var(--fg2)}
.term .p{color:var(--accent)}
.term .u{color:var(--blue)}

.stats{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:1px;
  background:var(--border);
  border:1px solid var(--border);
  border-radius:6px;
  overflow:hidden;
  margin-bottom:clamp(40px,8vw,64px);
}
.stat{background:var(--bg2);padding:clamp(16px,4vw,24px) 12px;text-align:center}
.stat b{display:block;font-size:clamp(20px,5vw,28px);font-weight:600;color:var(--accent);line-height:1;margin-bottom:4px}
.stat span{font-size:clamp(10px,2.3vw,12px);color:var(--fg2);text-transform:uppercase;letter-spacing:.06em}

section{margin-bottom:clamp(40px,8vw,64px)}

h2{
  font-size:11px;
  font-weight:500;
  letter-spacing:.1em;
  text-transform:uppercase;
  color:var(--fg2);
  padding-bottom:12px;
  margin-bottom:20px;
  border-bottom:1px solid var(--border);
}

.step{
  padding:16px 0;
  border-bottom:1px solid var(--border);
  display:flex;
  gap:14px;
}
.step:last-child{border-bottom:none}
.step .n{
  font-size:11px;
  color:var(--accent2);
  min-width:20px;
  padding-top:3px;
  flex-shrink:0;
}
.step strong{display:block;font-size:14px;font-weight:500;color:var(--fg);margin-bottom:2px}
.step p{font-size:13px;color:var(--fg2);line-height:1.55}

.trust{
  background:var(--bg2);
  border:1px solid var(--border);
  border-radius:6px;
  padding:clamp(18px,4vw,28px);
  font-size:clamp(12.5px,2.8vw,14px);
  color:var(--fg2);
  line-height:1.7;
}
.trust strong{color:var(--fg);font-weight:500}
.trust code{
  font-size:.9em;
  background:var(--bg);
  padding:1px 5px;
  border-radius:3px;
  color:var(--accent);
}

.try{
  background:var(--bg2);
  border:1px solid var(--border);
  border-radius:6px;
  padding:clamp(18px,4vw,28px);
  margin-bottom:clamp(40px,8vw,64px);
}
.try h3{font-size:15px;font-weight:500;margin-bottom:6px}
.try>p{font-size:13px;color:var(--fg2);margin-bottom:16px}

.cmd{
  width:100%;
  font-size:clamp(11px,2.5vw,13px);
  background:var(--bg);
  border:1px solid var(--border);
  border-radius:4px;
  padding:12px 14px;
  display:block;
  overflow-x:auto;
  -webkit-overflow-scrolling:touch;
  white-space:nowrap;
  color:var(--fg);
  cursor:pointer;
  transition:border-color .15s;
  position:relative;
  text-align:left;
  font-family:inherit;
}
.cmd:hover{border-color:var(--accent2)}
.cmd::after{
  content:'copy';
  position:absolute;
  right:10px;
  top:50%;transform:translateY(-50%);
  font-size:10px;
  color:var(--fg2);
  pointer-events:none;
}

footer{
  padding:clamp(24px,5vw,40px) 0 clamp(32px,6vw,48px);
  text-align:center;
  font-size:12px;
  color:var(--fg2);
  border-top:1px solid var(--border);
}
footer a{color:var(--blue);text-decoration:none}
footer a:hover{text-decoration:underline}

@keyframes fi{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}

@media(max-width:480px){
  .stats{grid-template-columns:repeat(3,1fr)}
  .stat{padding:14px 6px}
  .step{flex-direction:column;gap:4px}
  .step .n{min-width:auto}
  .cmd::after{display:none}
}
</style>
</head>
<body>
<main class="w">
<header>
  <h1>CDN for <em>Git</em></h1>
  <p class="lead">GNOME had to <a href="https://www.phoronix.com/news/GNOME-GitHub-GitLab-Redirect">redirect git traffic to GitHub</a> just to save on bandwidth. There's a jsDelivr for npm, but nothing for git. Why pay egress costs in 2026?</p>
</header>

<div class="term">
  <div class="term-bar"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
<pre><span class="c"># prefix any public repo URL with gitdelivr.net</span>
<span class="p">$</span> git clone <span class="u">https://gitdelivr.net/gitlab.gnome.org/GNOME/gtk</span>
<span class="p">$</span> git clone <span class="u">https://gitdelivr.net/codeberg.org/forgejo/forgejo</span>
<span class="c"># first clone: passes through to origin at full speed</span>
<span class="c"># every clone after: served from edge</span>
</pre><pre>
<span class="c"># Clone even faster than from GitHub. Try Linux Kernel itself:</span>
<span class="p">$</span> git clone --depth=1 <span class="u">https://gitdelivr.net/github.com/torvalds/linux</span>
</pre>
</div>

<div class="stats">
  <div class="stat"><b>&lt;20ms</b><span>Edge TTFB</span></div>
  <div class="stat"><b>300+</b><span>PoPs</span></div>
  <div class="stat"><b>Free!</b><span>yes, free!</span></div>
</div>

<section>
  <h2>How it works</h2>
  <div class="step"><div class="n">01</div><div><strong>Git is content-addressable</strong><p>Same clone request returns same packfile. Simply SHA-256 the request, cache the response in Cloudflare R2.</p></div></div>
  <div class="step"><div class="n">02</div><div><strong>First clone passes through</strong><p>Full speed to the client from Cloudflare Workers. Cache is filled on the next request.</p></div></div>
  <div class="step"><div class="n">03</div><div><strong>Every clone after is cached</strong><p>Served from Cloudflare edge closest to you. Origin is not touched until someone pushes.</p></div></div>
  <div class="step"><div class="n">04</div><div><strong>Refs stay fresh</strong><p>Branch pointers are cached with a 60s TTL. Pushes are visible within a minute.</p></div></div>
</section>

<section>
  <h2>Security</h2>
  <div class="trust"><strong>You don't have to trust us.</strong> Git itself verifies every object by hash on the client side. If we flip a byte, <code>git fsck</code> rejects the entire pack. We're doing this to help open source projects who don't want to (or can't) use GitHub or Gitlab.</div>
</section>

<div class="try">
  <h3>Try it</h3>
  <p>Prefix any public git URL with this domain.</p>
  <button type="button" class="cmd" data-copy="git clone https://gitdelivr.net/github.com/torvalds/linux" aria-label="Copy clone command">git clone https://gitdelivr.net/github.com/torvalds/linux</button>
</div>
</main>
<div class="w">
<footer>
  <a href="https://github.com/emirb/gitdelivr">Source</a> · Built on Cloudflare Workers + R2 · <a href="https://www.phoronix.com/news/GNOME-GitHub-GitLab-Redirect">Inspired by GNOME</a>
</footer>
</div>
<script>document.querySelectorAll("[data-copy]").forEach(e=>e.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(e.dataset.copy||"");e.dataset.label=e.textContent||"";e.textContent="Copied";setTimeout(()=>{e.textContent=e.dataset.label||""},1200)}catch{}}))</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
