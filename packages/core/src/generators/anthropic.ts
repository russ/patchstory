/**
 * Optional Anthropic adapter. Uses the built-in `fetch` against the Messages
 * API directly so the tool keeps zero runtime dependencies — there is no SDK to
 * install. It is fully optional: if `ANTHROPIC_API_KEY` is unset or the call
 * fails, the CLI falls back to the heuristic generator.
 *
 * Model surface notes (current API):
 *  - Endpoint: POST https://api.anthropic.com/v1/messages
 *  - Header:   anthropic-version: 2023-06-01
 *  - Default model: claude-opus-4-8 (adaptive thinking; no temperature/top_p;
 *    assistant prefills are rejected). Override via --model / PATCHSTORY_MODEL.
 */

import { WALKTHROUGH_VERSION } from "../types.ts";
import type { DiffFile, WalkthroughDocument } from "../types.ts";
import { validateWalkthrough } from "../schema.ts";
import { NoneGenerator } from "./none.ts";
import type { DiffAnalysisInput, WalkthroughGenerator } from "./types.ts";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-4-8";

export interface AnthropicOptions {
  apiKey?: string;
  model?: string;
  /** Truncate each file's diff body to this many characters in the prompt. */
  maxDiffCharsPerFile?: number;
}

export class AnthropicGenerator implements WalkthroughGenerator {
  readonly name = "anthropic";
  private apiKey: string;
  private model: string;
  private maxDiffCharsPerFile: number;

  constructor(opts: AnthropicOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.model = opts.model ?? process.env.PATCHSTORY_MODEL ?? DEFAULT_MODEL;
    this.maxDiffCharsPerFile = opts.maxDiffCharsPerFile ?? 6000;
  }

  async generate(input: DiffAnalysisInput): Promise<WalkthroughDocument> {
    if (!this.apiKey) {
      throw new Error(
        "AnthropicGenerator requires an API key (set ANTHROPIC_API_KEY).",
      );
    }

    const prompt = buildPrompt(input, this.maxDiffCharsPerFile);
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");

    const parsed = extractJson(text);
    if (!parsed) {
      throw new Error("Anthropic response did not contain valid JSON.");
    }

    // The model owns the story, but we own the source/stats facts.
    const doc: WalkthroughDocument = {
      ...parsed,
      version: parsed.version ?? WALKTHROUGH_VERSION,
      source: input.source,
      stats: input.stats,
      generator: this.name,
    };

    const { valid, errors } = validateWalkthrough(doc);
    if (!valid) {
      throw new Error(`Generated walkthrough failed validation: ${errors.join("; ")}`);
    }
    return doc;
  }
}

/** Build an Anthropic generator that silently falls back to the heuristic one. */
export function anthropicWithFallback(
  opts: AnthropicOptions = {},
): WalkthroughGenerator {
  const primary = new AnthropicGenerator(opts);
  const fallback = new NoneGenerator();
  return {
    name: "anthropic",
    async generate(input) {
      try {
        return await primary.generate(input);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `\n[patchstory] AI generation failed (${msg}). Falling back to heuristic walkthrough.\n`,
        );
        const doc = await fallback.generate(input);
        doc.generator = "anthropic+fallback";
        return doc;
      }
    },
  };
}

const SYSTEM_PROMPT = `You are a senior engineer writing a guided walkthrough of a code change for a reviewer.
You break the change into a small number of logical "chapters" that tell the story of the change, ordered so a reviewer can build understanding from the ground up.
You output ONLY a single JSON object — no prose, no markdown fences — conforming exactly to the requested schema.`;

function buildPrompt(input: DiffAnalysisInput, maxChars: number): string {
  const fileBlocks = input.diff.files
    .map((f) => renderFileForPrompt(f, maxChars))
    .join("\n\n");

  const commits = input.commits?.length
    ? `\nCommit messages in this change:\n${input.commits.map((c) => `- ${c.subject}`).join("\n")}\n`
    : "";

  return `Produce a PR walkthrough as JSON for the following change.

Title hint: ${input.title}
Files changed: ${input.stats.files_changed}, additions: ${input.stats.additions}, deletions: ${input.stats.deletions}
${commits}
Return a JSON object with this exact shape (omit no required field):
{
  "version": "0.1",
  "title": string,            // a clear, human title for the whole change
  "summary": string,          // 2-4 sentences: what this change does and why
  "themes": string[],         // the main themes of the change
  "reviewer_path": string[],  // chapter ids in the suggested reading order
  "chapters": [
    {
      "id": string,                  // kebab-case, unique
      "title": string,
      "summary": string,             // what changed in this chapter
      "intent": string,              // why this part exists
      "risk_level": "low" | "medium" | "high",
      "files": string[],             // file paths involved (must match the diff)
      "diff_hunks": [ { "file": string, "start_line": number, "end_line": number, "summary": string } ],
      "review_notes": string[],      // pointed reviewer questions
      "verification_steps": string[] // concrete steps to verify
    }
  ]
}

Rules:
- Use only file paths that appear in the diff below.
- Prefer 2-6 chapters. Group related files; don't make one chapter per file unless the change is tiny.
- start_line/end_line refer to line numbers in the NEW file, taken from the hunk headers.
- Output ONLY the JSON object.

DIFF:
${fileBlocks}`;
}

function renderFileForPrompt(f: DiffFile, maxChars: number): string {
  const header = `### ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`;
  if (f.binary) return `${header}\n[binary file]`;
  let body = "";
  for (const h of f.hunks) {
    body += `${h.header}\n`;
    for (const l of h.lines) {
      const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
      body += `${sign}${l.content}\n`;
    }
  }
  if (body.length > maxChars) {
    body = body.slice(0, maxChars) + "\n… [truncated]\n";
  }
  return `${header}\n${body}`;
}

/** Pull the first balanced top-level JSON object out of a model response. */
function extractJson(text: string): any | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
