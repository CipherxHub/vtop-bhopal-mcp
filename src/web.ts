// Server-rendered HTML for the registration experience. Dependency-free (no
// framework, no build step) so it ships with the same `tsup` pipeline, renders
// instantly, and stays fully crawlable for SEO.
//
// Design language: editorial / Swiss-influenced. Warm paper, ink type, a
// characterful serif display face against a clean sans and a mono for technical
// detail, hairline rules instead of shadows, near-monochrome with a single
// restrained accent. Light + dark via prefers-color-scheme.

import type { UserStat } from "./services/session-store.js";

const BRAND = "VTOP Connector";
const REPO_URL = "https://github.com/CipherxHub/vtop-bhopal-mcp";
// The "built by" credit points at the person's profile, not at the project it
// happens to live in - those are different destinations and clicking through
// to a repo to find out who maintains it is a dead end.
const AUTHOR_URL = "https://github.com/CipherxHub";
const AUTHOR_NAME = "CipherxHub";
// npm publishing is not set up (the package is private), so the site points at
// the repo and a clone command rather than an install line that would 404.

// Deep link straight to ChatGPT's Apps → Developer-mode page. ChatGPT has no
// install/prefill API and same-origin rules forbid us from touching its tab,
// so this is the closest one-click flow possible: drop the user on the exact
// page and copy the URL, leaving only flip-toggle, Create, paste.
export const CHATGPT_CONNECTORS_URL =
  "https://chatgpt.com/apps#settings/Connectors/Advanced";

// Same-origin path the "Connect" button points at. The server 302-redirects it
// to CHATGPT_CONNECTORS_URL. Routing through our own (non-app-associated) domain
// stops mobile OSes from hijacking the chatgpt.com link into the ChatGPT app:
// iOS/Android fire universal-/app-links on the initial tap, not on a server
// redirect — so the destination opens in the browser tab instead of the app.
export const CHATGPT_OPEN_PATH = "/open-chatgpt";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const checkIcon =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 4.5 6.5 12 2.5 8"/></svg>';
const copyIcon =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.6"/><path d="M3.5 10H2.7A1.2 1.2 0 0 1 1.5 8.8V2.7A1.2 1.2 0 0 1 2.7 1.5h6.1A1.2 1.2 0 0 1 10 2.7v.8"/></svg>';
const arrowIcon =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg>';
const linkOutIcon =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5H13v3.5M13 2.5 7.5 8"/><path d="M11 9.5v2.8A1.2 1.2 0 0 1 9.8 13.5H3.7A1.2 1.2 0 0 1 2.5 12.3V6.2A1.2 1.2 0 0 1 3.7 5h2.8"/></svg>';

const STYLE = `
:root{
  color-scheme:light dark;
  --paper:#f6f4ee; --raise:#fbfaf6; --ink:#1b1a16; --soft:#54524a; --faint:#6f6c62;
  --line:#e1ddd1; --line2:#d5d0c2; --code-bg:#efece2; --code-ink:#2a2820;
  --accent:#bf3d24; --btn-bg:#1b1a16; --btn-ink:#f6f4ee; --ring:rgba(27,26,22,.18);
  --grain:.04;
}
@media (prefers-color-scheme:dark){
  :root{
    --paper:#0c0c0d; --raise:#141416; --ink:#ecebe6; --soft:#a3a097; --faint:#8f8c83;
    --line:#232326; --line2:#2c2c30; --code-bg:#161618; --code-ink:#e7e6e1;
    --accent:#ff6a4d; --btn-bg:#ecebe6; --btn-ink:#0c0c0d; --ring:rgba(236,235,230,.16);
    --grain:.05;
  }
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{
  background:var(--paper);color:var(--ink);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:17px;line-height:1.6;letter-spacing:-.01em;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  min-height:100vh;position:relative;
}
body::before{
  content:"";position:fixed;inset:0;pointer-events:none;z-index:1;opacity:var(--grain);
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
.wrap{position:relative;z-index:2;max-width:680px;margin:0 auto;padding:0 24px}
.serif{font-family:"Instrument Serif",Georgia,"Times New Roman",serif;font-weight:400;letter-spacing:0}
.mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.eyebrow{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11.5px;font-weight:500;
  text-transform:uppercase;letter-spacing:.22em;color:var(--faint)}
a{color:inherit;text-decoration:none}
em{font-style:italic}

/* header */
header.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:26px 0 14px;
  position:sticky;top:0;z-index:20;
  /* No background on the element itself: it sits inside the max-width column,
     so painting it here covers only that column and the bar reads as a
     floating box. The full-bleed backdrop is the ::below. */
  background:transparent;
  margin-bottom:-14px}
/* Break the backdrop out of the centred column to the full viewport width, so
   the sticky bar spans edge to edge while the links stay aligned with the
   content. border-bottom rather than box-shadow: a spread shadow paints a
   visible dark halo over the textured page. */
header.bar::before{content:"";position:absolute;top:0;bottom:0;left:50%;
  transform:translateX(-50%);width:100vw;background:var(--paper);z-index:-1;
  border-bottom:1px solid var(--line)}
.wordmark{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;flex:0 0 auto}
.dot{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
/* Nav labels never break: on a narrow screen the bar scrolls horizontally
   instead, so every anchor (How / Connect / Safety) stays reachable —
   hiding links on mobile would strand small-screen users mid-page. */
.bar nav{display:flex;gap:22px;font-size:13.5px;color:var(--soft);flex-wrap:nowrap;align-items:center;overflow-x:auto;scrollbar-width:none;min-width:0}
.bar nav::-webkit-scrollbar{display:none}
.bar nav a{position:relative;padding:10px 0;white-space:nowrap;flex:0 0 auto}
@media (max-width:760px){header.bar{gap:12px;padding-top:18px}.bar nav{gap:16px;font-size:13px}}
.bar nav a:hover{color:var(--ink)}
.bar nav a::after{content:"";position:absolute;left:0;right:100%;bottom:8px;height:1px;background:var(--ink);transition:right .25s ease}.bar nav a:hover::after{right:0}
.bar nav a.madeby{color:var(--ink)}
.bar nav a.madeby strong{color:var(--accent);font-weight:600}
/* Hamburger: desktop never sees it. On a phone the full link row does not
   fit, so the links collapse into a dropdown panel instead of vanishing. */
.menu{display:none;border:1px solid var(--line2);background:var(--raise);border-radius:10px;
  width:42px;height:42px;cursor:pointer;position:relative;flex:0 0 auto;margin-left:auto}
.menu span{position:absolute;left:11px;right:11px;height:2px;background:var(--ink);border-radius:2px;
  transition:transform .18s ease,opacity .15s ease}
.menu span:nth-child(1){top:14px}.menu span:nth-child(2){top:20px}.menu span:nth-child(3){top:26px}
header.open .menu span:nth-child(1){transform:translateY(6px) rotate(45deg)}
header.open .menu span:nth-child(2){opacity:0}
header.open .menu span:nth-child(3){transform:translateY(-6px) rotate(-45deg)}
@media (max-width:560px){
  .menu{display:block}
  .bar nav{position:absolute;top:calc(100% - 4px);right:24px;flex-direction:column;align-items:stretch;
    gap:2px;background:var(--raise);border:1px solid var(--line);border-radius:14px;
    padding:8px;min-width:230px;display:none;overflow:visible;z-index:30}
  header.open nav{display:flex}
  .bar nav a{padding:12px 14px;font-size:15px}
  .bar nav a::after{display:none}
}

/* hero */
.hero{padding:64px 0 8px}
.hero h1{font-family:"Instrument Serif",Georgia,serif;font-weight:400;
  font-size:clamp(3rem,9vw,5.4rem);line-height:.96;letter-spacing:-.015em;margin:18px 0 0;text-wrap:balance}
.hero h1 em{color:var(--accent)}
.lede{margin-top:22px;max-width:30em;color:var(--soft);font-size:clamp(16px,2.4vw,19px);line-height:1.55}

/* sections */
section{padding:30px 0}
.rule{height:1px;background:var(--line);border:0}
.kicker{display:flex;align-items:center;gap:12px;margin-bottom:26px}
.kicker h2{font-family:"Instrument Serif",Georgia,serif;font-weight:400;font-size:clamp(1.7rem,4vw,2.3rem);letter-spacing:-.01em}
.kicker .line{flex:1;height:1px;background:var(--line)}

/* form panel */
.panel{border:1px solid var(--line);border-radius:16px;background:var(--raise);padding:28px}
.panel .lead{color:var(--soft);font-size:14.5px;margin:-2px 0 22px}
.label{display:block;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;font-weight:500;
  text-transform:uppercase;letter-spacing:.16em;color:var(--faint);margin:18px 0 8px}
.field{position:relative}
input[type=text],input[type=password]{width:100%;padding:14px 15px;font-size:16px;color:var(--ink);
  background:var(--paper);border:1px solid var(--line2);border-radius:11px;outline:none;
  font-family:inherit;letter-spacing:-.01em;transition:border-color .15s,box-shadow .15s}
input::placeholder{color:var(--faint)}
input:focus{border-color:var(--ink);box-shadow:0 0 0 4px var(--ring)}
/* Visible keyboard focus everywhere — inputs keep their ring, everything
   else gets an accent outline. Without this, keyboard users tab blind. */
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}
input:focus-visible{outline:none}
.toggle{position:absolute;right:7px;top:50%;transform:translateY(-50%);border:0;background:transparent;cursor:pointer;
  font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);
  padding:10px 12px;border-radius:8px;min-height:40px}
.toggle:hover{color:var(--ink)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:9px;width:100%;margin-top:24px;
  padding:15px 20px;font-size:15px;font-weight:600;letter-spacing:-.01em;cursor:pointer;
  color:var(--btn-ink);background:var(--btn-bg);border:1px solid var(--btn-bg);border-radius:11px;
  transition:transform .08s ease,opacity .15s ease}
.btn:hover{opacity:.9}
.btn:active{transform:translateY(1px)}
.btn svg{width:15px;height:15px}
.btn.cta{background:var(--accent);border-color:var(--accent);color:var(--paper)}
.connect-hint{margin-top:14px;color:var(--soft);font-size:14px;font-weight:600;line-height:1.7;text-align:center}
.connect-hint .n{color:var(--accent)}

/* steps */
ol.steps{list-style:none}
ol.steps li{display:grid;grid-template-columns:auto 1fr;gap:20px;align-items:start;
  padding:22px 0;border-top:1px solid var(--line)}
ol.steps li:last-child{border-bottom:1px solid var(--line)}
ol.steps .num{font-family:"Instrument Serif",Georgia,serif;font-size:2rem;line-height:1;color:var(--accent);font-feature-settings:"tnum"}
ol.steps h3{font-size:16px;font-weight:600;letter-spacing:-.01em;margin-bottom:3px}
ol.steps p{color:var(--soft);font-size:14.5px;line-height:1.55}
ol.steps em{font-style:italic}

/* safety */
.safelist{list-style:none;display:grid;gap:16px}
.safelist li{display:grid;grid-template-columns:auto 1fr;gap:13px;align-items:start}
.safelist .ic{width:21px;height:21px;border:1px solid var(--line2);border-radius:7px;display:grid;place-items:center;color:var(--accent);margin-top:2px}
.safelist .ic svg{width:12px;height:12px}
.safelist b{font-weight:600}
.safelist span{color:var(--soft);font-size:15px}
.safelist span b{color:var(--ink)}
.note{margin-top:22px;padding-top:18px;border-top:1px solid var(--line);color:var(--faint);font-size:13.5px;line-height:1.6}

.textlink{color:var(--ink);border-bottom:1px solid var(--accent);padding-bottom:1px;white-space:nowrap}
.textlink:hover{color:var(--accent)}
.navpath{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin-top:10px}
.navpath span{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;background:var(--code-bg);
  border:1px solid var(--line);border-radius:7px;padding:5px 9px;color:var(--ink)}
.navpath span:not(:last-child)::after{content:"→";margin-left:8px;color:var(--accent);font-weight:700}
.navpath span:last-child{border-color:var(--accent);color:var(--accent)}

/* code / result */
.codebox{position:relative;margin-top:10px}
pre{background:var(--code-bg);color:var(--code-ink);border:1px solid var(--line);border-radius:12px;
  padding:16px 58px 16px 16px;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:13px;
  line-height:1.6;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.copy{position:absolute;top:9px;right:9px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;
  background:var(--paper);color:var(--soft);border:1px solid var(--line2);border-radius:8px;
  padding:10px 12px;min-height:40px;font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;
  transition:color .15s,border-color .15s}
.copy:hover{color:var(--ink);border-color:var(--ink)}
.copy.copied{color:var(--accent);border-color:var(--accent)}
.copy svg{width:13px;height:13px}
.ready{display:inline-flex;align-items:center;gap:9px;color:var(--accent);font-family:"JetBrains Mono",monospace;
  font-size:11.5px;letter-spacing:.22em;text-transform:uppercase}
details{margin-top:22px;border-top:1px solid var(--line);padding-top:6px}
summary{cursor:pointer;font-size:14px;color:var(--soft);padding:14px 0;list-style:none}
summary:hover{color:var(--ink)}
summary::-webkit-details-marker{display:none}
summary::before{content:"+ ";font-family:"JetBrains Mono",monospace;color:var(--accent)}
details[open] summary::before{content:"– "}
code.in{font-family:"JetBrains Mono",monospace;font-size:.86em;background:var(--code-bg);
  border:1px solid var(--line);border-radius:5px;padding:1px 5px}

.backlink{display:inline-flex;align-items:center;gap:7px;margin-top:28px;font-size:14px;color:var(--soft)}
.backlink:hover{color:var(--ink)}
.backlink svg{width:14px;height:14px}

/* footer */
footer.foot{margin-top:40px;padding:26px 0 56px;border-top:1px solid var(--line);
  display:flex;flex-wrap:wrap;gap:14px;justify-content:space-between;align-items:center;
  font-size:13px;color:var(--faint)}
footer.foot a{color:var(--soft)}
footer.foot a:hover{color:var(--ink)}
footer.foot .links{display:flex;gap:20px;align-items:center}
footer.foot .by b{color:var(--ink);font-weight:600}

@media(max-width:560px){
  ol.steps .num{font-size:1.6rem}
}
/* Motion is decorative here (underline sweeps, button dips), so switch it
   off wholesale for users who ask for reduced motion. */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{transition:none!important;animation:none!important}
}
`;

interface LayoutOpts {
  title: string;
  description: string;
  origin: string;
  canonicalPath: string;
  body: string;
  noindex?: boolean;
}

function layout(o: LayoutOpts): string {
  const canonical = `${o.origin}${o.canonicalPath}`;
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: BRAND,
    description: o.description,
    applicationCategory: "EducationalApplication",
    operatingSystem: "Any",
    url: o.origin,
    author: { "@type": "Person", name: AUTHOR_NAME, url: AUTHOR_URL },
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  });
  const favicon =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1b1a16"/><path d="M16 8.5 27 13.2 16 17.9 5 13.2Z" fill="#f6f4ee"/><path d="M11 15v3.4c0 1.4 10 1.4 10 0V15" fill="none" stroke="#f6f4ee" stroke-width="1.5"/><path d="M27 13.2v6" stroke="#bf3d24" stroke-width="1.5" stroke-linecap="round"/><circle cx="27" cy="20.4" r="1.7" fill="#bf3d24"/></svg>',
    );
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(o.title)}</title>
<meta name="description" content="${escapeHtml(o.description)}">
<meta name="keywords" content="VTOP, VIT Bhopal, MCP, model context protocol, connector, Claude, ChatGPT, Cursor, OpenCode, attendance, timetable, marks, CGPA, hostel leave, vtop">
<meta name="author" content="${AUTHOR_NAME}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta name="robots" content="${o.noindex ? "noindex,nofollow" : "index,follow"}">
<meta name="theme-color" content="#f6f4ee" media="(prefers-color-scheme:light)">
<meta name="theme-color" content="#0c0c0d" media="(prefers-color-scheme:dark)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${BRAND}">
<meta property="og:title" content="${escapeHtml(o.title)}">
<meta property="og:description" content="${escapeHtml(o.description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:image" content="${escapeHtml(o.origin)}/og.svg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(o.title)}">
<meta name="twitter:description" content="${escapeHtml(o.description)}">
<meta name="twitter:image" content="${escapeHtml(o.origin)}/og.svg">
<link rel="icon" href="${favicon}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap">
<script type="application/ld+json">${jsonLd}</script>
<style>${STYLE}</style>
</head><body><div class="wrap">
<header class="bar">
  <a class="wordmark" href="/"><span class="dot"></span>VTOP&nbsp;Connector</a>
  <nav id="sitenav">
    <a href="#how">How it works</a>
    <a href="#connect">Connect</a>
    <a href="#safe">Safety</a>
    <a class="gh" href="${REPO_URL}" target="_blank" rel="noopener">GitHub&nbsp;↗</a>
    <a class="madeby" href="${AUTHOR_URL}" target="_blank" rel="noopener">built by <strong>CipherxHub</strong>&nbsp;↗</a>
  </nav>
  <button class="menu" type="button" data-menu aria-expanded="false" aria-controls="sitenav" aria-label="Open menu"><span></span><span></span><span></span></button>
</header>
${o.body}
<footer class="foot">
  <span class="by">Built by <a href="${AUTHOR_URL}" target="_blank" rel="noopener"><b>CipherxHub</b></a></span>
  <span class="links">
    <a href="${REPO_URL}" target="_blank" rel="noopener">Source ↗</a>
    <a href="${REPO_URL}/blob/main/docs/tools.md" target="_blank" rel="noopener">Tools ↗</a>
    <span>Apache-2.0</span>
  </span>
</footer>
</div>
<script>
document.addEventListener("click",function(e){
  var c=e.target.closest("[data-copy]");
  if(c){navigator.clipboard.writeText(c.getAttribute("data-copy")).then(function(){
    c.classList.add("copied");var s=c.querySelector("span");var t=s?s.textContent:"";
    if(s)s.textContent="Copied";setTimeout(function(){c.classList.remove("copied");if(s)s.textContent=t;},1700);
  });}
  // Connect button: copy the link, then let the anchor open ChatGPT in a new
  // tab (no preventDefault, so target=_blank works without popup blocking).
  var k=e.target.closest("[data-connect]");
  if(k){var u=k.getAttribute("data-connect");
    if(u&&navigator.clipboard)navigator.clipboard.writeText(u).catch(function(){});
    var ks=k.querySelector("span");var kt=ks?ks.textContent:"";
    if(ks){ks.textContent="Link copied, opening…";setTimeout(function(){if(ks)ks.textContent=kt;},2200);}
  }
  var t=e.target.closest("[data-toggle]");
  if(t){var i=document.getElementById(t.getAttribute("data-toggle"));
    if(i){var p=i.type==="password";i.type=p?"text":"password";t.textContent=p?"Hide":"Show";}}});
/* Hamburger menu: flip the panel, keep the label and expanded state honest,
// collapse after following a link, and let Escape close it with focus back
// on the button. Closed menus are display:none, so hidden links stay out of
// the tab order for free. */
document.addEventListener("click",function(e){
  var el=e.target&&e.target.closest?e.target.closest("[data-menu],#sitenav a"):null;
  if(!el)return;
  var h=el.closest("header");if(!h)return;
  var mb=h.querySelector("[data-menu]");
  var setMenu=function(open){
    h.classList.toggle("open",open);
    if(mb){mb.setAttribute("aria-expanded",open?"true":"false");
      mb.setAttribute("aria-label",open?"Close menu":"Open menu");}
  };
  if(el.hasAttribute("data-menu")){setMenu(!h.classList.contains("open"));}
  else{setMenu(false);}
});
document.addEventListener("keydown",function(e){
  if(e.key==="Escape"){var o=document.querySelector("header.open");
    if(o){o.classList.remove("open");
      var mb=o.querySelector("[data-menu]");
      if(mb){mb.setAttribute("aria-expanded","false");mb.setAttribute("aria-label","Open menu");mb.focus();}}}
});
/* One-shot submit: registering mints a token, so a double-click must not
   fire a second POST. Disable the button and say so on the label. */
document.addEventListener("submit",function(e){
  var f=e.target;
  if(f&&f.tagName==="FORM"){var b=f.querySelector("button[type=submit]");
    if(b&&!b.disabled){b.disabled=true;b.style.opacity=".55";b.style.cursor="wait";
      if(b.firstChild&&b.firstChild.nodeType===3)b.firstChild.textContent="Generating… ";}}
});
/* Registration-number masking must run on every keystroke and paste —
// a click listener only fires when the field gains focus, so typing right
// after would bypass it entirely. Same normalisation, correct event. */
document.addEventListener("input",function(e){
  var u=e.target&&e.target.id==="username"?e.target:null;
  if(u){
    var raw=u.value.toUpperCase().replace(/[^0-9A-Z]/g,"").slice(0,10);
    var v=raw.slice(0,2).replace(/[^0-9]/g,"")          // batch: digits
          +raw.slice(2,5).replace(/[^A-Z]/g,"")         // branch: letters
          +raw.slice(5,10).replace(/[^0-9]/g,"");       // sequence: digits
    if(v!==u.value)u.value=v;
  }
});
</script>
</body></html>`;
}

function howItWorks(): string {
  const step = (n: string, h: string, p: string) =>
    `<li><span class="num">${n}</span><div><h3>${h}</h3><p>${p}</p></div></li>`;
  return `<section id="how">
  <div class="kicker"><h2 class="serif">How it works</h2><span class="line"></span></div>
  <ol class="steps">
    ${step("01", "Enter your VTOP login", "Once, on this page. Never inside a chat window.")}
    ${step("02", "Get a private link", "Your credentials are encrypted into a connector URL that's yours alone.")}
    ${step("03", "Add the link to your assistant", "Paste it into Claude, ChatGPT, Cursor, OpenCode — anything that speaks remote MCP. The steps differ per app and are listed below.")}
  </ol>
</section>`;
}

/**
 * Per-client setup. Claude first because the connector UI is the least
 * fiddly; ChatGPT is included because the original deep-link button and
 * developer-mode flow are built for it, but it is now one option among
 * several rather than the only one.
 */
function connectSteps(): string {
  const d = (title: string, inner: string) =>
    `<details><summary>${title}</summary><div class="detail">${inner}</div></details>`;

  return `<section id="connect">
  <div class="kicker"><h2 class="serif">Add it to your assistant</h2><span class="line"></span></div>
  <p style="color:var(--soft);max-width:52em">Pick the app you use. All of them take the same link.</p>

  ${d(
    "Claude (web, desktop app, iOS, Android)",
    `<p>Works on Free, Pro and Max. Add it once on the web or desktop app and it appears on your phone too.</p>
     <div class="navpath"><span>Customize</span><span>Connectors</span><span>Add custom connector</span><span>paste your link</span></div>
     <p style="margin-top:8px">Use the full link including the <code>/mcp/…</code> path and your token at the end. Then open a chat, tap <strong>+</strong> → <strong>Connectors</strong>, and switch it on.</p>
     <p style="margin-top:8px;color:var(--soft);font-size:14px">Mobile connector install is still in beta, so add it on web first — it syncs to the app.</p>`,
  )}

  ${d(
    "ChatGPT",
    `<p>Needs a paid plan — <strong>Go</strong>, <strong>Plus</strong> or <strong>Pro</strong>. Not available on free.</p>
     <div class="navpath"><span>Profile</span><span>Settings</span><span>Apps</span><span>Developer mode = ON</span></div>
     <p style="margin-top:8px">Click <strong>Create</strong>, then paste your link as the <strong>MCP Server URL</strong> and set <strong>Authentication</strong> to <strong>No Auth</strong> — the token is already in the link.</p>
     <p style="margin-top:8px;color:var(--soft);font-size:14px">Then start a chat, turn on the app, and mention it by name: <em>“use the VTOP Bhopal MCP tool to get my attendance.”</em></p>`,
  )}

  ${d(
    "Cursor, Windsurf, Cline, Zed",
    `<p>These connect by URL in a config file. Use <code>command</code> + <code>args</code>, or the client's URL field where it has one.</p>
     <div class="codebox" style="margin-top:8px"><pre>{
  "mcpServers": {
    "vtop": {
      "url": "&lt;your connector link&gt;"
    }
  }
}</pre></div>`,
  )}

  ${d(
    "Claude Code (terminal)",
    `<p>One command. This is the path that keeps everything on your own machine instead of going through the cloud.</p>
     <div class="codebox" style="margin-top:8px"><pre>claude mcp add --transport http vtop &lt;your connector link&gt;</pre></div>
     <p style="margin-top:8px">Check it with <code>/mcp</code> inside a session.</p>`,
  )}

  ${d(
    "Anything else",
    `<p>Anything that speaks remote MCP over Streamable HTTP takes the same link. That includes OpenAI's API via <code>mcp_servers</code>, VS Code, Codex, and older stdio-only clients through the <code>mcp-remote</code> bridge.</p>
     <p style="margin-top:8px;color:var(--soft);font-size:14px">To check a link by hand, <code>npx @modelcontextprotocol/inspector</code> will connect and list the tools.</p>`,
  )}
</section>`;
}

function safety(): string {
  const li = (b: string, rest: string) =>
    `<li><span class="ic">${checkIcon}</span><span><b>${b}</b> ${rest}</span></li>`;
  return `<section id="safe">
  <div class="kicker"><h2 class="serif">Built to be safe</h2><span class="line"></span></div>
  <ul class="safelist">
    ${li("Password never stored.", "Your password is sealed with AES-256-GCM <em>inside the link itself</em>. The plaintext is never written to disk or to a database — the link is the only copy.")}
    ${li("Never typed into chat.", "You sign in here, on a normal page over HTTPS, so your password is never exposed to the AI model.")}
    ${li("Only your link works.", "Requests without a valid token are rejected, including when the server also holds operator credentials. Rotating the server secret invalidates every link at once.")}
    ${li("Nothing in the logs.", "There is no access logger, and session keys are stored hashed — your token is not written to stdout or to any log file.")}
    ${li("Fully open source.", "Every line is public, so read exactly what runs before you trust it with your account.")}
  </ul>
  <p style="color:var(--soft);max-width:52em;margin-top:14px">Treat the link like a password: it grants full access to your VTOP account. If it ever leaks, rotate the server's secret and everyone re-registers.</p>
</section>`;
}

function buildYourOwn(): string {
  const clone = `git clone ${REPO_URL}.git && cd vtop-bhopal-mcp && npm install && npm run build`;
  return `<section id="build">
  <div class="kicker"><h2 class="serif">Use it in your own project</h2><span class="line"></span></div>
  <p style="color:var(--soft);max-width:46em">VTOP Bhopal MCP is free and open source, built and tested against the live VIT Bhopal portal. Clone it, run the build, and wire it into your own MCP client — or run the HTTP connector yourself and skip the hosted copy entirely.</p>
  <div class="codebox" style="margin-top:14px">
    <pre>${escapeHtml(clone)}</pre>
    <button class="copy" data-copy="${escapeHtml(clone)}">${copyIcon}<span>Copy</span></button>
  </div>
  <p style="margin-top:16px;font-size:15px;color:var(--soft)">
    Needs <strong>Node 20.6+</strong>. Full setup, per-client configs and the security notes are in the
    <a class="textlink" href="${REPO_URL}" target="_blank" rel="noopener">project README</a>.
  </p>
</section>`;
}

export function landingPage(origin: string, canonicalPath: string): string {
  const body = `<section class="hero">
  <span class="eyebrow">MCP connector · VIT Bhopal</span>
  <h1>Your VTOP,<br>in <em>any AI assistant</em>.</h1>
  <p class="lede">Connect your VIT Bhopal VTOP once, then just ask: <em>“how many more classes can I skip?”</em> · <em>“what do I need in the TEE to pass?”</em> · <em>“when is my FAT and where?”</em> Real answers from your own VTOP, in plain English — attendance, marks, timetable, exams, grades, CGPA and hostel leave. Works with Claude, ChatGPT, Cursor, OpenCode and anything else that speaks MCP.</p>
  <span class="ready" style="margin-top:18px"><span class="dot"></span>Setup in under 1 minute · just 3 steps</span>
</section>
<section>
  <div class="panel">
    <div class="kicker" style="margin-bottom:6px"><h2 class="serif" style="font-size:1.5rem">Create your link</h2></div>
    <p class="lead">Your VTOP credentials are encrypted into the link and never stored.</p>
    <form method="POST" action="/register" autocomplete="off">
      <label class="label" for="username">VTOP username</label>
      <div class="field"><input id="username" name="username" type="text" placeholder="23ABC12345"
        inputmode="text" maxlength="10" autocapitalize="characters" autocomplete="username" spellcheck="false"
        pattern="[0-9]{2}[A-Z]{3}[0-9]{5}" title="Two digits, three letters, then five digits." required></div>
      <label class="label" for="password">VTOP password</label>
      <div class="field">
        <input id="password" name="password" type="password" placeholder="••••••••" autocomplete="current-password" required>
        <button type="button" class="toggle" data-toggle="password">Show</button>
      </div>
      <button class="btn" type="submit">Generate my link ${arrowIcon}</button>
    </form>
  </div>
</section>
${howItWorks()}
${connectSteps()}
${safety()}
${buildYourOwn()}`;
  return layout({
    title: `${BRAND}: VIT Bhopal VTOP for Claude, ChatGPT and any MCP client`,
    description:
      "Connect your VIT Bhopal VTOP once, then ask any AI assistant about attendance, marks, timetable, exams, grades and hostel leave in plain English. Credentials encrypted into your link, never stored.",
    origin,
    canonicalPath,
    body,
  });
}

export function resultPage(opts: {
  origin: string;
  connectorUrl: string;
  baseMcpUrl: string;
  token: string;
}): string {
  const safeUrl = escapeHtml(opts.connectorUrl);
  const body = `<section class="hero" style="padding-bottom:0">
  <span class="ready"><span class="dot"></span>Link ready</span>
  <h1 style="font-size:clamp(2.4rem,7vw,4rem)">Your connector<br>is <em>live</em>.</h1>
  <p class="lede">Copy your private link and add it to your AI assistant. That's the whole setup.</p>
</section>
<section>
  <span class="label" style="margin-top:0">Your connector URL</span>
  <div class="codebox">
    <pre>${safeUrl}</pre>
    <button class="copy" data-copy="${safeUrl}">${copyIcon}<span>Copy</span></button>
  </div>
  <a class="btn cta" href="${CHATGPT_OPEN_PATH}" target="_blank" rel="noopener" data-connect="${safeUrl}"><span>Add to ChatGPT</span>${linkOutIcon}</a>
  <p class="connect-hint">Using Claude, Cursor or something else? The same link works — pick your app above.</p>
</section>
${connectSteps()}
<section id="how" style="padding-top:8px">
  <a class="backlink" href="/register">${arrowIcon} Generate another link</a>
</section>`;
  return layout({
    title: `Your connector link · ${BRAND}`,
    description: "Your personal VTOP connector link is ready to add to Claude, ChatGPT or any MCP client.",
    origin: opts.origin,
    canonicalPath: "/register",
    body,
    noindex: true,
  });
}

export function unavailablePage(origin: string, message: string): string {
  const body = `<section class="hero">
  <span class="eyebrow">Single-user mode</span>
  <h1 style="font-size:clamp(2.2rem,6vw,3.4rem)">Registration is <em>off</em>.</h1>
  <p class="lede">${escapeHtml(message)}</p>
</section>`;
  return layout({
    title: `Unavailable · ${BRAND}`,
    description: "Self-service registration is not enabled on this deployment.",
    origin,
    canonicalPath: "/register",
    body,
    noindex: true,
  });
}

/**
 * Private operator dashboard rendered at the secret /stats/<token> route.
 * Standalone, noindex, no SEO tags — it's not meant to be discovered.
 */
export function statsPage(users: UserStat[], note?: string): string {
  const fmt = (iso: string) => (iso ? escapeHtml(iso.slice(0, 16).replace("T", " ")) + " UTC" : "-");
  const totalLogins = users.reduce((s, u) => s + u.logins, 0);
  const totalReuses = users.reduce((s, u) => s + u.reuses, 0);
  const rows = users
    .map(
      (u, i) =>
        `<tr><td class="n">${i + 1}</td><td class="reg">${escapeHtml(u.regNo)}</td><td>${fmt(u.firstSeen)}</td><td>${fmt(u.lastSeen)}</td><td class="n">${u.logins}</td><td class="n">${u.reuses}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Usage · ${BRAND}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#15140f;color:#ece9df;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:40px 20px}
.wrap{max-width:880px;margin:0 auto}
h1{font-size:14px;letter-spacing:.22em;text-transform:uppercase;color:#bf3d24;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:0 0 18px}
.big{font-size:clamp(48px,12vw,84px);font-weight:600;line-height:1}
.sub{color:#9a978c;margin:4px 0 28px}
.note{color:#d8a23a;margin:0 0 20px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #2a281f}
th{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9a978c;font-weight:500}
td.reg{font-family:ui-monospace,monospace;color:#fff}
td.n{color:#9a978c}
.empty{color:#9a978c;padding:24px 0}
</style></head><body><div class="wrap">
<h1>${BRAND} · usage</h1>
<div class="big">${users.length}</div>
<p class="sub">unique users · ${totalLogins} fresh logins · ${totalReuses} session reuses</p>
${note ? `<p class="note">${escapeHtml(note)}</p>` : ""}
${
  users.length
    ? `<table><thead><tr><th>#</th><th>Registration no.</th><th>First seen</th><th>Last seen</th><th>Logins</th><th>Reuses</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="empty">No activity recorded yet.</p>`
}
</div></body></html>`;
}

export function ogImageSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#f6f4ee"/>
<rect x="20" y="20" width="1160" height="590" fill="none" stroke="#e1ddd1" stroke-width="2"/>
<circle cx="96" cy="118" r="9" fill="#bf3d24"/>
<text x="120" y="125" fill="#54524a" font-family="'JetBrains Mono',monospace" font-size="24" letter-spacing="5">MCP CONNECTOR · VIT VTOP</text>
<text x="92" y="320" fill="#1b1a16" font-family="Georgia,'Times New Roman',serif" font-size="118">Your VTOP, now</text>
<text x="92" y="438" fill="#1b1a16" font-family="Georgia,'Times New Roman',serif" font-size="118">in <tspan fill="#bf3d24" font-style="italic">any assistant</tspan>.</text>
<text x="96" y="540" fill="#54524a" font-family="Georgia,serif" font-size="34">Attendance · Marks · Timetable · Exams · CGPA</text>
</svg>`;
}

export function robotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /$\nAllow: /register$\nDisallow: /mcp\n\nSitemap: ${origin}/sitemap.xml\n`;
}

export function sitemapXml(origin: string): string {
  const urls = ["/", "/register"];
  const body = urls
    .map((u) => `  <url><loc>${origin}${u}</loc><changefreq>monthly</changefreq></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
