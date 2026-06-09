/**
 * @patchstory/core — the input + intermediate-representation layer.
 *
 * Pipeline: resolve a source → parse the diff → run a generator → get a
 * `WalkthroughDocument`. The renderer consumes the document + parsed diff and
 * is intentionally unaware of any of this.
 */

export * from "./types.ts";
export { parseDiff, diffStats } from "./diff.ts";
export * from "./git.ts";
export * from "./sources.ts";
export * from "./generators/index.ts";
export { redactParsedDiff } from "./redact.ts";
export {
  WALKTHROUGH_JSON_SCHEMA,
  validateWalkthrough,
  parseWalkthrough,
} from "./schema.ts";

import { parseDiff, diffStats } from "./diff.ts";
import { redactParsedDiff } from "./redact.ts";
import type { ResolvedSource } from "./sources.ts";
import { getGenerator } from "./generators/index.ts";
import type { GeneratorName, GeneratorOptions } from "./generators/index.ts";
import type { ParsedDiff, WalkthroughBundle, WalkthroughDocument } from "./types.ts";

export interface BuildOptions {
  generator?: GeneratorName | string;
  generatorOptions?: GeneratorOptions;
  /** Mask secrets in the diff before generation and rendering. */
  redact?: boolean;
}

export interface BuildResult extends WalkthroughBundle {
  /** Number of lines redacted when `redact` was set. */
  redactedCount: number;
}

/**
 * Turn a resolved source into a full bundle (walkthrough document + parsed
 * diff) ready for rendering. `generated_at` is left for the caller to stamp so
 * core stays free of nondeterministic clock reads.
 */
export async function buildWalkthrough(
  resolved: ResolvedSource,
  opts: BuildOptions = {},
): Promise<BuildResult> {
  let diff: ParsedDiff = parseDiff(resolved.rawDiff);
  let redactedCount = 0;
  if (opts.redact) {
    const r = redactParsedDiff(diff);
    diff = r.diff;
    redactedCount = r.count;
  }

  const stats = diffStats(diff);
  const generator = getGenerator(opts.generator ?? "none", opts.generatorOptions);

  const walkthrough: WalkthroughDocument = await generator.generate({
    source: resolved.source,
    title: resolved.title,
    stats,
    diff,
    commits: resolved.commits,
  });

  return { walkthrough, diff, redactedCount };
}
