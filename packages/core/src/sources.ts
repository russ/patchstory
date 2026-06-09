/**
 * Resolve a CLI input (range, commit range, diff file, or GitHub PR) into a
 * raw unified diff plus structured source metadata. This is the only layer that
 * knows about *where* a diff comes from; everything downstream works on the
 * parsed diff alone.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  commitLog,
  currentBranch,
  gitDiff,
  isGitRepo,
  splitRange,
} from "./git.ts";
import type { CommitInfo } from "./git.ts";
import type { WalkthroughSource } from "./types.ts";

export interface ResolvedSource {
  rawDiff: string;
  source: WalkthroughSource;
  title: string;
  commits: CommitInfo[];
}

/** `patchstory diff main...feature` */
export function resolveGitDiff(range: string, cwd: string): ResolvedSource {
  if (!isGitRepo(cwd)) {
    throw new Error(`Not a git repository: ${cwd}`);
  }
  const rawDiff = gitDiff(range, cwd);
  const { base, head } = splitRange(range);
  const branch = head ?? currentBranch(cwd);
  return {
    rawDiff,
    source: { type: "git_diff", range, base, head },
    title: branch ? `Changes on ${branch}` : `Diff ${range}`,
    commits: commitLog(range, cwd),
  };
}

/** `patchstory commits abc123..def456` */
export function resolveCommitRange(range: string, cwd: string): ResolvedSource {
  if (!isGitRepo(cwd)) {
    throw new Error(`Not a git repository: ${cwd}`);
  }
  const rawDiff = gitDiff(range, cwd);
  const { base, head } = splitRange(range);
  return {
    rawDiff,
    source: { type: "commit_range", range, base, head },
    title: `Commits ${range}`,
    commits: commitLog(range, cwd),
  };
}

/** `patchstory file ./my-pr.diff` */
export function resolveDiffFile(path: string): ResolvedSource {
  const rawDiff = readFileSync(path, "utf8");
  return {
    rawDiff,
    source: { type: "diff_file" },
    title: `Diff from ${path.split("/").pop()}`,
    commits: [],
  };
}

interface GithubRef {
  owner: string;
  repo: string;
  number: number;
}

export function parseGithubPrUrl(url: string): GithubRef | null {
  const m = url.match(
    /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/pull\/(\d+)/,
  );
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** `patchstory github https://github.com/org/repo/pull/123`
 *
 * Prefers the `gh` CLI (handles auth + private repos). Falls back to fetching
 * the public `.diff` endpoint. Title/body come from `gh` when available.
 */
export async function resolveGithubPr(url: string): Promise<ResolvedSource> {
  const ref = parseGithubPrUrl(url);
  if (!ref) throw new Error(`Could not parse GitHub PR URL: ${url}`);
  const slug = `${ref.owner}/${ref.repo}`;

  let rawDiff = "";
  let title = `PR #${ref.number}`;
  let base: string | undefined;
  let head: string | undefined;
  const commits: CommitInfo[] = [];

  const gh = (args: string[]): string | null => {
    try {
      return execFileSync("gh", args, {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };

  const diffOut = gh(["pr", "diff", String(ref.number), "--repo", slug]);
  if (diffOut) {
    rawDiff = diffOut;
    const meta = gh([
      "pr",
      "view",
      String(ref.number),
      "--repo",
      slug,
      "--json",
      "title,baseRefName,headRefName,commits",
    ]);
    if (meta) {
      try {
        const j = JSON.parse(meta);
        if (j.title) title = j.title;
        base = j.baseRefName;
        head = j.headRefName;
        if (Array.isArray(j.commits)) {
          for (const c of j.commits) {
            const s = c?.messageHeadline;
            if (s) commits.push({ subject: s, files: [] });
          }
        }
      } catch {
        /* ignore metadata parse errors */
      }
    }
  } else {
    // Fallback: public .diff endpoint (no auth, public repos only).
    const diffUrl = `https://github.com/${slug}/pull/${ref.number}.diff`;
    const res = await fetch(diffUrl, {
      headers: { Accept: "application/vnd.github.v3.diff" },
    });
    if (!res.ok) {
      throw new Error(
        `Failed to fetch PR diff (${res.status}). Install/authenticate the \`gh\` CLI for private repos.`,
      );
    }
    rawDiff = await res.text();
  }

  return {
    rawDiff,
    source: {
      type: "github_pr",
      repo: slug,
      pr_number: ref.number,
      base,
      head,
    },
    title,
    commits: commits.reverse(), // gh returns oldest-first; show newest-first
  };
}
