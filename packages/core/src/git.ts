/** Thin wrappers around the system `git` binary. We shell out rather than
 *  depend on a git library — it's local-first and always available. */

import { execFileSync } from "node:child_process";

const MAX_BUFFER = 256 * 1024 * 1024; // 256MB — large diffs are a thing.

export class GitError extends Error {}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    });
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() ?? "";
    throw new GitError(
      `git ${args.join(" ")} failed: ${stderr || err?.message || "unknown error"}`,
    );
  }
}

export function isGitRepo(cwd: string): boolean {
  try {
    git(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Run `git diff <range>` and return the raw unified diff. */
export function gitDiff(range: string, cwd: string): string {
  return git(["diff", "--no-color", range], cwd);
}

/** Commit subjects in the range, oldest last (matches `git log` default). */
export function commitSubjects(range: string, cwd: string): string[] {
  try {
    const out = git(["log", "--no-color", "--format=%s", range], cwd);
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export interface CommitInfo {
  subject: string;
  /** Files touched by this commit (empty when unknown, e.g. remote diffs). */
  files: string[];
}

/** Commits in the range with the files each touched (newest first). */
export function commitLog(range: string, cwd: string): CommitInfo[] {
  try {
    // \x01 marks the start of a commit; name-only lists its files after.
    const out = git(
      ["log", "--no-color", "--name-only", "--format=%x01%s", range],
      cwd,
    );
    const commits: CommitInfo[] = [];
    let current: CommitInfo | null = null;
    for (const raw of out.split("\n")) {
      if (raw.startsWith("\x01")) {
        current = { subject: raw.slice(1).trim(), files: [] };
        commits.push(current);
      } else if (raw.trim() && current) {
        current.files.push(raw.trim());
      }
    }
    return commits;
  } catch {
    return [];
  }
}

export function currentBranch(cwd: string): string | undefined {
  try {
    const b = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
    return b && b !== "HEAD" ? b : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Split a range expression into base/head for display purposes.
 * Handles "a...b", "a..b", and a bare ref (compared against itself).
 */
export function splitRange(range: string): { base?: string; head?: string } {
  const triple = range.split("...");
  if (triple.length === 2) return { base: triple[0] || undefined, head: triple[1] || undefined };
  const dbl = range.split("..");
  if (dbl.length === 2) return { base: dbl[0] || undefined, head: dbl[1] || undefined };
  return { head: range || undefined };
}
