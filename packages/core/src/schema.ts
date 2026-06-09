/**
 * The canonical JSON Schema for `pr-walkthrough.json`, plus a lightweight
 * runtime validator. The validator is deliberately small (not a full JSON
 * Schema engine) — its job is to catch structural mistakes in AI- or
 * human-authored documents before the renderer trusts them.
 */

import type { WalkthroughDocument } from "./types.ts";

export const WALKTHROUGH_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://patchstory.dev/schemas/pr-walkthrough-0.1.json",
  title: "PatchStory PR Walkthrough",
  type: "object",
  required: ["version", "title", "summary", "source", "stats", "chapters"],
  additionalProperties: true,
  properties: {
    version: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    generated_at: { type: "string" },
    generator: { type: "string" },
    themes: { type: "array", items: { type: "string" } },
    reviewer_path: { type: "array", items: { type: "string" } },
    source: {
      type: "object",
      required: ["type"],
      properties: {
        type: {
          type: "string",
          enum: ["github_pr", "git_diff", "commit_range", "diff_file"],
        },
        repo: { type: "string" },
        pr_number: { type: "number" },
        base: { type: "string" },
        head: { type: "string" },
        range: { type: "string" },
      },
    },
    stats: {
      type: "object",
      required: ["files_changed", "additions", "deletions"],
      properties: {
        files_changed: { type: "number" },
        additions: { type: "number" },
        deletions: { type: "number" },
      },
    },
    chapters: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "summary", "risk_level", "files"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          intent: { type: "string" },
          risk_level: { type: "string", enum: ["low", "medium", "high"] },
          files: { type: "array", items: { type: "string" } },
          diff_hunks: {
            type: "array",
            items: {
              type: "object",
              required: ["file", "start_line", "end_line"],
              properties: {
                file: { type: "string" },
                start_line: { type: "number" },
                end_line: { type: "number" },
                summary: { type: "string" },
              },
            },
          },
          review_notes: { type: "array", items: { type: "string" } },
          verification_steps: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Structural validation. Returns all problems found, not just the first. */
export function validateWalkthrough(doc: unknown): ValidationResult {
  const errors: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  if (!isObj(doc)) {
    return { valid: false, errors: ["document must be an object"] };
  }

  const reqString = (key: string, v: unknown) => {
    if (typeof v !== "string" || v.length === 0)
      errors.push(`"${key}" must be a non-empty string`);
  };
  reqString("title", doc.title);
  reqString("summary", doc.summary);
  if (typeof doc.version !== "string") errors.push('"version" must be a string');

  if (!isObj(doc.source)) {
    errors.push('"source" must be an object');
  } else if (
    !["github_pr", "git_diff", "commit_range", "diff_file"].includes(
      String(doc.source.type),
    )
  ) {
    errors.push('"source.type" is not a recognized value');
  }

  if (!isObj(doc.stats)) {
    errors.push('"stats" must be an object');
  } else {
    for (const k of ["files_changed", "additions", "deletions"]) {
      if (typeof doc.stats[k] !== "number")
        errors.push(`"stats.${k}" must be a number`);
    }
  }

  if (!Array.isArray(doc.chapters)) {
    errors.push('"chapters" must be an array');
  } else {
    const seen = new Set<string>();
    doc.chapters.forEach((c, i) => {
      if (!isObj(c)) {
        errors.push(`chapter[${i}] must be an object`);
        return;
      }
      if (typeof c.id !== "string" || !c.id) {
        errors.push(`chapter[${i}].id must be a non-empty string`);
      } else if (seen.has(c.id)) {
        errors.push(`chapter[${i}].id "${c.id}" is duplicated`);
      } else {
        seen.add(c.id);
      }
      if (typeof c.title !== "string" || !c.title)
        errors.push(`chapter[${i}].title must be a non-empty string`);
      if (!["low", "medium", "high"].includes(String(c.risk_level)))
        errors.push(`chapter[${i}].risk_level must be low|medium|high`);
      if (!Array.isArray(c.files))
        errors.push(`chapter[${i}].files must be an array`);
    });
  }

  return { valid: errors.length === 0, errors };
}

/** Assert-style helper used when loading an external JSON document. */
export function parseWalkthrough(json: string): WalkthroughDocument {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const { valid, errors } = validateWalkthrough(doc);
  if (!valid) {
    throw new Error(`Invalid pr-walkthrough.json:\n - ${errors.join("\n - ")}`);
  }
  return doc as WalkthroughDocument;
}
