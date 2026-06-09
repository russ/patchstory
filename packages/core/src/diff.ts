/**
 * A small, dependency-free unified-diff parser for `git diff` output.
 *
 * It understands the cases that matter for code review: added/deleted/modified/
 * renamed/copied files, binary files, mode changes, multiple hunks, and
 * "\\ No newline at end of file" markers. It is intentionally forgiving — bad
 * input degrades to fewer parsed lines rather than throwing.
 */

import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  FileStatus,
  ParsedDiff,
} from "./types.ts";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Strip git's `a/` or `b/` prefix and unquote a path if needed. */
function cleanPath(raw: string): string {
  let p = raw.trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    // git quotes paths containing special chars; do a best-effort unescape.
    try {
      p = JSON.parse(p);
    } catch {
      p = p.slice(1, -1);
    }
  }
  if (p === "/dev/null") return p;
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p;
}

function newFile(): DiffFile {
  return {
    path: "",
    status: "modified",
    additions: 0,
    deletions: 0,
    binary: false,
    hunks: [],
  };
}

export function parseDiff(raw: string): ParsedDiff {
  const files: DiffFile[] = [];
  if (!raw) return { files };

  const lines = raw.split("\n");
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const pushFile = () => {
    if (file && file.path) files.push(file);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      pushFile();
      file = newFile();
      hunk = null;
      // Best-effort path from the header; overridden by --- / +++ lines below.
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m) {
        file.oldPath = cleanPath("a/" + m[1]);
        file.path = cleanPath("b/" + m[2]);
      }
      continue;
    }

    if (!file) continue;

    if (line.startsWith("new file mode")) {
      file.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      file.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = cleanPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = cleanPath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("copy from ")) {
      file.status = "copied";
      file.oldPath = cleanPath(line.slice("copy from ".length));
      continue;
    }
    if (line.startsWith("copy to ")) {
      file.status = "copied";
      file.path = cleanPath(line.slice("copy to ".length));
      continue;
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      hunk = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = cleanPath(line.slice(4));
      if (p === "/dev/null") file.status = "added";
      else file.oldPath = p;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = cleanPath(line.slice(4));
      if (p === "/dev/null") file.status = "deleted";
      else file.path = p;
      continue;
    }

    const hm = line.match(HUNK_RE);
    if (hm) {
      hunk = {
        header: line,
        section: hm[5]?.trim() || undefined,
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        lines: [],
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk) continue;

    // "\\ No newline at end of file" applies to the previous line; ignore.
    if (line.startsWith("\\")) continue;

    const marker = line[0];
    const content = line.slice(1);
    let dl: DiffLine | null = null;
    if (marker === "+") {
      dl = { type: "add", content, oldNumber: null, newNumber: newLine++ };
      file.additions++;
    } else if (marker === "-") {
      dl = { type: "del", content, oldNumber: oldLine++, newNumber: null };
      file.deletions++;
    } else if (marker === " ") {
      dl = { type: "context", content, oldNumber: oldLine++, newNumber: newLine++ };
    } else if (line === "") {
      // A bare empty line inside a hunk is an empty context line.
      dl = { type: "context", content: "", oldNumber: oldLine++, newNumber: newLine++ };
    }
    if (dl) hunk.lines.push(dl);
  }

  pushFile();

  // For deletions, the canonical path should be the old path.
  for (const f of files) {
    if (f.status === "deleted" && f.oldPath) f.path = f.oldPath;
    if (!f.path && f.oldPath) f.path = f.oldPath;
  }

  return { files };
}

/** Aggregate stats across all files. */
export function diffStats(diff: ParsedDiff) {
  let additions = 0;
  let deletions = 0;
  for (const f of diff.files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return {
    files_changed: diff.files.length,
    additions,
    deletions,
  };
}
