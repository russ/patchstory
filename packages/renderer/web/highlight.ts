/**
 * Syntax highlighting for diff lines, backed by highlight.js (bundled at build
 * time — it does not become a runtime dependency of the CLI).
 *
 * Highlighting is per-line: each diff line is highlighted independently. This
 * is the standard lightweight approach used by diff viewers; multi-line
 * constructs (block comments, template literals) lose color across the line
 * break, which is an acceptable trade for robustness and small code.
 */

import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import crystal from "highlight.js/lib/languages/crystal";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import csharp from "highlight.js/lib/languages/csharp";
import cpp from "highlight.js/lib/languages/cpp";
import c from "highlight.js/lib/languages/c";
import php from "highlight.js/lib/languages/php";
import elixir from "highlight.js/lib/languages/elixir";
import css from "highlight.js/lib/languages/css";
import scss from "highlight.js/lib/languages/scss";
import less from "highlight.js/lib/languages/less";
import xml from "highlight.js/lib/languages/xml";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import bash from "highlight.js/lib/languages/bash";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import ini from "highlight.js/lib/languages/ini";

const REGISTER: Record<string, any> = {
  javascript, typescript, python, ruby, crystal, go, rust, java, kotlin,
  csharp, cpp, c, php, elixir, css, scss, less, xml, json, yaml, bash,
  shell, sql, markdown, dockerfile, ini,
};
for (const [name, lang] of Object.entries(REGISTER)) hljs.registerLanguage(name, lang);

// File extension / basename -> registered language name.
const EXT: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  vue: "xml", svelte: "xml", html: "xml", htm: "xml", xml: "xml", svg: "xml",
  py: "python", pyi: "python",
  rb: "ruby", rake: "ruby", gemspec: "ruby",
  cr: "crystal",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  cs: "csharp",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  c: "c", h: "c",
  php: "php",
  ex: "elixir", exs: "elixir",
  css: "css",
  scss: "scss", sass: "scss",
  less: "less",
  json: "json", jsonc: "json",
  yml: "yaml", yaml: "yaml",
  sh: "bash", bash: "bash", zsh: "bash",
  fish: "shell",
  sql: "sql",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  toml: "ini", ini: "ini", cfg: "ini",
};
const BASENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  gemfile: "ruby",
  rakefile: "ruby",
  makefile: "bash",
};

/** Resolve a registered language for a path, or null if unknown. */
export function langForPath(path: string): string | null {
  const base = (path.split("/").pop() ?? "").toLowerCase();
  if (BASENAME[base]) return BASENAME[base];
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot + 1);
  return EXT[ext] ?? null;
}

/** Highlight one line of code, returning safe HTML (input is escaped by hljs). */
export function highlightLine(content: string, lang: string): string {
  try {
    return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(content);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
