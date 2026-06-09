/** Minimal argv parser: positionals + `--flag` / `--key value` / `--key=value`.
 *  Kept tiny on purpose — no dependency for something this small. */

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that take no value (presence = true). */
const BOOLEAN_FLAGS = new Set([
  "zip", "help", "version", "no-open", "single-file", "serve", "open", "redact",
  "scaffold",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[body] = argv[++i];
      } else {
        flags[body] = true;
      }
    } else if (a.startsWith("-") && a.length === 2) {
      // short aliases
      const map: Record<string, string> = { o: "out", g: "generator", h: "help" };
      const key = map[a[1]] ?? a[1];
      if (key === "help") flags.help = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) flags[key] = argv[++i];
      else flags[key] = true;
    } else {
      positionals.push(a);
    }
  }

  return { positionals, flags };
}

export function flagStr(flags: ParsedArgs["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}
