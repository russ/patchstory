/**
 * Render a walkthrough to a narrated MP4 — the opt-in counterpart to the
 * in-page "play" mode. Same scene model, but produced as a real, shareable
 * video file using *system* tools (headless Chromium + ffmpeg + a TTS engine),
 * so it adds no npm runtime dependencies. The heavy tools are only touched when
 * someone asks for a video.
 *
 * Pipeline, per scene:
 *   1. Build a deterministic HTML scene (fixed header/caption bands).
 *   2. Headless-screenshot it to one tall PNG.
 *   3. Synthesize narration audio (elevenlabs | espeak-ng | flite | say | none).
 *   4. ffmpeg: slice the PNG into a fixed header, a vertically-panning code
 *      region, and a fixed caption, compose onto a frame, mux the audio.
 * Then concat the per-scene clips into the final MP4.
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import type { WalkthroughBundle, DiffFile, Chapter } from "@patchstory/core";
import {
  buildSceneHtml,
  blocksForChapter,
  sceneHeight,
  FRAME_W,
  FRAME_H,
  HEADER_H,
  CAPTION_H,
  MID_H,
  type SceneSpec,
} from "./scene-html.ts";

export type TtsProvider =
  | "auto"
  | "elevenlabs"
  | "kokoro"
  | "espeak-ng"
  | "flite"
  | "say"
  | "none";

/** Pinned so renders are reproducible. */
export const HYPERFRAMES_VERSION = "0.7.11";

export type VideoEngine = "hyperframes" | "pan";

export interface VideoOptions {
  /** Output .mp4 path. */
  out: string;
  /** "hyperframes" = animated GSAP scenes (default); "pan" = static screenshot pan. */
  engine?: VideoEngine;
  tts?: TtsProvider;
  /** Voice id (elevenlabs) or voice name (espeak-ng/say). */
  voice?: string;
  /** Chrome/Chromium binary override. */
  chrome?: string;
  /** ffmpeg / ffprobe binary overrides (else resolved from PATH / system). */
  ffmpeg?: string;
  ffprobe?: string;
  fps?: number;
  /** Max diff lines shown per scene (keeps pans sane). */
  maxLinesPerScene?: number;
  /** Keep the intermediate working directory. */
  keep?: boolean;
  onProgress?: (msg: string) => void;
}

export interface VideoResult {
  file: string;
  sceneCount: number;
  durationSec: number;
  ttsProvider: TtsProvider;
}

/* ------------------------------ tool helpers ----------------------------- */

function has(bin: string): boolean {
  const r = spawnSync(bin, ["--version"], { stdio: "ignore" });
  return !r.error && (r.status === 0 || r.status === 1); // some print version on stderr/exit 1
}

/**
 * Resolve a tool to a binary that actually *runs* `<bin> -version` cleanly.
 * Guards against a broken/shadowing PATH entry (e.g. a half-upgraded Homebrew
 * ffmpeg missing shared libs) by validating each candidate and falling back to
 * the system location. Honors an explicit override / env var first.
 */
export function resolveTool(name: string, override?: string): string {
  const candidates = [
    override,
    process.env[`PATCHSTORY_${name.toUpperCase()}`],
    name,
    `/usr/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    const r = spawnSync(c, ["-version"], { stdio: "ignore" });
    if (!r.error && r.status === 0) return c;
  }
  throw new Error(
    `${name} not found or not runnable (required for \`patchstory video\`). ` +
      `Install ffmpeg, or set PATCHSTORY_${name.toUpperCase()} to a working binary.`,
  );
}

function hasFlatpakChromium(): boolean {
  const r = spawnSync("flatpak", ["info", "org.chromium.Chromium"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

interface ChromeRunner {
  label: string;
  argv: (args: string[]) => { cmd: string; args: string[] };
}

function resolveChrome(workDir: string, override?: string): ChromeRunner {
  const candidates = override
    ? [override]
    : [
        process.env.PATCHSTORY_CHROME ?? "",
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "chrome",
      ].filter(Boolean);

  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { stdio: "ignore" });
    if (!r.error) return { label: c, argv: (args) => ({ cmd: c, args }) };
  }
  if (hasFlatpakChromium()) {
    return {
      label: "flatpak org.chromium.Chromium",
      argv: (args) => ({
        cmd: "flatpak",
        args: ["run", `--filesystem=${workDir}`, "org.chromium.Chromium", ...args],
      }),
    };
  }
  throw new Error(
    "no Chrome/Chromium found. Install Chromium (or pass --chrome <path>, " +
      "or set PATCHSTORY_CHROME). On Linux, `flatpak install org.chromium.Chromium` also works.",
  );
}

const CHROME_BASE = [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
];

function chromeMeasureHeight(
  chrome: ChromeRunner,
  htmlPath: string,
  profileDir: string,
  fallback: number,
): number {
  const { cmd, args } = chrome.argv([
    ...CHROME_BASE,
    `--user-data-dir=${profileDir}`,
    `--window-size=${FRAME_W},200`,
    "--virtual-time-budget=2500",
    "--dump-dom",
    `file://${htmlPath}`,
  ]);
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 96 * 1024 * 1024 });
  const m = (r.stdout ?? "").match(/<title>(\d+)<\/title>/);
  const h = m ? parseInt(m[1], 10) : NaN;
  return Number.isFinite(h) && h > HEADER_H + CAPTION_H ? h : fallback;
}

function chromeScreenshot(
  chrome: ChromeRunner,
  htmlPath: string,
  outPng: string,
  height: number,
  profileDir: string,
): void {
  const { cmd, args } = chrome.argv([
    ...CHROME_BASE,
    `--user-data-dir=${profileDir}`,
    `--window-size=${FRAME_W},${height}`,
    "--virtual-time-budget=2500",
    `--screenshot=${outPng}`,
    `file://${htmlPath}`,
  ]);
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (!existsSync(outPng)) {
    throw new Error(
      `headless screenshot failed (${chrome.label}). ${(r.stderr ?? "").split("\n").slice(-3).join(" ").trim()}`,
    );
  }
}

/* --------------------------------- ffmpeg -------------------------------- */

export function ffprobeDuration(ffprobe: string, path: string): number {
  const r = spawnSync(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { encoding: "utf8" },
  );
  const d = parseFloat((r.stdout ?? "").trim());
  return Number.isFinite(d) ? d : 0;
}

function ffprobeHeight(ffprobe: string, path: string): number {
  const r = spawnSync(
    ffprobe,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", path],
    { encoding: "utf8" },
  );
  const h = parseInt((r.stdout ?? "").trim(), 10);
  return Number.isFinite(h) ? h : 0;
}

/** Build one scene clip: pan the code between a fixed header and caption. */
function buildClip(
  ffmpeg: string,
  scenePng: string,
  pngHeight: number,
  audioPath: string | null,
  durationSec: number,
  fps: number,
  clipOut: string,
): void {
  const W = FRAME_W;
  const codeH = Math.max(0, pngHeight - HEADER_H - CAPTION_H);
  const D = durationSec.toFixed(3);

  // Crop the panning code window out of the screenshot's middle band.
  let midCrop: string;
  if (codeH > MID_H) {
    const panRange = codeH - MID_H;
    // y travels from the top of the code (HEADER_H) down by panRange over D.
    midCrop = `crop=${W}:${MID_H}:0:'${HEADER_H}+${panRange}*min(t/${D}\\,1)'`;
  } else {
    // Short scene: no pan; show the code at the top of the gap.
    midCrop = `crop=${W}:${Math.max(2, codeH)}:0:${HEADER_H}`;
  }

  const midOverlayY = HEADER_H;
  const filter =
    `[0:v]split=3[a][b][c];` +
    `[a]crop=${W}:${HEADER_H}:0:0[hd];` +
    `[b]crop=${W}:${CAPTION_H}:0:${pngHeight - CAPTION_H}[cap];` +
    `[c]${midCrop}[mid];` +
    `color=c=0x0d1117:s=${W}x${FRAME_H}:r=${fps}:d=${D}[bg];` +
    `[bg][mid]overlay=0:${midOverlayY}[m1];` +
    `[m1][hd]overlay=0:0[m2];` +
    `[m2][cap]overlay=0:${FRAME_H - CAPTION_H},format=yuv420p[v]`;

  const args: string[] = ["-y", "-loop", "1", "-framerate", String(fps), "-i", scenePng];
  if (audioPath) {
    args.push("-i", audioPath);
  } else {
    // Silent track so every clip has uniform streams (clean concat -c copy).
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  }
  args.push(
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", "1:a",
    "-t", D,
    "-r", String(fps),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-preset", "veryfast",
    "-c:a", "aac",
    "-b:a", "160k",
    "-ar", "44100",
    clipOut,
  );

  const r = spawnSync(ffmpeg, args, { encoding: "utf8" });
  if (r.status !== 0 || !existsSync(clipOut)) {
    throw new Error(`ffmpeg failed building a scene clip:\n${(r.stderr ?? "").split("\n").slice(-6).join("\n")}`);
  }
}

function concatClips(ffmpeg: string, clips: string[], outFile: string, workDir: string): void {
  const listPath = join(workDir, "clips.txt");
  writeFileSync(listPath, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const r = spawnSync(
    ffmpeg,
    ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", outFile],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || !existsSync(outFile)) {
    throw new Error(`ffmpeg concat failed:\n${(r.stderr ?? "").split("\n").slice(-6).join("\n")}`);
  }
}

/* ----------------------------------- TTS --------------------------------- */

function pickTts(requested: TtsProvider | undefined): TtsProvider {
  if (requested && requested !== "auto") return requested;
  if (process.env.ELEVENLABS_API_KEY) return "elevenlabs";
  if (has("espeak-ng")) return "espeak-ng";
  if (has("flite")) return "flite";
  if (process.platform === "darwin") return "say";
  return "none";
}

export async function synth(
  provider: TtsProvider,
  text: string,
  outBase: string,
  voice: string | undefined,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (provider === "none" || provider === "auto" || !text.trim()) return null;

  if (provider === "elevenlabs") {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error("ELEVENLABS_API_KEY is not set (needed for --tts elevenlabs).");
    const voiceId = voice || "21m00Tcm4TlvDq8ikWAM"; // Rachel
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    });
    if (!res.ok) {
      throw new Error(`ElevenLabs API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const out = `${outBase}.mp3`;
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    return out;
  }

  if (provider === "kokoro") {
    // Local neural TTS via hyperframes' bundled Kokoro — no API key.
    const out = `${outBase}.wav`;
    const r = spawnSync(
      "npx",
      ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, "tts", text, "-o", out, "-v", voice || "af_heart", "-s", "0.97"],
      { encoding: "utf8", env: env ?? process.env, maxBuffer: 16 * 1024 * 1024 },
    );
    if (r.status !== 0 || !existsSync(out)) {
      throw new Error(`kokoro (hyperframes tts) failed: ${(r.stderr ?? "").slice(-300)}`);
    }
    return out;
  }

  // Local engines read the text from a file (avoids any shell-quoting issues).
  const txtPath = `${outBase}.txt`;
  writeFileSync(txtPath, text);
  const opt = { encoding: "utf8" as const, env: env ?? process.env };

  if (provider === "espeak-ng") {
    const out = `${outBase}.wav`;
    const r = spawnSync("espeak-ng", ["-v", voice || "en-us", "-s", "165", "-w", out, "-f", txtPath], opt);
    if (r.status !== 0 || !existsSync(out)) throw new Error(`espeak-ng failed: ${r.stderr ?? ""}`);
    return out;
  }
  if (provider === "flite") {
    const out = `${outBase}.wav`;
    const r = spawnSync("flite", ["-f", txtPath, "-o", out], opt);
    if (r.status !== 0 || !existsSync(out)) throw new Error(`flite failed: ${r.stderr ?? ""}`);
    return out;
  }
  if (provider === "say") {
    const out = `${outBase}.aiff`;
    const a = ["-o", out, "-f", txtPath];
    if (voice) a.unshift("-v", voice);
    const r = spawnSync("say", a, opt);
    if (r.status !== 0 || !existsSync(out)) throw new Error(`say failed: ${r.stderr ?? ""}`);
    return out;
  }
  return null;
}

/* --------------------------------- scenes -------------------------------- */

export function orderedChapters(w: WalkthroughBundle["walkthrough"]): Chapter[] {
  if (w.reviewer_path?.length) {
    const byId = new Map(w.chapters.map((c) => [c.id, c]));
    const seen = new Set<string>();
    const out: Chapter[] = [];
    for (const id of w.reviewer_path) {
      const c = byId.get(id);
      if (c && !seen.has(id)) {
        out.push(c);
        seen.add(id);
      }
    }
    for (const c of w.chapters) if (!seen.has(c.id)) out.push(c);
    return out;
  }
  return w.chapters;
}

export function narrationFor(c: Chapter): string {
  if (c.narration && c.narration.trim()) return c.narration.trim();
  return [c.intent, c.summary].filter(Boolean).join(" ").trim();
}

export function estimateDuration(text: string): number {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return Math.min(18, Math.max(3.5, words / 2.6));
}

/* --------------------------------- driver -------------------------------- */

export async function renderVideo(
  bundle: WalkthroughBundle,
  opts: VideoOptions,
): Promise<VideoResult> {
  const engine = opts.engine ?? "hyperframes";
  if (engine === "pan") return renderVideoPan(bundle, opts);
  // Dynamic import keeps the static module graph acyclic (hyperframes.ts pulls
  // its shared helpers from here).
  const { renderVideoHyperframes } = await import("./hyperframes.ts");
  return renderVideoHyperframes(bundle, opts);
}

/** The static-screenshot + ffmpeg-pan engine (`--engine pan`). */
async function renderVideoPan(
  bundle: WalkthroughBundle,
  opts: VideoOptions,
): Promise<VideoResult> {
  const log = opts.onProgress ?? (() => {});
  const fps = opts.fps ?? 30;
  const maxLines = opts.maxLinesPerScene ?? 80;
  const outFile = resolve(opts.out);

  const ffmpeg = resolveTool("ffmpeg", opts.ffmpeg);
  const ffprobe = resolveTool("ffprobe", opts.ffprobe);

  const w = bundle.walkthrough;
  const fileByPath = new Map<string, DiffFile>();
  for (const f of bundle.diff.files) fileByPath.set(f.path, f);

  const workDir = join(dirname(outFile), `.ps-video-${basename(outFile).replace(/\W+/g, "")}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const profileDir = join(workDir, "chrome-profile");

  const chrome = resolveChrome(workDir, opts.chrome);
  log(`chrome: ${chrome.label}`);
  const provider = pickTts(opts.tts);
  log(`tts: ${provider}`);

  // Build the scene list: a title card, then one scene per chapter.
  const chapters = orderedChapters(w);
  const specs: SceneSpec[] = [];

  specs.push({
    eyebrow: "PatchStory walkthrough",
    title: w.title,
    caption: w.summary,
    blocks: [],
    hasSpots: false,
  });

  chapters.forEach((c, i) => {
    const refs = new Map<string, Array<[number, number]>>();
    for (const r of c.diff_hunks ?? []) {
      const arr = refs.get(r.file) ?? [];
      arr.push([r.start_line, r.end_line]);
      refs.set(r.file, arr);
    }
    const { blocks, hasSpots } = blocksForChapter(c.files, refs, fileByPath, maxLines);
    specs.push({
      eyebrow: `Chapter ${i + 1} of ${chapters.length}`,
      title: c.title,
      risk: c.risk_level,
      intent: c.intent,
      caption: narrationFor(c) || c.summary,
      blocks,
      hasSpots,
    });
  });

  const clips: string[] = [];
  let total = 0;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const tag = `scene-${String(i).padStart(2, "0")}`;
    log(`[${i + 1}/${specs.length}] ${spec.title}`);

    // 1) HTML → screenshot
    const htmlPath = join(workDir, `${tag}.html`);
    writeFileSync(htmlPath, buildSceneHtml(spec));
    const measured = chromeMeasureHeight(chrome, htmlPath, profileDir, sceneHeight(spec));
    const pngPath = join(workDir, `${tag}.png`);
    chromeScreenshot(chrome, htmlPath, pngPath, measured, profileDir);
    const pngH = ffprobeHeight(ffprobe, pngPath) || measured;

    // 2) narration → audio (+ duration)
    const audioBase = join(workDir, `${tag}-audio`);
    const audio = await synth(provider, spec.caption, audioBase, opts.voice);
    const dur = (audio ? ffprobeDuration(ffprobe, audio) : estimateDuration(spec.caption)) + 0.6;

    // 3) compose the clip
    const clip = join(workDir, `${tag}.mp4`);
    buildClip(ffmpeg, pngPath, pngH, audio, dur, fps, clip);
    clips.push(clip);
    total += dur;
  }

  log(`concatenating ${clips.length} clips…`);
  mkdirSync(dirname(outFile), { recursive: true });
  concatClips(ffmpeg, clips, outFile, workDir);

  if (!opts.keep) rmSync(workDir, { recursive: true, force: true });
  else log(`intermediates kept in ${workDir}`);

  return { file: outFile, sceneCount: specs.length, durationSec: total, ttsProvider: provider };
}
