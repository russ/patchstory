import { test } from "node:test";
import assert from "node:assert/strict";
import { NoneGenerator } from "../packages/core/src/generators/none.ts";
import type { DiffFile, ParsedDiff } from "../packages/core/src/types.ts";

function file(path: string, additions = 5, deletions = 0): DiffFile {
  return {
    path,
    status: "modified",
    additions,
    deletions,
    binary: false,
    hunks: [
      {
        header: "@@ -1,1 +1,5 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 5,
        lines: [{ type: "add", content: "x", oldNumber: null, newNumber: 1 }],
      },
    ],
  };
}

function inputFor(files: DiffFile[]) {
  const diff: ParsedDiff = { files };
  const additions = files.reduce((a, f) => a + f.additions, 0);
  const deletions = files.reduce((a, f) => a + f.deletions, 0);
  return {
    source: { type: "git_diff" as const },
    title: "Test",
    stats: { files_changed: files.length, additions, deletions },
    diff,
  };
}

test("groups by category and orders data first", async () => {
  const doc = await new NoneGenerator().generate(
    inputFor([
      file("app/models/user.rb"),
      file("db/migrate/001_init.rb"),
      file("README.md"),
      file("spec/user_spec.rb"),
    ]),
  );
  assert.ok(doc.chapters.length >= 3);
  assert.equal(doc.chapters[0].title, "Data model & migrations");
  // migrations are flagged higher risk
  assert.equal(doc.chapters[0].risk_level, "high");
});

test("adaptively splits a large directory into deeper chapters", async () => {
  const files: DiffFile[] = [];
  for (let i = 0; i < 20; i++) files.push(file(`backend/src/actions/pvp/file${i}.cr`));
  for (let i = 0; i < 20; i++) files.push(file(`backend/src/models/m${i}.cr`));
  const doc = await new NoneGenerator().generate(inputFor(files));
  const titles = doc.chapters.map((c) => c.title);
  assert.ok(titles.includes("backend/src/actions/pvp"), titles.join(","));
  assert.ok(titles.includes("backend/src/models"), titles.join(","));
});

test("derives a specific intent from directory name", async () => {
  const doc = await new NoneGenerator().generate(inputFor([file("app/workers/sync_worker.rb")]));
  const ch = doc.chapters.find((c) => c.files.includes("app/workers/sync_worker.rb"))!;
  assert.match(ch.intent ?? "", /worker/i);
});

test("computes start_here and reviewer_path", async () => {
  const doc = await new NoneGenerator().generate(
    inputFor([file("db/migrate/001.rb", 300, 0), file("app/models/user.rb", 10, 2)]),
  );
  assert.ok(doc.start_here && doc.start_here.length > 0);
  // migration should be first to read
  assert.match(doc.start_here![0].file, /migrate/);
  assert.equal(doc.reviewer_path?.length, doc.chapters.length);
});

test("attaches related commits when commit files are known", async () => {
  const input = {
    ...inputFor([file("app/models/user.rb")]),
    commits: [{ subject: "Add user model", files: ["app/models/user.rb"] }],
  };
  const doc = await new NoneGenerator().generate(input);
  const ch = doc.chapters.find((c) => c.files.includes("app/models/user.rb"))!;
  assert.deepEqual(ch.related_commits, ["Add user model"]);
});
