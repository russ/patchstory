/**
 * The heuristic ("none") generator. No AI involved.
 *
 * It produces a genuinely useful walkthrough by grouping changed files into
 * thematic chapters (data model, source modules, tests, docs, config, styles),
 * ordering them into a sensible reading path, and attaching review questions,
 * risk levels, and verification steps derived from simple file-type and
 * sensitivity heuristics. This is what guarantees the tool is useful even with
 * no API key.
 */

import { WALKTHROUGH_VERSION } from "../types.ts";
import type {
  Chapter,
  DiffFile,
  DiffHunkRef,
  RiskLevel,
  StartHere,
  WalkthroughDocument,
} from "../types.ts";
import type { CommitInfo } from "../git.ts";
import type { DiffAnalysisInput, WalkthroughGenerator } from "./types.ts";

type Category = "data" | "source" | "styles" | "tests" | "config" | "docs";

interface CategoryMeta {
  order: number;
  intent: string;
}

const CATEGORY_META: Record<Category, CategoryMeta> = {
  data: { order: 10, intent: "Evolve the data model and persistence layer." },
  source: { order: 20, intent: "Implement the core application changes." },
  styles: { order: 30, intent: "Adjust presentation and styling." },
  tests: { order: 40, intent: "Validate the new behavior with tests." },
  config: { order: 50, intent: "Adjust build, tooling, or runtime configuration." },
  docs: { order: 60, intent: "Document the change." },
};

const SENSITIVE_RE =
  /(auth|login|password|secret|token|crypto|payment|billing|stripe|migrat|security|permission|acl|admin|session|oauth)/i;

// More specific chapter intents derived from common source directory names.
const DIR_INTENT: { re: RegExp; intent: string }[] = [
  { re: /(^|\/)(models?|entities|domain)(\/|$)/i, intent: "Changes to the data model / domain objects." },
  { re: /(^|\/)(migrations?|migrate|db)(\/|$)/i, intent: "Database schema / migration changes." },
  { re: /(^|\/)(services?)(\/|$)/i, intent: "Service-layer logic changes." },
  { re: /(^|\/)(controllers?|actions?|api|routes?|handlers?|endpoints?)(\/|$)/i, intent: "API / request-handling changes." },
  { re: /(^|\/)(workers?|jobs?|tasks?|queues?)(\/|$)/i, intent: "Background job / worker changes." },
  { re: /(^|\/)(channels?|sockets?|realtime|ws)(\/|$)/i, intent: "Realtime / channel changes." },
  { re: /(^|\/)(components?)(\/|$)/i, intent: "UI component changes." },
  { re: /(^|\/)(pages?|views?|screens?)(\/|$)/i, intent: "Page / view changes." },
  { re: /(^|\/)(stores?|state|reducers?)(\/|$)/i, intent: "Client state / store changes." },
  { re: /(^|\/)(composables?|hooks?)(\/|$)/i, intent: "Reusable logic (composables / hooks) changes." },
  { re: /(^|\/)(serializers?|presenters?)(\/|$)/i, intent: "Serialization / response-shaping changes." },
  { re: /(^|\/)(queries|operations?|graph|graphql|resolvers?)(\/|$)/i, intent: "Query / operation changes." },
  { re: /(^|\/)(middlewares?)(\/|$)/i, intent: "Middleware changes." },
  { re: /(^|\/)(lib|utils?|helpers?|shared|common)(\/|$)/i, intent: "Shared utility changes." },
];

function intentFor(category: Category, label: string): string {
  if (category === "source") {
    for (const { re, intent } of DIR_INTENT) if (re.test(label + "/")) return intent;
  }
  return CATEGORY_META[category].intent;
}

// Path-token noise to ignore when looking for a recurring "feature" token.
const TOKEN_STOP = new Set([
  "src", "app", "lib", "test", "tests", "spec", "specs", "index", "main",
  "backend", "frontend", "components", "component", "pages", "page", "models",
  "model", "services", "service", "api", "config", "utils", "util", "helpers",
  "styles", "style", "types", "type", "actions", "action", "stores", "store",
  "the", "new", "old", "core",
]);

/** The token recurring across the most file paths — a likely feature name. */
function dominantToken(files: DiffFile[]): { token: string; count: number } | null {
  const counts = new Map<string, Set<number>>();
  files.forEach((f, i) => {
    const tokens = new Set(
      f.path
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !TOKEN_STOP.has(t) && !/^\d+$/.test(t)),
    );
    for (const t of tokens) {
      let s = counts.get(t);
      if (!s) counts.set(t, (s = new Set()));
      s.add(i);
    }
  });
  let best: { token: string; count: number } | null = null;
  for (const [token, idxs] of counts) {
    if (!best || idxs.size > best.count) best = { token, count: idxs.size };
  }
  const threshold = Math.max(3, Math.ceil(files.length * 0.25));
  return best && best.count >= threshold ? best : null;
}

/** Commit subjects whose files overlap this chapter (newest first). */
function relatedCommits(chapterFiles: string[], commits?: CommitInfo[]): string[] {
  if (!commits?.length) return [];
  const set = new Set(chapterFiles);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of commits) {
    if (c.files.length && c.files.some((f) => set.has(f)) && !seen.has(c.subject)) {
      seen.add(c.subject);
      out.push(c.subject);
    }
  }
  return out.slice(0, 6);
}

/** The handful of files a reviewer should read first. */
function computeStartHere(files: DiffFile[]): StartHere[] {
  const scored = files.map((f) => {
    const churn = f.additions + f.deletions;
    let score = churn;
    let reason = "largest change in the PR";
    if (isData(f.path)) {
      score += 500;
      reason = "schema / migration — read this first";
    } else if (SENSITIVE_RE.test(f.path)) {
      score += 250;
      reason = "security-sensitive and high-churn";
    }
    return { f, score, churn, reason };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter((s) => s.churn > 0 || isData(s.f.path))
    .slice(0, 3)
    .map((s) => ({
      file: s.f.path,
      reason: `${s.reason} (+${s.f.additions}/-${s.f.deletions})`,
    }));
}

function isTest(p: string): boolean {
  return (
    /(^|\/)(test|tests|spec|specs|__tests__)(\/|$)/i.test(p) ||
    /\.(test|spec)\.[a-z0-9]+$/i.test(p)
  );
}
function isDoc(p: string): boolean {
  return /\.(md|mdx|rst|txt)$/i.test(p) || /(^|\/)docs?(\/|$)/i.test(p);
}
function isStyle(p: string): boolean {
  return /\.(css|scss|sass|less)$/i.test(p);
}
function isData(p: string): boolean {
  return (
    /(^|\/)(migrat|migrations|db)(\/|$)/i.test(p) ||
    /schema\.(rb|sql|prisma|graphql)$/i.test(p) ||
    /\.sql$/i.test(p)
  );
}
function isConfig(p: string): boolean {
  const base = p.split("/").pop() ?? p;
  return (
    /(^|\/)\.github(\/|$)/i.test(p) ||
    /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig.*\.json|Dockerfile|Makefile|\.env.*|\.gitignore|\.eslintrc.*|\.prettierrc.*)$/i.test(
      base,
    ) ||
    /\.(ya?ml|toml|ini|cfg|lock)$/i.test(base) ||
    /\.config\.[a-z]+$/i.test(base)
  );
}

function categorize(p: string): Category {
  if (isTest(p)) return "tests";
  if (isData(p)) return "data";
  if (isDoc(p)) return "docs";
  if (isStyle(p)) return "styles";
  if (isConfig(p)) return "config";
  return "source";
}

// Source files are grouped by directory with *adaptive depth*: a directory
// that gathers too many files is split one level deeper, repeatedly, so a
// massive PR breaks into navigable chapters instead of one giant "src" bucket.
const MAX_GROUP = 12;
const MAX_DEPTH = 6;

function dirSegments(p: string): string[] {
  return p.split("/").slice(0, -1);
}

/** Longest shared directory path across a set of files. */
function commonDirOf(files: DiffFile[]): string {
  if (!files.length) return "";
  let prefix = dirSegments(files[0].path);
  for (const f of files.slice(1)) {
    const segs = dirSegments(f.path);
    let i = 0;
    while (i < prefix.length && i < segs.length && prefix[i] === segs[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.join("/");
}

interface SourceGroup {
  label: string;
  files: DiffFile[];
}

/** Recursively bucket source files by directory prefix, deepening big groups.
 *  Final groups are labelled by the common directory of their files (more
 *  specific than the prefix used to bucket them). */
function splitSourceGroups(files: DiffFile[]): SourceGroup[] {
  const rec = (fs: DiffFile[], depth: number): SourceGroup[] => {
    const map = new Map<string, DiffFile[]>();
    for (const f of fs) {
      const key = dirSegments(f.path).slice(0, depth).join("/") || "(root)";
      let g = map.get(key);
      if (!g) map.set(key, (g = []));
      g.push(f);
    }
    const out: SourceGroup[] = [];
    for (const [key, group] of map) {
      const canDeepen =
        group.length > MAX_GROUP &&
        depth < MAX_DEPTH &&
        group.some((f) => dirSegments(f.path).length > depth);
      if (canDeepen) out.push(...rec(group, depth + 1));
      else out.push({ label: commonDirOf(group) || key, files: group });
    }
    return out;
  };
  return rec(files, 1);
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "chapter"
  );
}

function chapterTitle(category: Category, label: string): string {
  switch (category) {
    case "data":
      return "Data model & migrations";
    case "tests":
      return "Tests & specifications";
    case "config":
      return "Build & configuration";
    case "docs":
      return "Documentation";
    case "styles":
      return "Styling";
    default:
      return label;
  }
}

function riskForFiles(files: DiffFile[]): RiskLevel {
  let changed = 0;
  let sensitive = false;
  let wholeFileRemoved = false;
  for (const f of files) {
    changed += f.additions + f.deletions;
    if (SENSITIVE_RE.test(f.path)) sensitive = true;
    if (f.status === "deleted") wholeFileRemoved = true;
  }
  if (sensitive || changed > 200 || wholeFileRemoved) return "high";
  if (changed > 40) return "medium";
  return "low";
}

function hunkRefs(files: DiffFile[]): DiffHunkRef[] {
  const refs: DiffHunkRef[] = [];
  for (const f of files) {
    for (const h of f.hunks) {
      refs.push({
        file: f.path,
        start_line: h.newStart,
        end_line: h.newStart + Math.max(h.newLines, 1) - 1,
        summary: h.section || undefined,
      });
    }
  }
  return refs;
}

function reviewNotes(category: Category, files: DiffFile[]): string[] {
  const notes: string[] = [];
  const anyDeleted = files.some((f) => f.status === "deleted");
  const anyRenamed = files.some((f) => f.status === "renamed");
  const anySensitive = files.some((f) => SENSITIVE_RE.test(f.path));

  switch (category) {
    case "data":
      notes.push("Confirm the migration is reversible and safe to run on production data.");
      notes.push("Check for backfills, default values, and null-handling on existing rows.");
      break;
    case "tests":
      notes.push("Do the new tests actually fail without the corresponding change?");
      notes.push("Are edge cases and failure paths covered, not just the happy path?");
      break;
    case "config":
      notes.push("Do version bumps or config changes affect other environments (CI, prod)?");
      break;
    case "docs":
      notes.push("Does the documentation match the actual behavior of the code?");
      break;
    case "styles":
      notes.push("Check the change visually in both light and dark themes / key breakpoints.");
      break;
    default:
      notes.push("Review the changed logic for correctness and edge cases.");
      break;
  }
  if (anyDeleted) notes.push("Confirm removed code is genuinely unused (no remaining callers).");
  if (anyRenamed) notes.push("Verify all references were updated after the rename/move.");
  if (anySensitive)
    notes.push("Security-sensitive path: scrutinize auth, input validation, and secrets handling.");
  return notes;
}

function verificationSteps(category: Category): string[] {
  switch (category) {
    case "data":
      return [
        "Run the migration forward, then roll it back, on a copy of the database.",
        "Verify existing records still load correctly after the migration.",
      ];
    case "tests":
      return ["Run the test suite and confirm the new tests pass."];
    case "config":
      return ["Build the project from a clean checkout and run it once."];
    case "docs":
      return ["Skim the rendered docs for accuracy and broken links."];
    case "styles":
      return ["Load the affected screens and visually verify the styling."];
    default:
      return [
        "Exercise the changed code paths (manually or via tests).",
        "Run the relevant test suite.",
      ];
  }
}

function summarizeFiles(files: DiffFile[]): string {
  const adds = files.reduce((a, f) => a + f.additions, 0);
  const dels = files.reduce((a, f) => a + f.deletions, 0);
  const names = files.map((f) => f.path.split("/").pop()).slice(0, 5);
  const more = files.length > 5 ? `, +${files.length - 5} more` : "";
  return `${files.length} file${files.length === 1 ? "" : "s"} changed (+${adds}/-${dels}): ${names.join(", ")}${more}.`;
}

export class NoneGenerator implements WalkthroughGenerator {
  readonly name = "none";

  async generate(input: DiffAnalysisInput): Promise<WalkthroughDocument> {
    const { diff, source, title, stats, commits } = input;

    // Split files into categories; source files are further split by directory
    // with adaptive depth so big PRs become navigable.
    const sourceFiles: DiffFile[] = [];
    const cat: Record<Exclude<Category, "source">, DiffFile[]> = {
      data: [],
      tests: [],
      styles: [],
      config: [],
      docs: [],
    };
    for (const f of diff.files) {
      const c = categorize(f.path);
      if (c === "source") sourceFiles.push(f);
      else cat[c].push(f);
    }

    interface Entry {
      order: number;
      category: Category;
      label: string;
      files: DiffFile[];
    }
    const entries: Entry[] = [];
    const add = (category: Category, label: string, files: DiffFile[]) => {
      if (files.length) entries.push({ order: CATEGORY_META[category].order, category, label, files });
    };

    add("data", "data", cat.data);
    for (const g of splitSourceGroups(sourceFiles)) add("source", g.label, g.files);
    add("styles", "styles", cat.styles);
    add("tests", "tests", cat.tests);
    add("config", "config", cat.config);
    add("docs", "docs", cat.docs);

    entries.sort((a, b) =>
      a.order !== b.order ? a.order - b.order : a.label.localeCompare(b.label),
    );

    const usedIds = new Set<string>();
    const chapters: Chapter[] = entries.map((e) => {
      let id = slug((e.category === "source" ? e.label : e.category) + "-" + e.category);
      while (usedIds.has(id)) id += "-x";
      usedIds.add(id);
      const files = e.files.map((f) => f.path);
      const related = relatedCommits(files, commits);
      return {
        id,
        title: chapterTitle(e.category, e.label),
        summary: summarizeFiles(e.files),
        intent: intentFor(e.category, e.label),
        risk_level: riskForFiles(e.files),
        files,
        diff_hunks: hunkRefs(e.files),
        review_notes: reviewNotes(e.category, e.files),
        verification_steps: verificationSteps(e.category),
        ...(related.length ? { related_commits: related } : {}),
      };
    });

    const themes = chapters.map((c) => c.title);
    const reviewerPath = chapters.map((c) => c.id);
    const startHere = computeStartHere(diff.files);

    return {
      version: WALKTHROUGH_VERSION,
      title,
      summary: buildOverviewSummary(stats, chapters.length, diff.files, commits),
      source,
      stats,
      themes,
      reviewer_path: reviewerPath,
      ...(startHere.length ? { start_here: startHere } : {}),
      ...(commits?.length ? { commits: commits.map((c) => c.subject) } : {}),
      chapters,
      generator: this.name,
    };
  }
}

function buildOverviewSummary(
  stats: { files_changed: number; additions: number; deletions: number },
  chapterCount: number,
  files: DiffFile[],
  commits?: CommitInfo[],
): string {
  const parts: string[] = [];
  parts.push(
    `This change touches ${stats.files_changed} file${
      stats.files_changed === 1 ? "" : "s"
    } across ${chapterCount} area${chapterCount === 1 ? "" : "s"} (+${stats.additions}/-${stats.deletions}).`,
  );
  const feature = dominantToken(files);
  if (feature) {
    parts.push(
      `Recurring theme: “${feature.token}” appears in ${feature.count} of the changed files.`,
    );
  }
  if (commits && commits.length) {
    parts.push(`${commits.length} commit${commits.length === 1 ? "" : "s"} in this change.`);
  }
  parts.push(
    "This walkthrough was generated heuristically (no AI). Use the chapters as a guided reading order, then dig into the raw diff explorer for details.",
  );
  return parts.join(" ");
}
