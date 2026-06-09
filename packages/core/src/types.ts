/**
 * Canonical types shared across the toolchain.
 *
 * Two families live here:
 *  - The *walkthrough document* (`WalkthroughDocument`) — the human/AI authored
 *    story. This is the canonical intermediate representation serialized to
 *    `pr-walkthrough.json`.
 *  - The *parsed diff* (`ParsedDiff`) — the structured, machine-parsed git diff
 *    that powers the raw diff explorer and the diff hunks shown in chapters.
 *
 * The renderer consumes both but never cares where the walkthrough came from.
 */

export const WALKTHROUGH_VERSION = "0.1";

export type RiskLevel = "low" | "medium" | "high";

export type SourceType =
  | "github_pr"
  | "git_diff"
  | "commit_range"
  | "diff_file";

export interface WalkthroughSource {
  type: SourceType;
  /** "org/repo" when known (github). */
  repo?: string;
  pr_number?: number;
  base?: string;
  head?: string;
  /** Raw range expression for local sources, e.g. "main...feature". */
  range?: string;
}

export interface WalkthroughStats {
  files_changed: number;
  additions: number;
  deletions: number;
}

/** A pointer from a chapter into a specific region of a file's diff. */
export interface DiffHunkRef {
  file: string;
  /** Start line in the *new* file. */
  start_line: number;
  /** End line in the *new* file. */
  end_line: number;
  summary?: string;
}

export interface Chapter {
  id: string;
  title: string;
  summary: string;
  /** Why this part of the change exists. */
  intent?: string;
  risk_level: RiskLevel;
  files: string[];
  diff_hunks: DiffHunkRef[];
  /** Reviewer questions / things to confirm. */
  review_notes: string[];
  /** Concrete steps to verify the change. */
  verification_steps: string[];
  /** Commit subjects whose files overlap this chapter (when known). */
  related_commits?: string[];
}

/** A "start here" pointer for the overview's reviewer guidance. */
export interface StartHere {
  file: string;
  reason: string;
}

export interface WalkthroughDocument {
  version: string;
  title: string;
  summary: string;
  source: WalkthroughSource;
  stats: WalkthroughStats;
  /** Main themes of the PR (used on the overview page). */
  themes?: string[];
  /** Suggested reading order, as chapter ids. */
  reviewer_path?: string[];
  /** "Start here" files a reviewer should look at first. */
  start_here?: StartHere[];
  /** Commit subjects in the change, newest first (when known). */
  commits?: string[];
  chapters: Chapter[];
  /** ISO timestamp; informational only. */
  generated_at?: string;
  /** Which generator produced this document ("none", "anthropic", ...). */
  generator?: string;
}

/* --------------------------------- Diff ---------------------------------- */

export type FileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied";

export type DiffLineType = "add" | "del" | "context";

export interface DiffLine {
  type: DiffLineType;
  /** Line content without the leading +/-/space marker. */
  content: string;
  /** 1-based line number in the old file (null for added lines). */
  oldNumber: number | null;
  /** 1-based line number in the new file (null for removed lines). */
  newNumber: number | null;
}

export interface DiffHunk {
  /** The raw "@@ ... @@" header line. */
  header: string;
  /** Optional section heading that git appends after the @@ markers. */
  section?: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Canonical path (new path, except for deletions where it's the old path). */
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  files: DiffFile[];
}

/** Everything the renderer needs, bundled for embedding into the static site. */
export interface WalkthroughBundle {
  walkthrough: WalkthroughDocument;
  diff: ParsedDiff;
}
