/**
 * PatchStory static site client (vanilla TS, no framework).
 *
 * Reads the embedded walkthrough bundle from `window.__PATCHSTORY__` (injected
 * via data.js so it works over file://), and renders an interactive,
 * hash-routed single page: overview, chapter walkthrough, file list, and a
 * single-file diff explorer. State (reviewed, theme, view mode) lives in
 * localStorage keyed by the document id.
 */

import type {
  Chapter,
  DiffFile,
  DiffHunk,
  ParsedDiff,
  WalkthroughDocument,
} from "@patchstory/core";
import { highlightLine, langForPath } from "./highlight.ts";

interface Bundle {
  walkthrough: WalkthroughDocument;
  diff: ParsedDiff;
  docId: string;
  meta?: { toolVersion?: string; generatedAt?: string };
}

declare global {
  interface Window {
    __PATCHSTORY__?: Bundle;
  }
}

const bundle = window.__PATCHSTORY__;

/* ----------------------------- DOM helpers ------------------------------ */

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, any>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "html") node.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "dataset") {
      Object.assign(node.dataset, v);
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function clear(node: HTMLElement) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T | null;

/* ------------------------------ State ----------------------------------- */

const LS = {
  theme: "patchstory:theme",
  fileMode: "patchstory:filemode",
  reviewed: (id: string) => `patchstory:${id}:reviewed`,
};

const state = {
  reviewed: new Set<string>(),
  theme: "light" as "light" | "dark",
  fileMode: "unified" as "unified" | "split",
  search: "",
};

function loadState() {
  if (!bundle) return;
  try {
    const raw = localStorage.getItem(LS.reviewed(bundle.docId));
    if (raw) state.reviewed = new Set(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  const theme = localStorage.getItem(LS.theme);
  if (theme === "light" || theme === "dark") state.theme = theme;
  else if (window.matchMedia?.("(prefers-color-scheme: dark)").matches)
    state.theme = "dark";
  const fm = localStorage.getItem(LS.fileMode);
  if (fm === "unified" || fm === "split") state.fileMode = fm;
}

function saveReviewed() {
  if (!bundle) return;
  localStorage.setItem(
    LS.reviewed(bundle.docId),
    JSON.stringify([...state.reviewed]),
  );
}

function isReviewed(key: string) {
  return state.reviewed.has(key);
}
function setReviewed(key: string, on: boolean) {
  if (on) state.reviewed.add(key);
  else state.reviewed.delete(key);
  saveReviewed();
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
}

/* ------------------------------ Routing --------------------------------- */

interface Route {
  name: "overview" | "chapter" | "files" | "file" | "search";
  param?: string;
}

function parseRoute(): Route {
  const hash = location.hash.replace(/^#/, "");
  const [path] = hash.split("?");
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0 || parts[0] === "overview") return { name: "overview" };
  if (parts[0] === "chapter") return { name: "chapter", param: parts[1] };
  if (parts[0] === "files") return { name: "files" };
  if (parts[0] === "file")
    return { name: "file", param: decodeURIComponent(parts.slice(1).join("/")) };
  if (parts[0] === "search") return { name: "search" };
  return { name: "overview" };
}

function navigate(hash: string) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

/* ------------------------------ Lookups --------------------------------- */

const W = bundle?.walkthrough;
const DIFF = bundle?.diff;
const fileByPath = new Map<string, DiffFile>();
if (DIFF) for (const f of DIFF.files) fileByPath.set(f.path, f);

const chapterById = new Map<string, Chapter>();
if (W) for (const c of W.chapters) chapterById.set(c.id, c);

function orderedChapters(): Chapter[] {
  if (!W) return [];
  if (W.reviewer_path?.length) {
    const seen = new Set<string>();
    const out: Chapter[] = [];
    for (const id of W.reviewer_path) {
      const c = chapterById.get(id);
      if (c && !seen.has(id)) {
        out.push(c);
        seen.add(id);
      }
    }
    for (const c of W.chapters) if (!seen.has(c.id)) out.push(c);
    return out;
  }
  return W.chapters;
}

/* --------------------------- Small components --------------------------- */

function riskBadge(level: string): HTMLElement {
  return el("span", { class: `risk risk-${level}`, title: `Risk: ${level}` }, level);
}

function statusTag(f: DiffFile): HTMLElement {
  return el("span", { class: `ftag ftag-${f.status}` }, f.status);
}

function fileStatsEl(f: DiffFile): HTMLElement {
  return el(
    "span",
    { class: "fstats" },
    el("span", { class: "add" }, `+${f.additions}`),
    " ",
    el("span", { class: "del" }, `-${f.deletions}`),
  );
}

/* ----------------------------- Diff rendering --------------------------- */

function hunkRange(h: DiffHunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

// Lazily syntax-highlight hunks near the viewport (keeps big PRs fast). Driven
// by a viewport scan on render + scroll rather than IntersectionObserver, which
// is unreliable for the detached-then-attached nodes we build.
function highlightHunk(hunk: HTMLElement) {
  const cells = hunk.querySelectorAll<HTMLElement>("[data-hl]");
  for (const cell of cells) {
    const lang = cell.getAttribute("data-hl")!;
    const raw = cell.textContent ?? "";
    if (raw) cell.innerHTML = highlightLine(raw, lang);
    cell.removeAttribute("data-hl");
  }
  hunk.dataset.hlDone = "1";
}

let hlScheduled = false;
function scheduleHighlight() {
  if (hlScheduled) return;
  hlScheduled = true;
  requestAnimationFrame(() => {
    hlScheduled = false;
    highlightViewport();
  });
}

function highlightViewport() {
  const main = $("#main");
  if (!main) return;
  const vh = window.innerHeight;
  main.querySelectorAll<HTMLElement>(".hunk").forEach((hunk) => {
    if (hunk.dataset.hlDone || hunk.classList.contains("collapsed")) return;
    const r = hunk.getBoundingClientRect();
    if (r.bottom > -400 && r.top < vh + 400) highlightHunk(hunk);
  });
}

/** A content cell carrying raw text + (optional) language for lazy highlight. */
function contentCell(cls: string, content: string, lang: string | null): HTMLElement {
  const span = el("span", lang ? { class: cls, "data-hl": lang } : { class: cls }, content);
  return span;
}

function renderUnifiedHunk(h: DiffHunk, lang: string | null): HTMLElement {
  const body = el("div", { class: "diff-body unified" });
  for (const l of h.lines) {
    const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
    body.appendChild(
      el(
        "div",
        { class: `dl dl-${l.type}` },
        el("span", { class: "ln ln-old" }, l.oldNumber != null ? String(l.oldNumber) : ""),
        el("span", { class: "ln ln-new" }, l.newNumber != null ? String(l.newNumber) : ""),
        el("span", { class: "dl-sign" }, sign),
        contentCell("dl-content", l.content, lang),
      ),
    );
  }
  return body;
}

interface SplitRow {
  left?: { num: number | null; content: string; type: "del" | "context" };
  right?: { num: number | null; content: string; type: "add" | "context" };
}

function buildSplitRows(h: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: typeof h.lines = [];
  let adds: typeof h.lines = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const d = dels[i];
      const a = adds[i];
      rows.push({
        left: d ? { num: d.oldNumber, content: d.content, type: "del" } : undefined,
        right: a ? { num: a.newNumber, content: a.content, type: "add" } : undefined,
      });
    }
    dels = [];
    adds = [];
  };
  for (const l of h.lines) {
    if (l.type === "del") dels.push(l);
    else if (l.type === "add") adds.push(l);
    else {
      flush();
      rows.push({
        left: { num: l.oldNumber, content: l.content, type: "context" },
        right: { num: l.newNumber, content: l.content, type: "context" },
      });
    }
  }
  flush();
  return rows;
}

function renderSplitHunk(h: DiffHunk, lang: string | null): HTMLElement {
  const body = el("div", { class: "diff-body split" });
  for (const row of buildSplitRows(h)) {
    const left = row.left;
    const right = row.right;
    body.appendChild(
      el(
        "div",
        { class: "sr" },
        el("span", { class: "ln" }, left && left.num != null ? String(left.num) : ""),
        left
          ? contentCell(`sc dl-${left.type}`, left.content, lang)
          : el("span", { class: "sc dl-empty" }, ""),
        el("span", { class: "ln" }, right && right.num != null ? String(right.num) : ""),
        right
          ? contentCell(`sc dl-${right.type}`, right.content, lang)
          : el("span", { class: "sc dl-empty" }, ""),
      ),
    );
  }
  return body;
}

function setHunkCollapsed(hunk: HTMLElement, collapsed: boolean) {
  hunk.classList.toggle("collapsed", collapsed);
  const body = hunk.querySelector<HTMLElement>(".hunk-bodyhost");
  if (body) body.style.display = collapsed ? "none" : "";
  const caret = hunk.querySelector(".caret");
  if (caret) caret.textContent = collapsed ? "▸" : "▾";
}

function renderHunk(h: DiffHunk, lang: string | null, opts: { collapsed?: boolean } = {}): HTMLElement {
  const bodyHost = el(
    "div",
    { class: "hunk-bodyhost" },
    state.fileMode === "split" ? renderSplitHunk(h, lang) : renderUnifiedHunk(h, lang),
  );
  const caret = el("span", { class: "caret" });
  const hunk = el(
    "div",
    { class: "hunk" },
    el(
      "button",
      {
        class: "hunk-header",
        type: "button",
        onclick: () => {
          const collapse = !hunk.classList.contains("collapsed");
          setHunkCollapsed(hunk, collapse);
          if (!collapse) highlightHunk(hunk);
        },
      },
      caret,
      el("code", {}, hunkRange(h)),
      h.section ? el("span", { class: "hunk-section" }, h.section) : null,
    ),
    bodyHost,
  );
  setHunkCollapsed(hunk, opts.collapsed ?? false);
  return hunk;
}

/** Collapse or expand every hunk currently in the main view. */
function setAllHunks(collapsed: boolean) {
  const main = $("#main");
  if (!main) return;
  main.querySelectorAll<HTMLElement>(".hunk").forEach((h) => {
    setHunkCollapsed(h, collapsed);
    if (!collapsed) highlightHunk(h);
  });
}

function renderFileCard(f: DiffFile, opts: { collapsedHunks?: boolean } = {}): HTMLElement {
  const head = el(
    "div",
    { class: "filecard-head" },
    statusTag(f),
    el(
      "a",
      { class: "filecard-path", href: `#/file/${encodeURIComponent(f.path)}` },
      f.path,
    ),
    fileStatsEl(f),
  );
  const card = el("div", { class: "filecard", id: `file-${cssId(f.path)}` }, head);
  if (f.binary) {
    card.appendChild(el("div", { class: "binary-note" }, "Binary file — not shown."));
  } else if (f.hunks.length === 0) {
    card.appendChild(el("div", { class: "binary-note" }, "No textual changes (mode/metadata only)."));
  } else {
    const lang = langForPath(f.path);
    for (const h of f.hunks)
      card.appendChild(renderHunk(h, lang, { collapsed: opts.collapsedHunks }));
  }
  return card;
}

/** A small "Expand all / Collapse all" control for a diff section. */
function hunkToggleControl(): HTMLElement {
  return el(
    "div",
    { class: "hunk-actions" },
    el("button", { class: "linkbtn", type: "button", onclick: () => setAllHunks(false) }, "Expand all"),
    el("span", { class: "sep" }, "·"),
    el("button", { class: "linkbtn", type: "button", onclick: () => setAllHunks(true) }, "Collapse all"),
  );
}

function cssId(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "_");
}

/* ------------------------------- Sidebar -------------------------------- */

function renderSidebar(active: Route) {
  const nav = $("#sidebar-nav");
  if (!nav || !W) return;
  clear(nav);

  const chapters = orderedChapters();
  const reviewedCount = chapters.filter((c) => isReviewed(`chapter:${c.id}`)).length;

  nav.appendChild(
    el(
      "a",
      {
        class: "navlink" + (active.name === "overview" ? " active" : ""),
        href: "#/overview",
      },
      el("span", { class: "navlink-label" }, "Overview"),
    ),
  );

  nav.appendChild(
    el(
      "div",
      { class: "nav-section" },
      el("span", {}, "Chapters"),
      el("span", { class: "nav-progress" }, `${reviewedCount}/${chapters.length}`),
    ),
  );

  const q = state.search.trim().toLowerCase();
  chapters.forEach((c, i) => {
    if (q && !chapterMatches(c, q)) return;
    const reviewed = isReviewed(`chapter:${c.id}`);
    nav.appendChild(
      el(
        "a",
        {
          class:
            "navlink chapterlink" +
            (active.name === "chapter" && active.param === c.id ? " active" : "") +
            (reviewed ? " reviewed" : ""),
          href: `#/chapter/${c.id}`,
        },
        el("span", { class: "chapter-num" }, String(i + 1)),
        el("span", { class: "navlink-label" }, c.title),
        el("span", { class: `riskdot riskdot-${c.risk_level}`, title: c.risk_level }),
        reviewed ? el("span", { class: "check" }, "✓") : null,
      ),
    );
  });

  nav.appendChild(el("div", { class: "nav-section" }, el("span", {}, "Diff")));
  nav.appendChild(
    el(
      "a",
      {
        class: "navlink" + (active.name === "files" || active.name === "file" ? " active" : ""),
        href: "#/files",
      },
      el("span", { class: "navlink-label" }, "All files"),
      el("span", { class: "nav-count" }, String(DIFF?.files.length ?? 0)),
    ),
  );
}

function chapterMatches(c: Chapter, q: string): boolean {
  return (
    c.title.toLowerCase().includes(q) ||
    c.summary.toLowerCase().includes(q) ||
    (c.intent ?? "").toLowerCase().includes(q) ||
    c.files.some((f) => f.toLowerCase().includes(q))
  );
}

/* -------------------------------- Views --------------------------------- */

function viewOverview(): HTMLElement {
  const root = el("div", { class: "view view-overview" });
  if (!W) return root;

  root.appendChild(el("h1", { class: "doc-title" }, W.title));

  const src = W.source;
  const srcBits: string[] = [];
  if (src.repo) srcBits.push(src.repo);
  if (src.pr_number) srcBits.push(`PR #${src.pr_number}`);
  if (src.range) srcBits.push(src.range);
  else if (src.base || src.head) srcBits.push(`${src.base ?? "?"} → ${src.head ?? "?"}`);
  srcBits.push(sourceTypeLabel(src.type));
  root.appendChild(el("div", { class: "doc-source" }, srcBits.join(" · ")));

  root.appendChild(el("p", { class: "doc-summary" }, W.summary));

  if (W.start_here?.length) {
    const ul = el("ul", { class: "start-here-list" });
    for (const s of W.start_here) {
      ul.appendChild(
        el(
          "li",
          {},
          el("a", { href: `#/file/${encodeURIComponent(s.file)}` }, s.file),
          el("span", { class: "muted" }, ` — ${s.reason}`),
        ),
      );
    }
    root.appendChild(
      el(
        "div",
        { class: "callout start-here" },
        el("strong", {}, "Start here"),
        ul,
      ),
    );
  }

  root.appendChild(
    el(
      "div",
      { class: "stats" },
      statCard("Files changed", String(W.stats.files_changed)),
      statCard("Additions", `+${W.stats.additions}`, "add"),
      statCard("Deletions", `-${W.stats.deletions}`, "del"),
      statCard("Chapters", String(W.chapters.length)),
    ),
  );

  if (W.themes?.length) {
    root.appendChild(
      el(
        "div",
        { class: "themes" },
        el("h3", {}, "Main themes"),
        el("div", { class: "chips" }, ...W.themes.map((t) => el("span", { class: "chip" }, t))),
      ),
    );
  }

  root.appendChild(el("h3", { class: "section-title" }, "Suggested reviewer path"));
  const list = el("ol", { class: "reviewer-path" });
  orderedChapters().forEach((c) => {
    const reviewed = isReviewed(`chapter:${c.id}`);
    list.appendChild(
      el(
        "li",
        { class: reviewed ? "reviewed" : "" },
        el("a", { href: `#/chapter/${c.id}` }, c.title),
        " ",
        riskBadge(c.risk_level),
        el("span", { class: "muted" }, ` — ${c.files.length} file${c.files.length === 1 ? "" : "s"}`),
      ),
    );
  });
  root.appendChild(list);

  if (W.commits?.length) {
    const details = el("details", { class: "commits" });
    details.appendChild(
      el("summary", {}, `Commits (${W.commits.length})`),
    );
    const ul = el("ul", { class: "commit-list" });
    for (const subject of W.commits) ul.appendChild(el("li", {}, subject));
    details.appendChild(ul);
    root.appendChild(details);
  }

  return root;
}

function sourceTypeLabel(t: string): string {
  switch (t) {
    case "github_pr":
      return "GitHub PR";
    case "git_diff":
      return "git diff";
    case "commit_range":
      return "commit range";
    case "diff_file":
      return "diff file";
    default:
      return t;
  }
}

function statCard(label: string, value: string, kind?: string): HTMLElement {
  return el(
    "div",
    { class: "statcard" },
    el("div", { class: `statcard-value ${kind ?? ""}` }, value),
    el("div", { class: "statcard-label" }, label),
  );
}

function viewChapter(id?: string): HTMLElement {
  const root = el("div", { class: "view view-chapter" });
  if (!W) return root;
  const chapters = orderedChapters();
  const idx = chapters.findIndex((c) => c.id === id);
  const c = idx >= 0 ? chapters[idx] : chapters[0];
  if (!c) return el("div", { class: "view" }, el("p", {}, "No chapters."));

  root.appendChild(
    el(
      "div",
      { class: "chapter-top" },
      el("div", { class: "chapter-eyebrow" }, `Chapter ${idx >= 0 ? idx + 1 : 1} of ${chapters.length}`),
      riskBadge(c.risk_level),
    ),
  );
  root.appendChild(el("h1", { class: "chapter-title" }, c.title));

  if (c.intent) {
    root.appendChild(
      el("div", { class: "callout intent" }, el("strong", {}, "Why this exists: "), c.intent),
    );
  }
  root.appendChild(el("p", { class: "chapter-summary" }, c.summary));

  // Reviewed toggle
  const reviewedKey = `chapter:${c.id}`;
  const checkbox = el("input", {
    type: "checkbox",
    id: "reviewed-toggle",
    ...(isReviewed(reviewedKey) ? { checked: "checked" } : {}),
    onchange: (e: Event) => {
      setReviewed(reviewedKey, (e.target as HTMLInputElement).checked);
      renderSidebar(parseRoute());
    },
  });
  root.appendChild(
    el("label", { class: "reviewed-box", for: "reviewed-toggle" }, checkbox, " Mark chapter reviewed"),
  );

  // Related commits (when commit→file mapping is available)
  if (c.related_commits?.length) {
    root.appendChild(
      el(
        "div",
        { class: "panel" },
        el("h3", {}, "Related commits"),
        el("ul", { class: "commit-list" }, ...c.related_commits.map((s) => el("li", {}, s))),
      ),
    );
  }

  // Files involved
  if (c.files.length) {
    const fl = el("div", { class: "panel" }, el("h3", {}, "Files involved"));
    const ul = el("ul", { class: "file-involved" });
    for (const path of c.files) {
      const f = fileByPath.get(path);
      ul.appendChild(
        el(
          "li",
          {},
          f ? statusTag(f) : null,
          el("a", { href: `#/file/${encodeURIComponent(path)}` }, path),
          f ? fileStatsEl(f) : null,
        ),
      );
    }
    fl.appendChild(ul);
    root.appendChild(fl);
  }

  // Two-column notes
  const cols = el("div", { class: "note-cols" });
  if (c.review_notes?.length) {
    cols.appendChild(
      el(
        "div",
        { class: "panel" },
        el("h3", {}, "Reviewer questions"),
        el("ul", { class: "notes" }, ...c.review_notes.map((n) => el("li", {}, n))),
      ),
    );
  }
  if (c.verification_steps?.length) {
    cols.appendChild(
      el(
        "div",
        { class: "panel" },
        el("h3", {}, "Verify"),
        el("ol", { class: "notes" }, ...c.verification_steps.map((n) => el("li", {}, n))),
      ),
    );
  }
  if (cols.childNodes.length) root.appendChild(cols);

  // Relevant diff hunks — render the hunks for files in this chapter.
  root.appendChild(
    el(
      "div",
      { class: "diff-head" },
      el("h3", {}, "Relevant changes"),
      el("div", { class: "diff-controls" }, hunkToggleControl(), fileModeToggle()),
    ),
  );
  const diffWrap = el("div", { class: "chapter-diff" });
  for (const path of c.files) {
    const f = fileByPath.get(path);
    if (f) diffWrap.appendChild(renderFileCard(f));
  }
  if (!diffWrap.childNodes.length)
    diffWrap.appendChild(el("p", { class: "muted" }, "No diff hunks for this chapter."));
  root.appendChild(diffWrap);

  // Prev / next
  const nav = el("div", { class: "chapter-nav" });
  const prev = idx > 0 ? chapters[idx - 1] : null;
  const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;
  nav.appendChild(
    prev
      ? el("a", { class: "btn ghost", href: `#/chapter/${prev.id}` }, "← ", prev.title)
      : el("span", {}),
  );
  nav.appendChild(
    next
      ? el("a", { class: "btn", href: `#/chapter/${next.id}` }, next.title, " →")
      : el("a", { class: "btn", href: "#/files" }, "Browse all files →"),
  );
  root.appendChild(nav);

  return root;
}

function fileModeToggle(): HTMLElement {
  const mk = (mode: "unified" | "split", label: string) =>
    el(
      "button",
      {
        type: "button",
        class: "seg" + (state.fileMode === mode ? " active" : ""),
        onclick: () => {
          if (state.fileMode === mode) return;
          state.fileMode = mode;
          localStorage.setItem(LS.fileMode, mode);
          render();
        },
      },
      label,
    );
  return el("div", { class: "segmented" }, mk("unified", "Unified"), mk("split", "Split"));
}

function viewFiles(): HTMLElement {
  const root = el("div", { class: "view view-files" });
  if (!DIFF) return root;

  root.appendChild(
    el(
      "div",
      { class: "diff-head" },
      el("h1", {}, "All files"),
      el(
        "div",
        { class: "files-controls" },
        hunkToggleControl(),
        fileModeToggle(),
      ),
    ),
  );

  const filterInput = el("input", {
    type: "text",
    class: "filter-input",
    placeholder: "Filter files by path…",
    value: state.search,
    oninput: (e: Event) => {
      const q = (e.target as HTMLInputElement).value.toLowerCase();
      for (const f of DIFF.files) {
        const row = root.querySelector(`[data-path="${cssAttr(f.path)}"]`) as HTMLElement | null;
        if (row) row.style.display = !q || f.path.toLowerCase().includes(q) ? "" : "none";
      }
    },
  });
  root.appendChild(el("div", { class: "filterbar" }, filterInput));

  const listing = el("div", { class: "file-listing" });
  for (const f of DIFF.files) {
    const reviewedKey = `file:${f.path}`;
    const reviewed = isReviewed(reviewedKey);
    const row = el(
      "div",
      { class: "file-row" + (reviewed ? " reviewed" : ""), dataset: { path: f.path } },
      el(
        "input",
        {
          type: "checkbox",
          title: "Mark file reviewed",
          ...(reviewed ? { checked: "checked" } : {}),
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            setReviewed(reviewedKey, on);
            row.classList.toggle("reviewed", on);
          },
        },
      ),
      statusTag(f),
      el("a", { class: "file-row-path", href: `#/file/${encodeURIComponent(f.path)}` }, f.path),
      fileStatsEl(f),
    );
    listing.appendChild(row);
  }
  root.appendChild(listing);

  // Inline full diff of every file, for scroll-through reading.
  const all = el("div", { class: "all-diffs" });
  for (const f of DIFF.files) all.appendChild(renderFileCard(f, { collapsedHunks: false }));
  root.appendChild(all);

  return root;
}

function cssAttr(s: string): string {
  return s.replace(/"/g, '\\"');
}

function viewFile(path?: string): HTMLElement {
  const root = el("div", { class: "view view-file" });
  if (!DIFF || !path) return root;
  const f = fileByPath.get(path);
  if (!f) {
    root.appendChild(el("p", {}, `File not found in diff: ${path}`));
    root.appendChild(el("a", { class: "btn ghost", href: "#/files" }, "← All files"));
    return root;
  }

  root.appendChild(el("a", { class: "backlink", href: "#/files" }, "← All files"));
  root.appendChild(
    el(
      "div",
      { class: "diff-head" },
      el("h1", { class: "file-title" }, f.path),
      el("div", { class: "diff-controls" }, hunkToggleControl(), fileModeToggle()),
    ),
  );

  // Chapters that reference this file
  const refs = (W?.chapters ?? []).filter((c) => c.files.includes(f.path));
  if (refs.length) {
    root.appendChild(
      el(
        "div",
        { class: "file-chapters" },
        el("span", { class: "muted" }, "Discussed in: "),
        ...refs.map((c) => el("a", { class: "chip chip-link", href: `#/chapter/${c.id}` }, c.title)),
      ),
    );
  }

  const reviewedKey = `file:${f.path}`;
  root.appendChild(
    el(
      "label",
      { class: "reviewed-box" },
      el("input", {
        type: "checkbox",
        ...(isReviewed(reviewedKey) ? { checked: "checked" } : {}),
        onchange: (e: Event) => setReviewed(reviewedKey, (e.target as HTMLInputElement).checked),
      }),
      " Mark file reviewed",
    ),
  );

  root.appendChild(renderFileCard(f));
  return root;
}

function viewSearch(): HTMLElement {
  const root = el("div", { class: "view view-search" });
  const q = state.search.trim().toLowerCase();
  root.appendChild(el("h1", {}, q ? `Search: “${state.search}”` : "Search"));
  if (!q) {
    root.appendChild(el("p", { class: "muted" }, "Type in the search box above."));
    return root;
  }

  const chapterHits = orderedChapters().filter((c) => chapterMatches(c, q));
  const fileHits = (DIFF?.files ?? []).filter(
    (f) => f.path.toLowerCase().includes(q) || fileContentMatches(f, q),
  );

  root.appendChild(el("h3", {}, `Chapters (${chapterHits.length})`));
  if (chapterHits.length) {
    const ul = el("ul", { class: "search-list" });
    for (const c of chapterHits)
      ul.appendChild(
        el("li", {}, el("a", { href: `#/chapter/${c.id}` }, c.title), " ", riskBadge(c.risk_level)),
      );
    root.appendChild(ul);
  } else root.appendChild(el("p", { class: "muted" }, "No matching chapters."));

  root.appendChild(el("h3", {}, `Files (${fileHits.length})`));
  if (fileHits.length) {
    const ul = el("ul", { class: "search-list" });
    for (const f of fileHits)
      ul.appendChild(
        el(
          "li",
          {},
          statusTag(f),
          el("a", { href: `#/file/${encodeURIComponent(f.path)}` }, f.path),
          fileStatsEl(f),
        ),
      );
    root.appendChild(ul);
  } else root.appendChild(el("p", { class: "muted" }, "No matching files."));

  return root;
}

function fileContentMatches(f: DiffFile, q: string): boolean {
  for (const h of f.hunks)
    for (const l of h.lines) if (l.content.toLowerCase().includes(q)) return true;
  return false;
}

/* ------------------------------- Render --------------------------------- */

function render() {
  const route = parseRoute();
  // Close the mobile drawer on any navigation.
  $("#app")?.classList.remove("nav-open");
  const main = $("#main");
  if (!main) return;
  clear(main);

  let view: HTMLElement;
  switch (route.name) {
    case "chapter":
      view = viewChapter(route.param);
      break;
    case "files":
      view = viewFiles();
      break;
    case "file":
      view = viewFile(route.param);
      break;
    case "search":
      view = viewSearch();
      break;
    default:
      view = viewOverview();
  }
  main.appendChild(view);
  main.scrollTop = 0;
  renderSidebar(route);
  updateProgress();
  scheduleHighlight();
}

function updateProgress() {
  const host = $("#progress");
  if (!host || !W) return;
  const total = W.chapters.length;
  const done = W.chapters.filter((c) => isReviewed(`chapter:${c.id}`)).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  host.title = `${done}/${total} chapters reviewed`;
  clear(host);
  host.appendChild(el("div", { class: "progress-bar" }, el("div", { class: "progress-fill", style: `width:${pct}%` })));
  host.appendChild(el("span", { class: "progress-text" }, `${done}/${total}`));
}

/* ------------------------- Header interactions -------------------------- */

function buildSummaryMarkdown(): string {
  if (!W) return "";
  const lines: string[] = [];
  lines.push(`# ${W.title}`, "");
  lines.push(W.summary, "");
  lines.push(
    `**${W.stats.files_changed}** files changed · **+${W.stats.additions} / -${W.stats.deletions}**`,
    "",
  );
  for (const c of orderedChapters()) {
    lines.push(`## ${c.title}  _(risk: ${c.risk_level})_`);
    if (c.intent) lines.push(`_${c.intent}_`);
    lines.push(c.summary);
    if (c.files.length) lines.push("", "Files: " + c.files.map((f) => `\`${f}\``).join(", "));
    if (c.review_notes?.length) {
      lines.push("", "Reviewer questions:");
      for (const n of c.review_notes) lines.push(`- ${n}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function copySummary(btn: HTMLElement) {
  const md = buildSummaryMarkdown();
  let ok = false;
  try {
    await navigator.clipboard.writeText(md);
    ok = true;
  } catch {
    const ta = el("textarea", { style: "position:fixed;opacity:0" });
    ta.value = md;
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
  }
  const old = btn.textContent;
  btn.textContent = ok ? "Copied!" : "Copy failed";
  setTimeout(() => (btn.textContent = old), 1500);
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  localStorage.setItem(LS.theme, state.theme);
  applyTheme();
  const btn = $("#theme-btn");
  if (btn) btn.textContent = state.theme === "dark" ? "☀" : "☾";
}

/* ------------------------- Keyboard & help ------------------------------ */

function gotoChapterDelta(delta: number) {
  const chapters = orderedChapters();
  if (!chapters.length) return;
  const route = parseRoute();
  const idx = route.name === "chapter" ? chapters.findIndex((c) => c.id === route.param) : -1;
  let next = idx < 0 ? (delta > 0 ? 0 : chapters.length - 1) : idx + delta;
  next = Math.max(0, Math.min(chapters.length - 1, next));
  navigate(`#/chapter/${chapters[next].id}`);
}

function toggleCurrentReviewed() {
  const route = parseRoute();
  if (route.name === "chapter") {
    const c = orderedChapters().find((x) => x.id === route.param) ?? orderedChapters()[0];
    if (!c) return;
    setReviewed(`chapter:${c.id}`, !isReviewed(`chapter:${c.id}`));
    render();
  } else if (route.name === "file" && route.param) {
    setReviewed(`file:${route.param}`, !isReviewed(`file:${route.param}`));
    render();
  }
}

function setHelp(open: boolean) {
  const o = $("#help-overlay");
  if (o) o.style.display = open ? "flex" : "none";
}

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  const typing =
    !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  if (e.key === "Escape") {
    setHelp(false);
    $("#app")?.classList.remove("nav-open");
    if (typing) (t as HTMLInputElement).blur();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case "j": gotoChapterDelta(1); break;
    case "k": gotoChapterDelta(-1); break;
    case "/": e.preventDefault(); $<HTMLInputElement>(".search")?.focus(); break;
    case "t": toggleTheme(); break;
    case "e": setAllHunks(false); break;
    case "c": setAllHunks(true); break;
    case "r": toggleCurrentReviewed(); break;
    case "?": setHelp(true); break;
  }
}

function kbdRow(keys: string, desc: string): HTMLElement {
  return el("div", { class: "help-row" }, el("kbd", {}, keys), el("span", {}, desc));
}

function buildHelpOverlay(): HTMLElement {
  return el(
    "div",
    {
      class: "help-overlay",
      id: "help-overlay",
      style: "display:none",
      onclick: (e: Event) => {
        if (e.target === e.currentTarget) setHelp(false);
      },
    },
    el(
      "div",
      { class: "help-card" },
      el("h3", {}, "Keyboard shortcuts"),
      el(
        "div",
        { class: "help-list" },
        kbdRow("j / k", "Next / previous chapter"),
        kbdRow("/", "Focus search"),
        kbdRow("e / c", "Expand / collapse all hunks"),
        kbdRow("r", "Toggle reviewed (current chapter/file)"),
        kbdRow("t", "Toggle light / dark"),
        kbdRow("?", "Show this help"),
        kbdRow("Esc", "Close"),
      ),
    ),
  );
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function buildFooter(): HTMLElement {
  const meta = bundle?.meta ?? {};
  const gen = W?.generator ?? "none";
  const when = W?.generated_at ?? meta.generatedAt;
  const ver = meta.toolVersion ? `v${meta.toolVersion}` : "";
  return el(
    "footer",
    { class: "appfoot" },
    el("span", {}, `PatchStory ${ver}`.trim()),
    el("span", { class: "sep" }, "·"),
    el("span", {}, `generator: ${gen}`),
    when ? el("span", { class: "sep" }, "·") : null,
    when ? el("span", {}, `generated ${formatWhen(when)}`) : null,
    el("span", { class: "foot-spacer" }),
    el("button", { class: "linkbtn", type: "button", onclick: () => setHelp(true) }, "shortcuts ?"),
  );
}

function mountChrome() {
  const app = $("#app");
  if (!app) return;

  const search = el("input", {
    type: "search",
    class: "search",
    placeholder: "Search chapters & files…",
    oninput: (e: Event) => {
      state.search = (e.target as HTMLInputElement).value;
      renderSidebar(parseRoute());
      if (state.search.trim()) {
        if (parseRoute().name !== "search") navigate("#/search");
        else render();
      }
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter" && state.search.trim()) navigate("#/search");
    },
  });

  const themeBtn = el(
    "button",
    {
      class: "iconbtn",
      id: "theme-btn",
      type: "button",
      title: "Toggle light/dark (t)",
      onclick: () => toggleTheme(),
    },
    state.theme === "dark" ? "☀" : "☾",
  );

  const copyBtn = el(
    "button",
    { class: "btn small copybtn", type: "button", onclick: (e: Event) => copySummary(e.currentTarget as HTMLElement) },
    "Copy summary",
  );

  // Mobile drawer toggle (hidden on wide screens via CSS).
  const menuBtn = el(
    "button",
    {
      class: "iconbtn menubtn",
      type: "button",
      title: "Chapters",
      "aria-label": "Toggle chapter navigation",
      onclick: () => app.classList.toggle("nav-open"),
    },
    "☰",
  );

  const header = el(
    "header",
    { class: "topbar" },
    menuBtn,
    el(
      "a",
      { class: "brand", href: "#/overview" },
      el("span", { class: "brand-mark" }, "❯_"),
      el("span", { class: "brand-name" }, "PatchStory"),
    ),
    el("div", { class: "topbar-spacer" }),
    search,
    el("div", { class: "progress", id: "progress" }),
    copyBtn,
    themeBtn,
  );

  const sidebar = el(
    "aside",
    { class: "sidebar" },
    el("nav", { class: "sidebar-nav", id: "sidebar-nav" }),
  );

  const main = el("main", { class: "main", id: "main" });
  main.addEventListener("scroll", scheduleHighlight, { passive: true });
  window.addEventListener("resize", scheduleHighlight, { passive: true });

  // Tapping the dimmed backdrop closes the mobile drawer.
  const backdrop = el("div", {
    class: "backdrop",
    onclick: () => app.classList.remove("nav-open"),
  });

  app.appendChild(header);
  app.appendChild(el("div", { class: "layout" }, sidebar, main));
  app.appendChild(buildFooter());
  app.appendChild(backdrop);
  app.appendChild(buildHelpOverlay());
}

/* -------------------------------- Boot ---------------------------------- */

function boot() {
  if (!bundle || !W || !DIFF) {
    document.body.appendChild(
      el(
        "div",
        { class: "fatal" },
        "No walkthrough data found. This page expects data.js to define window.__PATCHSTORY__.",
      ),
    );
    return;
  }
  loadState();
  applyTheme();
  mountChrome();
  window.addEventListener("hashchange", render);
  window.addEventListener("keydown", onKey);
  render();
}

boot();
