/**
 * Conservative secret redaction for diffs. Used by `--redact` so neither the
 * embedded output (which a teammate might open) nor an AI prompt leaks
 * credentials. Errs toward leaving normal code untouched: it only masks values
 * with strong secret signals (known token prefixes, key blocks, or a
 * secret-ish key name on the same line).
 */

import type { DiffLine, ParsedDiff } from "./types.ts";

const MASK = "«redacted»";

// Standalone tokens with unambiguous secret prefixes/shapes.
const TOKEN_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g, // AWS temp key id
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style
  /\bgh[posru]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{20,}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s'"`]*:[^\s'"`@]+@[^\s'"`]+/gi, // conn string w/ password
];

// key = value / key: value, where the key name looks secret.
const KV_RE =
  /\b(password|passwd|pwd|secret|secret[_-]?key|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token|token|bearer|private[_-]?key|encryption[_-]?key|aws[_-]?secret[_-]?access[_-]?key)\b(\s*[:=]\s*)(['"]?)([^\s'"`]{4,})\3/gi;

const PEM_LINE = /-----(BEGIN|END)[A-Z ]*PRIVATE KEY-----/;

export interface RedactResult {
  diff: ParsedDiff;
  count: number;
}

function redactContent(content: string, counter: { n: number }, inPem: { v: boolean }): string {
  if (PEM_LINE.test(content)) {
    // Toggle PEM block; the boundary lines themselves are kept (no secret).
    inPem.v = /BEGIN/.test(content);
    return content;
  }
  if (inPem.v) {
    if (content.trim()) counter.n++;
    return content.trim() ? MASK : content;
  }

  let out = content;
  let changed = false;

  out = out.replace(KV_RE, (_m, key, sep, q, _val) => {
    changed = true;
    return `${key}${sep}${q}${MASK}${q}`;
  });

  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, () => {
      changed = true;
      return MASK;
    });
  }

  if (changed) counter.n++;
  return out;
}

/** Return a redacted copy of the diff plus how many lines were touched. */
export function redactParsedDiff(diff: ParsedDiff): RedactResult {
  const counter = { n: 0 };
  const files = diff.files.map((f) => {
    const inPem = { v: false };
    return {
      ...f,
      hunks: f.hunks.map((h) => ({
        ...h,
        lines: h.lines.map((l): DiffLine => ({
          ...l,
          content: redactContent(l.content, counter, inPem),
        })),
      })),
    };
  });
  return { diff: { files }, count: counter.n };
}
