/**
 * The animated video engine: generate a HyperFrames composition from the
 * walkthrough and render it to MP4. HyperFrames (HTML→video via headless Chrome,
 * frame-accurate) and a TTS engine are invoked through `npx` — no npm runtime
 * dependency is added to patchstory itself.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import type { WalkthroughBundle, DiffFile, Chapter } from "@patchstory/core";
import { highlightLine, langForPath } from "../../web/highlight.ts";
import {
  resolveTool,
  ffprobeDuration,
  synth,
  orderedChapters,
  narrationFor,
  estimateDuration,
  HYPERFRAMES_VERSION,
  type VideoOptions,
  type VideoResult,
  type TtsProvider,
} from "./index.ts";
import { buildComposition, type VideoScene, type CodeRow } from "./composition.ts";

const MAX_ROWS = 13;

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Pick the chapter's most relevant file and window its lines around the spotlight. */
function rowsForChapter(
  c: Chapter,
  fileByPath: Map<string, DiffFile>,
): { rows: CodeRow[]; filePath: string; hasSpots: boolean } {
  const refs = new Map<string, Array<[number, number]>>();
  for (const r of c.diff_hunks ?? []) {
    const arr = refs.get(r.file) ?? [];
    arr.push([r.start_line, r.end_line]);
    refs.set(r.file, arr);
  }

  // Prefer the first file with referenced ranges, else the first with hunks.
  const candidate =
    c.files.find((p) => refs.has(p) && fileByPath.get(p)?.hunks.length) ??
    c.files.find((p) => fileByPath.get(p)?.hunks.length);
  const f = candidate ? fileByPath.get(candidate) : undefined;
  if (!f) return { rows: [], filePath: c.files[0] ?? "", hasSpots: false };

  const fileRefs = refs.get(f.path) ?? null;
  const lang = langForPath(f.path);
  const overlapping = fileRefs
    ? f.hunks.filter((h) => fileRefs.some(([s, e]) => h.newStart <= e && h.newStart + h.newLines >= s))
    : f.hunks;
  const hunks = overlapping.length ? overlapping : f.hunks;

  const all: CodeRow[] = [];
  for (const h of hunks) {
    for (const l of h.lines) {
      const spot =
        !!fileRefs && l.newNumber != null && fileRefs.some(([s, e]) => l.newNumber! >= s && l.newNumber! <= e);
      all.push({
        sign: l.type === "add" ? "+" : l.type === "del" ? "-" : " ",
        num: l.newNumber,
        html: lang ? highlightLine(l.content, lang) : escHtml(l.content),
        spot,
      });
    }
  }

  // Window MAX_ROWS lines centered on the first spotlight (or first add).
  let rows = all;
  if (all.length > MAX_ROWS) {
    let focus = all.findIndex((r) => r.spot);
    if (focus < 0) focus = all.findIndex((r) => r.sign === "+");
    if (focus < 0) focus = 0;
    let start = Math.max(0, focus - Math.floor(MAX_ROWS / 2));
    start = Math.min(start, all.length - MAX_ROWS);
    rows = all.slice(start, start + MAX_ROWS);
  }
  return { rows, filePath: f.path, hasSpots: rows.some((r) => r.spot) };
}

export async function renderVideoHyperframes(
  bundle: WalkthroughBundle,
  opts: VideoOptions,
): Promise<VideoResult> {
  const log = opts.onProgress ?? (() => {});
  const outFile = resolve(opts.out);
  const fps = opts.fps ?? 30;

  // Resolve a *working* ffmpeg/ffprobe and make HyperFrames' child processes use
  // them (PATH prefix), with a Homebrew lib fallback for its loader.
  const ffmpeg = resolveTool("ffmpeg", opts.ffmpeg);
  const ffprobe = resolveTool("ffprobe", opts.ffprobe);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dirname(ffmpeg)}:${process.env.PATH ?? ""}`,
  };
  const brewLib = "/home/linuxbrew/.linuxbrew/opt/ffmpeg/lib";
  if (existsSync(brewLib)) {
    env.LD_LIBRARY_PATH = [brewLib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }

  const provider: TtsProvider =
    opts.tts && opts.tts !== "auto"
      ? opts.tts
      : process.env.ELEVENLABS_API_KEY
        ? "elevenlabs"
        : "kokoro";
  log(`engine: hyperframes · tts: ${provider}`);

  const w = bundle.walkthrough;
  const fileByPath = new Map<string, DiffFile>();
  for (const f of bundle.diff.files) fileByPath.set(f.path, f);

  const projDir = join(dirname(outFile), `.ps-hf-${basename(outFile).replace(/\W+/g, "")}`);
  rmSync(projDir, { recursive: true, force: true });
  const audioDir = join(projDir, "audio");
  mkdirSync(audioDir, { recursive: true });

  // 1) Assemble scene descriptors with their narration text.
  type Pending = { scene: Omit<VideoScene, "start" | "dur" | "voStart" | "voDur" | "audio">; voText: string };
  const pending: Pending[] = [];

  pending.push({
    scene: {
      kind: "title",
      eyebrow: "PatchStory walkthrough",
      title: w.title,
      subtitle: w.summary,
      hasSpots: false,
    },
    voText: w.summary,
  });

  const chapters = orderedChapters(w);
  chapters.forEach((c, i) => {
    const { rows, filePath, hasSpots } = rowsForChapter(c, fileByPath);
    const narration = narrationFor(c) || c.summary;
    pending.push({
      scene: {
        kind: "chapter",
        eyebrow: `Chapter ${i + 1} of ${chapters.length}`,
        title: c.title,
        risk: c.risk_level,
        intent: c.intent,
        filePath,
        rows,
        hasSpots,
      },
      voText: narration,
    });
  });

  pending.push({
    scene: {
      kind: "outro",
      eyebrow: "PatchStory",
      title: "That's the walkthrough.",
      subtitle: "Generated by PatchStory · patchstory render <json> for the interactive version",
      hasSpots: false,
    },
    voText: "",
  });

  // 2) Synthesize narration, measure, and lay scenes out on the timeline.
  const scenes: VideoScene[] = [];
  let cursor = 0;
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    log(`[${i + 1}/${pending.length}] ${p.scene.title}`);
    let audioRel: string | null = null;
    let voDur = 0;
    if (p.voText.trim()) {
      const audioPath = await synth(provider, p.voText, join(audioDir, `line${i}`), opts.voice, env);
      if (audioPath) {
        audioRel = `audio/${basename(audioPath)}`;
        voDur = ffprobeDuration(ffprobe, audioPath);
      }
      if (!voDur) voDur = estimateDuration(p.voText);
    }

    const intro = 0.6;
    const tail = p.scene.kind === "chapter" ? 1.0 : 0.9;
    const dur = p.voText.trim() ? intro + voDur + tail : 3.4;
    scenes.push({ ...p.scene, start: cursor, dur, voStart: cursor + intro, voDur, audio: audioRel });
    cursor += dur;
  }
  const total = cursor;

  // 3) Write the composition project and render it.
  writeFileSync(join(projDir, "index.html"), buildComposition(scenes, total));
  writeFileSync(
    join(projDir, "hyperframes.json"),
    JSON.stringify(
      {
        $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
        paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(projDir, "meta.json"), JSON.stringify({ id: "patchstory", name: "patchstory" }));

  log(`rendering ${scenes.length} scenes (~${Math.round(total)}s) with hyperframes…`);
  mkdirSync(dirname(outFile), { recursive: true });

  const r = spawnSync(
    "npx",
    ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, "render", projDir, "-o", outFile, "-q", "high", "-f", String(fps)],
    { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (r.status !== 0 || !existsSync(outFile)) {
    const tail = ((r.stderr ?? "") + (r.stdout ?? "")).split("\n").slice(-12).join("\n");
    throw new Error(
      `hyperframes render failed.\n${tail}\n\n` +
        "Tip: ensure network access for `npx hyperframes`, or use --engine pan for the offline ffmpeg renderer.",
    );
  }

  if (!opts.keep) rmSync(projDir, { recursive: true, force: true });
  else log(`project kept in ${projDir}`);

  return { file: outFile, sceneCount: scenes.length, durationSec: total, ttsProvider: provider };
}
