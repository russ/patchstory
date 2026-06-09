/**
 * @patchstory/renderer — turns a walkthrough bundle into a self-contained,
 * portable static site. Knows nothing about how the walkthrough was generated.
 *
 * Two output shapes:
 *  - Folder (default): index.html + data.js + assets/ + pr-walkthrough.json.
 *  - Single file (`renderSingleFile`): one .html with everything inlined — the
 *    "email it / drop it in a ticket" artifact.
 *
 * Data is embedded inline so the output works when opened directly over
 * file:// (where fetch() is blocked by the browser).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WalkthroughBundle } from "@patchstory/core";
import { WEB_CSS, WEB_HTML, WEB_JS } from "./assets.generated.ts";

export interface RenderOptions {
  /** ISO timestamp stamped into the document. */
  generatedAt?: string;
  /** Tool version, shown in the footer build stamp. */
  toolVersion?: string;
}

export interface RenderResult {
  outDir: string;
  files: string[];
  docId: string;
}

/** Stable, dependency-free id used to namespace localStorage per document. */
function computeDocId(bundle: WalkthroughBundle): string {
  const key = JSON.stringify({
    title: bundle.walkthrough.title,
    source: bundle.walkthrough.source,
    files: bundle.diff.files.map((f) => f.path),
  });
  // djb2
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return "ps_" + (h >>> 0).toString(36);
}

interface Prepared {
  embedded: unknown;
  walkthrough: WalkthroughBundle["walkthrough"];
  docId: string;
}

function prepare(bundle: WalkthroughBundle, opts: RenderOptions): Prepared {
  const docId = computeDocId(bundle);
  const walkthrough = opts.generatedAt
    ? { ...bundle.walkthrough, generated_at: opts.generatedAt }
    : bundle.walkthrough;
  const embedded = {
    walkthrough,
    diff: bundle.diff,
    docId,
    meta: { toolVersion: opts.toolVersion, generatedAt: opts.generatedAt },
  };
  return { embedded, walkthrough, docId };
}

const LINE_SEP_RE = new RegExp("[\\u2028\\u2029]", "g");

/** JSON safe to embed in JS. `inline` also neutralises `</script>` breakouts. */
function embedJson(value: unknown, inline: boolean): string {
  let s = JSON.stringify(value).replace(LINE_SEP_RE, (ch) =>
    ch.charCodeAt(0) === 0x2028 ? "\\u2028" : "\\u2029",
  );
  if (inline) s = s.replace(/<\/(script)/gi, "<\\/$1");
  return s;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render the portable folder form. */
export function renderWalkthrough(
  bundle: WalkthroughBundle,
  outDir: string,
  opts: RenderOptions = {},
): RenderResult {
  const { embedded, walkthrough, docId } = prepare(bundle, opts);

  const assetsDir = join(outDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  const html = WEB_HTML.replace(/__TITLE__/g, escapeHtml(walkthrough.title));
  const dataJs = `window.__PATCHSTORY__ = ${embedJson(embedded, false)};\n`;
  const canonical = JSON.stringify(walkthrough, null, 2) + "\n";

  const files: Array<[string, string]> = [
    [join(outDir, "index.html"), html],
    [join(outDir, "data.js"), dataJs],
    [join(assetsDir, "app.js"), WEB_JS],
    [join(assetsDir, "styles.css"), WEB_CSS],
    [join(outDir, "pr-walkthrough.json"), canonical],
  ];
  for (const [path, content] of files) writeFileSync(path, content, "utf8");

  return { outDir, files: files.map(([p]) => p), docId };
}

/** Render a single self-contained .html file (everything inlined). */
export function renderSingleFile(
  bundle: WalkthroughBundle,
  outFile: string,
  opts: RenderOptions = {},
): { file: string; docId: string } {
  const { embedded, walkthrough, docId } = prepare(bundle, opts);

  // app.js is an IIFE; neutralise any literal "</script" inside it too.
  const appJs = WEB_JS.replace(/<\/(script)/gi, "<\\/$1");

  const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(walkthrough.title)} · PatchStory</title>
<meta name="generator" content="PatchStory" />
<style>${WEB_CSS}</style>
</head>
<body>
<div id="app"></div>
<script>window.__PATCHSTORY__ = ${embedJson(embedded, true)};</script>
<script>${appJs}</script>
</body>
</html>
`;

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, html, "utf8");
  return { file: outFile, docId };
}
