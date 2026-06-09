import type {
  ParsedDiff,
  WalkthroughDocument,
  WalkthroughSource,
  WalkthroughStats,
} from "../types.ts";
import type { CommitInfo } from "../git.ts";

/** Everything a generator receives to build a walkthrough. */
export interface DiffAnalysisInput {
  source: WalkthroughSource;
  title: string;
  stats: WalkthroughStats;
  diff: ParsedDiff;
  /** Commits in the range with their files, if available. */
  commits?: CommitInfo[];
}

/**
 * The single seam between "how the story is made" and "how it's rendered".
 * Implementations may be heuristic (no AI), call a hosted model, or read a
 * human-written file. The renderer never sees this interface.
 */
export interface WalkthroughGenerator {
  readonly name: string;
  generate(input: DiffAnalysisInput): Promise<WalkthroughDocument>;
}
