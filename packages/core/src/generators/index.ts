import { NoneGenerator } from "./none.ts";
import { anthropicWithFallback } from "./anthropic.ts";
import type { WalkthroughGenerator } from "./types.ts";

export * from "./types.ts";
export { NoneGenerator } from "./none.ts";
export { AnthropicGenerator, anthropicWithFallback } from "./anthropic.ts";

export type GeneratorName = "none" | "anthropic" | "openai" | "local";

export interface GeneratorOptions {
  model?: string;
  apiKey?: string;
}

/** Resolve a generator by name. Unknown/unimplemented names fall back to `none`. */
export function getGenerator(
  name: GeneratorName | string = "none",
  opts: GeneratorOptions = {},
): WalkthroughGenerator {
  switch (name) {
    case "anthropic":
      return anthropicWithFallback(opts);
    case "openai":
    case "local":
      process.stderr.write(
        `[patchstory] generator "${name}" is not implemented yet; using "none".\n`,
      );
      return new NoneGenerator();
    case "none":
    default:
      return new NoneGenerator();
  }
}
