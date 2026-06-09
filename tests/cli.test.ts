import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateWalkthrough } from "../packages/core/src/schema.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "packages/cli/dist/patchstory.mjs");
const SAMPLE = join(ROOT, "examples/sample.diff");

// These exercise the built bundle, so they need `npm run build` first (CI does).
const skip = existsSync(BIN) ? false : "run `npm run build` first";

function run(args: string[]): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "patchstory-cli-"));
}

test("`schema` prints the canonical JSON Schema", { skip }, () => {
  const schema = JSON.parse(run(["schema"]));
  assert.match(schema.$id, /pr-walkthrough/);
  assert.deepEqual(schema.required, [
    "version", "title", "summary", "source", "stats", "chapters",
  ]);
  assert.ok(schema.properties.chapters, "schema documents chapters");
});

test("`--scaffold` emits a schema-valid IR to stdout", { skip }, () => {
  const doc = JSON.parse(run(["file", SAMPLE, "--scaffold"]));
  const v = validateWalkthrough(doc);
  assert.equal(v.valid, true, v.errors.join("; "));
  assert.equal(doc.generator, "none");
  assert.ok(doc.generated_at, "stamps generated_at");
  assert.ok(doc.chapters.length > 0);
});

test("`--scaffold --emit-diff` writes the IR and the exact diff bytes", { skip }, () => {
  const dir = tmp();
  const jsonPath = join(dir, "ir.json");
  const diffPath = join(dir, "used.diff");
  run(["file", SAMPLE, "--scaffold", "-o", jsonPath, "--emit-diff", diffPath]);
  assert.ok(existsSync(jsonPath), "wrote the IR file");
  assert.equal(
    readFileSync(diffPath, "utf8"),
    readFileSync(SAMPLE, "utf8"),
    "emitted diff is byte-identical to the source",
  );
});

test("`render --redact` masks secrets in the embedded diff", { skip }, () => {
  const dir = tmp();
  const diffPath = join(dir, "secret.diff");
  writeFileSync(
    diffPath,
    [
      "diff --git a/.env b/.env",
      "index 1..2 100644",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1,2 +1,3 @@",
      " KEEP=this",
      "+AWS_KEY=AKIAIOSFODNN7EXAMPLE",
      "+password = hunter2supersecret",
      "",
    ].join("\n"),
  );
  const irPath = join(dir, "ir.json");
  run(["file", diffPath, "--scaffold", "-o", irPath]);

  const plain = join(dir, "plain");
  run(["render", irPath, "--diff", diffPath, "--out", plain]);
  assert.match(
    readFileSync(join(plain, "data.js"), "utf8"),
    /AKIAIOSFODNN7EXAMPLE/,
    "without --redact the secret is embedded",
  );

  const redacted = join(dir, "redacted");
  run(["render", irPath, "--diff", diffPath, "--redact", "--out", redacted]);
  const data = readFileSync(join(redacted, "data.js"), "utf8");
  assert.doesNotMatch(data, /AKIAIOSFODNN7EXAMPLE|hunter2supersecret/, "secrets are masked");
  assert.match(data, /redacted/, "mask token is present");
  assert.match(data, /KEEP=this/, "benign content is preserved");
});
