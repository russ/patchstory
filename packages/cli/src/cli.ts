#!/usr/bin/env node
/**
 * patchstory — generate a static, interactive PR walkthrough from a git diff,
 * commit range, raw diff file, or GitHub PR.
 */

import { resolve, basename } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  buildWalkthrough,
  parseDiff,
  parseWalkthrough,
  redactParsedDiff,
  resolveCommitRange,
  resolveDiffFile,
  resolveGitDiff,
  resolveGithubPr,
  diffStats,
  WALKTHROUGH_JSON_SCHEMA,
} from "@patchstory/core";
import type {
  ParsedDiff,
  ResolvedSource,
  WalkthroughBundle,
} from "@patchstory/core";
import { renderWalkthrough, renderSingleFile } from "@patchstory/renderer";
import { parseArgs, flagStr } from "./args.ts";
import { zipDirectory } from "./zip.ts";
import { serveStatic, findFreePort, openBrowser, lanIp } from "./serve.ts";

// Injected at build time from packages/cli/package.json (see build.mjs).
// The typeof guard keeps `node src/cli.ts` working in dev (no define).
declare const __PATCHSTORY_VERSION__: string;
const VERSION =
  typeof __PATCHSTORY_VERSION__ !== "undefined" ? __PATCHSTORY_VERSION__ : "0.0.0-dev";

const HELP = `patchstory ${VERSION} — turn a diff into an interactive static walkthrough

Usage:
  patchstory <command> [args] [options]

Commands:
  diff <range>            Walkthrough of a git range   (e.g. main...feature)
  commits <range>         Walkthrough of a commit range (e.g. abc123..def456)
  file <path.diff>        Walkthrough of a raw unified diff file
  github <pr-url>         Walkthrough of a GitHub pull request
  render <walkthrough>    Render an existing pr-walkthrough.json
  serve [dir|file]        Serve an output folder/file on your LAN
  schema                  Print the pr-walkthrough.json JSON Schema

Options:
  -o, --out <path>        Output directory; .html file with --single-file;
                          .json file (or stdout) with --scaffold
                          (default: ./walkthrough)
  -g, --generator <name>  Story generator: none | anthropic   (default: none)
      --repo <dir>        Git repo to run in          (default: cwd)
      --model <id>        Model for the anthropic generator
      --scaffold          Emit the editable pr-walkthrough.json (the IR) for an
                          agent/human to enrich, instead of rendering a site
      --emit-diff <file>  With --scaffold: also write the resolved raw diff, so
                          the same bytes can be passed to \`render --diff\`
      --single-file       Emit one self-contained .html (easy to email/attach)
      --redact            Mask secrets in the diff before generating/rendering
      --serve             Serve the result on your LAN after generating
      --open              Open the result in a browser
      --port <n>          Port for --serve / serve   (default: 8137)
      --diff <file>       (render only) raw diff to populate the diff explorer
      --zip               Also write <out>.zip
  -h, --help              Show this help
      --version           Show version

Examples:
  patchstory diff main...my-branch --out ./walkthrough
  patchstory diff main...my-branch --single-file --open
  patchstory github https://github.com/org/repo/pull/123 --serve
  patchstory file ./my-pr.diff --redact
  patchstory serve ./walkthrough --open

Author the story with your own AI agent (the IR is separate from the renderer):
  patchstory github <pr-url> --scaffold -o pr-walkthrough.json --emit-diff pr.diff
  # ...an agent edits pr-walkthrough.json into a real narrative...
  patchstory render pr-walkthrough.json --diff pr.diff --redact --single-file -o pr.html --open
  patchstory schema > pr-walkthrough.schema.json   # validate against this

The non-AI "none" generator always works (no API key needed). With
-g anthropic + ANTHROPIC_API_KEY it asks Claude to author the story (falling
back to the heuristic on error). Use --redact to keep secrets out of the
output (and out of any AI prompt).
`;

function fail(msg: string): never {
  process.stderr.write(`\npatchstory: ${msg}\n`);
  process.exit(1);
}

function nowIso(): string {
  return new Date().toISOString();
}

async function startServer(target: string, flags: ReturnType<typeof parseArgs>["flags"]) {
  const port = await findFreePort(Number(flagStr(flags, "port") ?? 8137));
  const handle = serveStatic(target, port);
  process.stdout.write(`\nServing ${target}\n`);
  for (const u of handle.urls) process.stdout.write(`  ${u}\n`);
  if (!lanIp()) process.stdout.write("  (no LAN address detected — localhost only)\n");
  process.stdout.write("Press Ctrl+C to stop.\n");
  if (flags.open) openBrowser(handle.urls[0]);
  // Keep the process alive.
  await new Promise<void>(() => {});
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));

  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const command = positionals[0];
  if (!command || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  // `serve` is standalone: just host an existing output.
  if (command === "serve") {
    const target = resolve(positionals[1] ?? "./walkthrough");
    if (!existsSync(target)) fail(`nothing to serve at ${target}`);
    await startServer(target, flags);
    return;
  }

  // `schema` is standalone: print the canonical JSON Schema for the IR.
  if (command === "schema") {
    process.stdout.write(JSON.stringify(WALKTHROUGH_JSON_SCHEMA, null, 2) + "\n");
    return;
  }

  const generator = flagStr(flags, "generator") ?? "none";
  const model = flagStr(flags, "model");
  const redact = !!flags.redact;
  const cwd = resolve(flagStr(flags, "repo") ?? process.cwd());
  const singleFile = !!flags["single-file"];
  const scaffold = !!flags.scaffold;

  let bundle: WalkthroughBundle;
  let redactedCount = 0;
  let rawDiffText: string | undefined;

  if (command === "render") {
    if (scaffold) {
      fail("`--scaffold` builds the IR from a source; it can't be combined with `render`.");
    }
    const result = await renderCommand(positionals, flags, redact);
    bundle = { walkthrough: result.walkthrough, diff: result.diff };
    redactedCount = result.redactedCount;
  } else {
    const resolved = await resolveSource(command, positionals[1], cwd);
    if (!resolved.rawDiff.trim()) {
      fail("the diff is empty — nothing to walk through. Check your range/input.");
    }
    rawDiffText = resolved.rawDiff;
    const result = await buildWalkthrough(resolved, {
      generator,
      generatorOptions: { model },
      redact,
    });
    bundle = { walkthrough: result.walkthrough, diff: result.diff };
    redactedCount = result.redactedCount;
  }

  // --scaffold: emit the editable IR (and optionally the diff) and stop.
  if (scaffold) {
    const doc = bundle.walkthrough;
    doc.generated_at = nowIso();
    const json = JSON.stringify(doc, null, 2) + "\n";
    const outPath = flagStr(flags, "out");
    if (outPath) {
      const p = resolve(outPath);
      writeFileSync(p, json);
      process.stderr.write(
        `\n✓ Walkthrough IR written to ${p}\n` +
          `  ${doc.chapters.length} chapters · generator: ${doc.generator ?? "none"}\n` +
          `  edit it into a real narrative, then: patchstory render ${outPath} --diff <raw.diff>\n`,
      );
    } else {
      process.stdout.write(json);
    }
    const emitDiff = flagStr(flags, "emit-diff");
    if (emitDiff && rawDiffText != null) {
      const p = resolve(emitDiff);
      writeFileSync(p, rawDiffText);
      process.stderr.write(`✓ Raw diff written to ${p} (feed it to \`render --diff\`)\n`);
    }
    if (redact) {
      process.stderr.write(
        "🛈 --redact applies when rendering the embedded diff; the emitted IR/diff are unredacted.\n",
      );
    }
    return;
  }

  const renderOpts = { generatedAt: nowIso(), toolVersion: VERSION };
  const outFlag = flagStr(flags, "out") ?? "./walkthrough";

  let servePath: string;

  if (singleFile) {
    const outFile = resolve(/\.html?$/i.test(outFlag) ? outFlag : `${outFlag}.html`);
    const { file } = renderSingleFile(bundle, outFile, renderOpts);
    servePath = file;
    reportDone(bundle, file, true);
  } else {
    const outDir = resolve(outFlag);
    const result = renderWalkthrough(bundle, outDir, renderOpts);
    servePath = result.outDir;
    reportDone(bundle, result.outDir, false);
    if (flags.zip) {
      const zipPath = outDir.replace(/\/+$/, "") + ".zip";
      const bytes = zipDirectory(outDir, zipPath);
      process.stdout.write(`✓ Zipped to ${zipPath} (${(bytes / 1024).toFixed(1)} KB)\n`);
    }
  }

  if (redact) {
    process.stdout.write(
      `🛈 Redaction on: masked secrets on ${redactedCount} line${redactedCount === 1 ? "" : "s"}.\n`,
    );
  }

  if (flags.serve) {
    await startServer(servePath, flags);
  } else if (flags.open) {
    openBrowser(
      singleFile ? `file://${servePath}` : `file://${servePath}/index.html`,
    );
  }
}

function reportDone(bundle: WalkthroughBundle, out: string, single: boolean) {
  const w = bundle.walkthrough;
  process.stdout.write(
    `\n✓ Walkthrough written to ${out}\n` +
      (single ? `  open ${basename(out)} in any browser\n` : `  open ${out}/index.html\n`) +
      `  ${w.chapters.length} chapters · ${w.stats.files_changed} files · ` +
      `+${w.stats.additions}/-${w.stats.deletions} · generator: ${w.generator ?? "none"}\n`,
  );
}

/** Resolve a source command (diff/commits/file/github) into a raw diff + metadata. */
async function resolveSource(
  command: string,
  arg: string | undefined,
  cwd: string,
): Promise<ResolvedSource> {
  switch (command) {
    case "diff":
      if (!arg) fail("`diff` needs a range, e.g. patchstory diff main...feature");
      return resolveGitDiff(arg, cwd);
    case "commits":
      if (!arg) fail("`commits` needs a range, e.g. patchstory commits abc..def");
      return resolveCommitRange(arg, cwd);
    case "file":
      if (!arg) fail("`file` needs a path to a .diff file");
      if (!existsSync(arg)) fail(`diff file not found: ${arg}`);
      return resolveDiffFile(resolve(arg));
    case "github":
      if (!arg) fail("`github` needs a PR URL");
      return resolveGithubPr(arg);
    default:
      fail(`unknown command "${command}". Run patchstory --help.`);
  }
}

/** `render` builds a bundle from an existing walkthrough JSON (+ optional diff). */
async function renderCommand(
  positionals: string[],
  flags: ReturnType<typeof parseArgs>["flags"],
  redact: boolean,
): Promise<WalkthroughBundle & { redactedCount: number }> {
  const jsonPath = positionals[1];
  if (!jsonPath) fail("`render` needs a path to pr-walkthrough.json");
  if (!existsSync(jsonPath)) fail(`file not found: ${jsonPath}`);

  const walkthrough = parseWalkthrough(readFileSync(resolve(jsonPath), "utf8"));

  let diff: ParsedDiff;
  let redactedCount = 0;
  const diffPath = flagStr(flags, "diff");
  if (diffPath) {
    if (!existsSync(diffPath)) fail(`diff file not found: ${diffPath}`);
    diff = parseDiff(readFileSync(resolve(diffPath), "utf8"));
    // Unlike the source commands, `render` parses the diff here — so redaction
    // has to happen here too, or `--redact` would silently do nothing.
    if (redact) {
      const r = redactParsedDiff(diff);
      diff = r.diff;
      redactedCount = r.count;
    }
    if (!walkthrough.stats || !walkthrough.stats.files_changed) {
      walkthrough.stats = diffStats(diff);
    }
  } else {
    const paths = new Set<string>();
    for (const c of walkthrough.chapters) for (const f of c.files) paths.add(f);
    diff = {
      files: [...paths].map((path) => ({
        path,
        status: "modified" as const,
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      })),
    };
  }

  return { walkthrough, diff, redactedCount };
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
