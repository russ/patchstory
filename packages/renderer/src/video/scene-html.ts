/**
 * Static, self-contained HTML for a single *video* scene.
 *
 * Unlike the interactive web client, these pages are deterministic and meant to
 * be rasterized once by a headless browser. The layout is deliberately built
 * from FIXED pixel heights: a header band of exactly {@link HEADER_H}px at the
 * top, a caption band of exactly {@link CAPTION_H}px at the bottom, and the code
 * in between. Because those two bands are pixel-exact, the video pipeline can
 * slice the one tall screenshot into "fixed header / panning code / fixed
 * caption" with simple top/bottom crops — no per-element measurement needed.
 *
 * Theme is always dark (it reads best as video). Syntax highlighting reuses the
 * same per-line highlighter as the interactive renderer.
 */

import { highlightLine, langForPath } from "../../web/highlight.ts";
import type { DiffFile } from "@patchstory/core";

/* --- Fixed geometry. The pipeline imports these to compute crop offsets. --- */
export const FRAME_W = 1920;
export const FRAME_H = 1080;
export const HEADER_H = 230;
export const CAPTION_H = 210;
export const MID_H = FRAME_H - HEADER_H - CAPTION_H; // 640 — the code viewport
export const LINE_H = 40;
export const FILE_HEAD_H = 58;
export const CODE_PAD_V = 28;
export const FILE_GAP = 16;

export interface SceneLine {
  sign: " " | "+" | "-";
  /** New-file line number, or null for deletions. */
  num: number | null;
  /** Raw (un-highlighted) line content. */
  content: string;
  spot: boolean;
}

export interface SceneFileBlock {
  path: string;
  status: string;
  lines: SceneLine[];
}

export interface SceneSpec {
  eyebrow: string;
  title: string;
  risk?: "low" | "medium" | "high";
  intent?: string;
  /** Narration text, shown as the fixed caption band. */
  caption: string;
  blocks: SceneFileBlock[];
  hasSpots: boolean;
}

/** Deterministic content height of the code area, given its blocks. The
 *  pipeline reads the *actual* height from the screenshot, but this is a good
 *  window-size hint so the headless capture isn't clipped. */
export function codeHeight(blocks: SceneFileBlock[]): number {
  let h = CODE_PAD_V * 2;
  blocks.forEach((b, i) => {
    h += FILE_HEAD_H + b.lines.length * LINE_H;
    if (i > 0) h += FILE_GAP;
  });
  return h;
}

export function sceneHeight(spec: SceneSpec): number {
  return HEADER_H + (spec.blocks.length ? codeHeight(spec.blocks) : MID_H) + CAPTION_H;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function statusTag(status: string): string {
  return `<span class="tag tag-${esc(status)}">${esc(status)}</span>`;
}

function lineRow(l: SceneLine, lang: string | null): string {
  const cls = l.sign === "+" ? "add" : l.sign === "-" ? "del" : "ctx";
  const html = lang ? highlightLine(l.content, lang) : esc(l.content);
  return (
    `<div class="row ${cls}${l.spot ? " spot" : ""}">` +
    `<span class="gut">${l.num != null ? l.num : ""}</span>` +
    `<span class="sgn">${l.sign === " " ? "" : l.sign}</span>` +
    `<span class="txt">${html || "&nbsp;"}</span>` +
    `</div>`
  );
}

function fileBlock(b: SceneFileBlock): string {
  const lang = langForPath(b.path);
  const rows = b.lines.map((l) => lineRow(l, lang)).join("");
  return (
    `<div class="fileblock">` +
    `<div class="fhead">${statusTag(b.status)}<span class="fpath">${esc(b.path)}</span></div>` +
    `<div class="rows">${rows}</div>` +
    `</div>`
  );
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${FRAME_W}px;background:#0d1117;color:#e6edf3;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace}

.header{height:${HEADER_H}px;padding:34px 64px 0;overflow:hidden;
  background:linear-gradient(180deg,#161b22 0%,#0d1117 100%);border-bottom:1px solid #21262d}
.eyebrow-row{display:flex;align-items:center;gap:16px;margin-bottom:14px}
.eyebrow{font-size:22px;letter-spacing:2px;text-transform:uppercase;color:#768390;font-weight:700}
.pill{font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:1px;padding:5px 14px;border-radius:14px}
.pill-low{background:#12261e;color:#3fb950}
.pill-medium{background:#272115;color:#d29922}
.pill-high{background:#25171c;color:#f85149}
.title{font-size:48px;line-height:1.12;font-weight:800;letter-spacing:-0.5px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.intent{margin-top:10px;font-size:26px;line-height:1.3;color:#adbac7;
  display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}

.code{padding:${CODE_PAD_V}px 64px}
.fileblock{border-radius:12px;overflow:hidden;background:#161b22}
.fileblock+.fileblock{margin-top:${FILE_GAP}px}
.fhead{height:${FILE_HEAD_H}px;display:flex;align-items:center;gap:14px;padding:0 20px;background:#1c2430}
.fpath{font-family:ui-monospace,Menlo,Consolas,"DejaVu Sans Mono",monospace;font-size:24px;color:#adbac7}
.tag{font-size:17px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:3px 9px;border-radius:6px}
.tag-added{background:#12261e;color:#3fb950}
.tag-deleted{background:#25171c;color:#f85149}
.tag-modified{background:#11243e;color:#4493f8}
.tag-renamed,.tag-copied{background:#272115;color:#d29922}

.row{height:${LINE_H}px;display:flex;align-items:center;
  font-family:ui-monospace,Menlo,Consolas,"DejaVu Sans Mono",monospace;font-size:24px;line-height:${LINE_H}px;white-space:pre}
.gut{width:84px;flex:none;text-align:right;padding-right:18px;color:#586069;
  font-variant-numeric:tabular-nums;overflow:hidden}
.sgn{width:30px;flex:none;text-align:center}
.txt{flex:1;overflow:hidden;padding-right:24px}
.row.add{background:#12261e}.row.add .sgn{color:#3fb950}
.row.del{background:#25171c}.row.del .sgn{color:#f85149}
.code.spots .row{opacity:.38}
.code.spots .row.spot{opacity:1;box-shadow:inset 4px 0 0 #4493f8}

.caption{height:${CAPTION_H}px;display:flex;align-items:center;justify-content:center;
  text-align:center;padding:24px 120px;background:#161b22;border-top:1px solid #21262d}
.caption span{font-size:33px;line-height:1.34;color:#e6edf3;
  display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}

/* GitHub-dark syntax tokens */
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-section,.hljs-doctag{color:#ff7b72}
.hljs-string,.hljs-regexp,.hljs-meta .hljs-string,.hljs-addition{color:#a5d6ff}
.hljs-comment,.hljs-quote{color:#8b949e;font-style:italic}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-selector-id{color:#79c0ff}
.hljs-title,.hljs-title.function_,.hljs-title.class_{color:#d2a8ff}
.hljs-type,.hljs-class .hljs-title,.hljs-built_in{color:#ffa657}
.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable,.hljs-property,
.hljs-params,.hljs-selector-attr,.hljs-selector-class{color:#79c0ff}
.hljs-name,.hljs-tag,.hljs-selector-pseudo{color:#7ee787}
.hljs-meta{color:#8b949e}
`;

/** Build the full self-contained HTML for one scene. */
export function buildSceneHtml(spec: SceneSpec): string {
  const header =
    `<div class="header">` +
    `<div class="eyebrow-row">` +
    `<span class="eyebrow">${esc(spec.eyebrow)}</span>` +
    (spec.risk ? `<span class="pill pill-${spec.risk}">${esc(spec.risk)}</span>` : "") +
    `</div>` +
    `<div class="title">${esc(spec.title)}</div>` +
    (spec.intent ? `<div class="intent">${esc(spec.intent)}</div>` : "") +
    `</div>`;

  const code = spec.blocks.length
    ? `<div class="code${spec.hasSpots ? " spots" : ""}">${spec.blocks.map(fileBlock).join("")}</div>`
    : `<div class="code" style="height:${MID_H}px"></div>`;

  const caption = `<div class="caption"><span>${esc(spec.caption)}</span></div>`;

  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>` +
    `<body>${header}${code}${caption}` +
    // Report the rendered height so the pipeline can capture without clipping.
    `<script>document.title=String(document.documentElement.scrollHeight)</script>` +
    `</body></html>`
  );
}

/**
 * Turn a chapter's referenced files into renderable code blocks, mirroring the
 * interactive player's logic: prefer the hunks overlapping the referenced line
 * ranges, and spotlight the exact referenced lines.
 */
export function blocksForChapter(
  files: string[],
  refs: Map<string, Array<[number, number]>>,
  fileByPath: Map<string, DiffFile>,
  maxLines: number,
): { blocks: SceneFileBlock[]; hasSpots: boolean; truncated: boolean } {
  const blocks: SceneFileBlock[] = [];
  let hasSpots = false;
  let budget = maxLines;
  let truncated = false;

  for (const path of files) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const f = fileByPath.get(path);
    if (!f || f.binary || !f.hunks.length) continue;
    const fileRefs = refs.get(path) ?? null;
    const overlapping = fileRefs
      ? f.hunks.filter((h) => fileRefs.some(([s, e]) => h.newStart <= e && h.newStart + h.newLines >= s))
      : f.hunks;
    const hunks = overlapping.length ? overlapping : f.hunks;

    const lines: SceneLine[] = [];
    for (const h of hunks) {
      for (const l of h.lines) {
        if (budget <= 0) {
          truncated = true;
          break;
        }
        const spot =
          !!fileRefs &&
          l.newNumber != null &&
          fileRefs.some(([s, e]) => l.newNumber! >= s && l.newNumber! <= e);
        if (spot) hasSpots = true;
        lines.push({
          sign: l.type === "add" ? "+" : l.type === "del" ? "-" : " ",
          num: l.newNumber,
          content: l.content,
          spot,
        });
        budget--;
      }
      if (budget <= 0) break;
    }
    if (lines.length) blocks.push({ path: f.path, status: f.status, lines });
  }
  return { blocks, hasSpots, truncated };
}
