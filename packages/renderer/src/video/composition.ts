/**
 * Generate a complete HyperFrames composition (one self-contained index.html
 * with a single paused GSAP timeline) from a walkthrough's scenes.
 *
 * This is the animated video engine: a title card, then one scene per chapter
 * that reveals the actual diff line-by-line and lights up the referenced
 * ("spotlight") lines as they're narrated, with sentence-beat captions timed to
 * the measured voiceover. HyperFrames seeks this timeline frame-by-frame in
 * headless Chrome, so everything obeys the determinism contract: no wall-clock
 * logic, captions are static DOM text, animate `autoAlpha`/transforms, and every
 * faded-out element is hard-cleared with `tl.set(..., {autoAlpha:0})`.
 */

export interface CodeRow {
  sign: " " | "+" | "-";
  num: number | null;
  /** Pre-highlighted, escaped HTML for the line content. */
  html: string;
  spot: boolean;
}

export interface VideoScene {
  kind: "title" | "chapter" | "outro";
  eyebrow: string;
  title: string;
  risk?: "low" | "medium" | "high";
  intent?: string;
  subtitle?: string; // title/outro only
  filePath?: string;
  rows?: CodeRow[];
  hasSpots: boolean;
  /** Absolute timeline position (seconds). */
  start: number;
  dur: number;
  voStart: number;
  voDur: number;
  /** Audio file (relative to the composition), or null for silent scenes. */
  audio: string | null;
}

const FRAME_W = 1920;
const FRAME_H = 1080;

/* timing constants (seconds) */
const FADE = 0.5;
const HDR_IN = 0.3;
const CODE_IN = 0.8;
const ROW_STAGGER = 0.085;
const ROW_DUR = 0.4;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg:#0d1117; --panel:#161b22; --panel2:#1c2430; --line:#30363d;
  --text:#e6edf3; --muted:#768390; --accent:#4493f8;
  --add:#3fb950; --add-wash:rgba(63,185,80,0.13); --del:#f85149;
}
html,body { width:${FRAME_W}px; height:${FRAME_H}px; overflow:hidden; background:var(--bg); }
body { font-family: system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:var(--text); letter-spacing:-0.01em; -webkit-font-smoothing:antialiased; }
.mono { font-family: ui-monospace,"JetBrains Mono","DejaVu Sans Mono",Menlo,Consolas,monospace; }
.scene { position:absolute; inset:0; opacity:0; }
#bg { position:absolute; inset:0; background: radial-gradient(1400px 880px at 32% 34%, #151b24 0%, #0f141b 48%, var(--bg) 100%); }

/* header */
.hdr { position:absolute; left:120px; top:92px; width:1680px; }
.eyebrow-row { display:flex; align-items:center; gap:20px; margin-bottom:16px; }
.eyebrow { font-size:26px; font-weight:800; letter-spacing:0.34em; text-transform:uppercase; color:var(--muted); }
.pill { font-size:22px; font-weight:900; letter-spacing:0.06em; text-transform:uppercase; padding:6px 18px; border-radius:999px; }
.pill-low { background:var(--add-wash); color:var(--add); }
.pill-medium { background:rgba(210,153,34,0.15); color:#d29922; }
.pill-high { background:rgba(248,81,73,0.15); color:var(--del); }
.title { font-size:68px; font-weight:900; letter-spacing:-0.03em; line-height:1.04;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.intent { margin-top:14px; font-size:30px; font-weight:500; color:var(--muted); max-width:1500px;
  display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; overflow:hidden; }

/* code panel */
.code { position:absolute; left:120px; top:300px; width:1680px; background:var(--panel);
  border-radius:20px; box-shadow:0 24px 80px rgba(0,0,0,0.45), inset 0 0 0 1px var(--line); overflow:hidden; }
.code-head { display:flex; align-items:center; gap:14px; height:64px; padding:0 26px; background:var(--panel2); box-shadow:inset 0 -1px 0 var(--line); }
.dot { width:15px; height:15px; border-radius:50%; }
.dot.r{background:#ff5f57;} .dot.y{background:#febc2e;} .dot.g{background:#28c840;}
.code-path { margin-left:12px; font-size:24px; color:var(--muted); font-weight:600; }
.code-body { padding:18px 0; }
.row { position:relative; display:flex; align-items:center; height:44px; font-family: ui-monospace,"JetBrains Mono","DejaVu Sans Mono",Menlo,Consolas,monospace; font-size:26px; line-height:44px; white-space:pre; }
.row .sb { position:absolute; left:0; top:0; width:6px; height:100%; background:var(--add); transform:scaleY(0); transform-origin:top center; }
.row:not(.spot) .sb { display:none; }
.row .g { width:92px; flex:none; text-align:right; padding-right:22px; color:#586069; }
.row .s { width:30px; flex:none; text-align:center; }
.row.add .s { color:var(--add); } .row.del .s { color:var(--del); }
.row.add { background:rgba(63,185,80,0.07); } .row.del { background:rgba(248,81,73,0.07); }
.row .c { overflow:hidden; padding-right:24px; }

/* title / outro takeover */
.takeover { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; gap:30px; padding:0 200px; }
.tk-eyebrow { font-size:30px; font-weight:800; letter-spacing:0.4em; text-transform:uppercase; color:var(--accent); }
.tk-title { font-size:128px; font-weight:900; letter-spacing:-0.04em; line-height:0.98;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.tk-sub { font-size:42px; font-weight:500; color:var(--muted); max-width:1380px; line-height:1.3; }

/* hljs (GitHub dark) */
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-section,.hljs-doctag{color:#ff7b72}
.hljs-string,.hljs-regexp,.hljs-meta .hljs-string,.hljs-addition{color:#a5d6ff}
.hljs-comment,.hljs-quote{color:#8b949e;font-style:italic}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-selector-id{color:#79c0ff}
.hljs-title,.hljs-title.function_,.hljs-title.class_{color:#d2a8ff}
.hljs-type,.hljs-class .hljs-title,.hljs-built_in{color:#ffa657}
.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable,.hljs-property,.hljs-params,.hljs-selector-attr,.hljs-selector-class{color:#79c0ff}
.hljs-name,.hljs-tag,.hljs-selector-pseudo{color:#7ee787}
.hljs-meta{color:#8b949e}
`;

function rowHtml(r: CodeRow): string {
  const cls = r.sign === "+" ? "add" : r.sign === "-" ? "del" : "ctx";
  return (
    `<div class="row ${cls}${r.spot ? " spot" : ""}">` +
    `<span class="sb"></span>` +
    `<span class="g">${r.num != null ? r.num : ""}</span>` +
    `<span class="s">${r.sign === " " ? "" : r.sign}</span>` +
    `<span class="c">${r.html || "&nbsp;"}</span>` +
    `</div>`
  );
}

function sceneHtml(s: VideoScene, idx: number, z: number): string {
  const id = `sc${idx}`;
  if (s.kind === "title" || s.kind === "outro") {
    return (
      `<div class="scene clip" id="${id}" data-start="${s.start}" data-duration="${s.dur}" data-track-index="${z}" style="z-index:${z}">` +
      `<div class="takeover">` +
      `<div class="tk-eyebrow" id="${id}-eb">${esc(s.eyebrow)}</div>` +
      `<div class="tk-title" id="${id}-ti">${esc(s.title)}</div>` +
      (s.subtitle ? `<div class="tk-sub" id="${id}-sub">${esc(s.subtitle)}</div>` : "") +
      `</div></div>`
    );
  }
  const rows = (s.rows ?? []).map(rowHtml).join("");
  return (
    `<div class="scene clip" id="${id}" data-start="${s.start}" data-duration="${s.dur}" data-track-index="${z}" style="z-index:${z}">` +
    `<div class="hdr" id="${id}-hdr">` +
    `<div class="eyebrow-row">` +
    `<span class="eyebrow">${esc(s.eyebrow)}</span>` +
    (s.risk ? `<span class="pill pill-${s.risk}">${esc(s.risk)} risk</span>` : "") +
    `</div>` +
    `<div class="title">${esc(s.title)}</div>` +
    (s.intent ? `<div class="intent">${esc(s.intent)}</div>` : "") +
    `</div>` +
    (rows
      ? `<div class="code" id="${id}-code"><div class="code-head"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="code-path mono">${esc(s.filePath ?? "")}</span></div><div class="code-body">${rows}</div></div>`
      : "") +
    `</div>`
  );
}

/** Emit the GSAP calls for one scene, at absolute times. */
function sceneTimeline(s: VideoScene, idx: number): string[] {
  const id = `#sc${idx}`;
  const t = s.start;
  const end = s.start + s.dur;
  const L: string[] = [];
  const at = (x: number) => x.toFixed(3);

  // container in / out
  L.push(`tl.fromTo("${id}",{autoAlpha:0},{autoAlpha:1,duration:${FADE}},${at(t)});`);
  L.push(`tl.to("${id}",{autoAlpha:0,duration:${FADE}},${at(end - FADE)});`);
  L.push(`tl.set("${id}",{autoAlpha:0},${at(end)});`);

  if (s.kind === "title" || s.kind === "outro") {
    L.push(`tl.from("${id}-eb",{autoAlpha:0,y:18,duration:0.6},${at(t + 0.3)});`);
    L.push(`tl.from("${id}-ti",{autoAlpha:0,y:40,scale:0.96,duration:0.8},${at(t + 0.5)});`);
    if (s.subtitle) L.push(`tl.from("${id}-sub",{autoAlpha:0,y:22,duration:0.6},${at(t + 1.2)});`);
    return L;
  }

  // header
  L.push(`tl.from("${id}-hdr",{autoAlpha:0,y:22,duration:0.6},${at(t + HDR_IN)});`);

  // code panel + staggered row reveal
  const nRows = s.rows?.length ?? 0;
  let revealEnd = t;
  if (nRows) {
    const codeAt = t + CODE_IN;
    L.push(`tl.from("${id}-code",{autoAlpha:0,y:26,duration:0.6},${at(codeAt)});`);
    L.push(`tl.from("${id} .row",{autoAlpha:0,x:-24,duration:${ROW_DUR},stagger:${ROW_STAGGER}},${at(codeAt + 0.3)});`);
    revealEnd = codeAt + 0.3 + nRows * ROW_STAGGER + ROW_DUR;

    if (s.hasSpots) {
      // spotlight moment: after reveal, but tied to the narration's middle
      let spotAt = Math.max(revealEnd + 0.2, s.voStart + s.voDur * 0.32);
      spotAt = Math.min(spotAt, end - 1.2);
      L.push(`tl.to("${id} .row:not(.spot)",{opacity:0.28,duration:0.5},${at(spotAt)});`);
      L.push(`tl.to("${id} .row.spot",{backgroundColor:"rgba(63,185,80,0.16)",duration:0.5},${at(spotAt)});`);
      L.push(`tl.fromTo("${id} .row.spot .sb",{scaleY:0},{scaleY:1,duration:0.45,stagger:0.05,ease:"power2.out"},${at(spotAt)});`);
    }
  }

  // Narration is delivered as a soft subtitle track (see hyperframes.ts), not
  // burned into the frame — so there are no on-screen caption tweens here.
  return L;
}

export function buildComposition(scenes: VideoScene[], totalDur: number): string {
  let z = 10;
  const sceneEls = scenes.map((s, i) => sceneHtml(s, i, z++)).join("\n      ");
  const audioEls = scenes
    .filter((s) => s.audio)
    .map(
      (s, i) =>
        `<audio id="vo${i}" src="${s.audio}" data-start="${s.voStart.toFixed(3)}" data-duration="${s.voDur.toFixed(3)}" data-track-index="${z++}" data-volume="1"></audio>`,
    )
    .join("\n      ");

  const tlCalls = scenes.flatMap((s, i) => sceneTimeline(s, i)).join("\n      ");

  return `<!doctype html>
<html lang="en" data-resolution="landscape">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${FRAME_W}, height=${FRAME_H}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>${CSS}</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${totalDur.toFixed(3)}" data-width="${FRAME_W}" data-height="${FRAME_H}">
      <div id="bg" class="layer clip" data-start="0" data-duration="${totalDur.toFixed(3)}" data-track-index="0" style="z-index:0"></div>
      ${sceneEls}
      ${audioEls}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true, defaults: { ease: "power3.out" } });
      ${tlCalls}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}
