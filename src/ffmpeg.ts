import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

// Thin wrappers over the system ffmpeg / ffprobe. Everything the clipper does
// to media flows through here: probe duration/size, extract+segment audio for
// transcription, cut individual clips, and burn styled captions.

export function run(bin: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", c => (stdout += c.toString()));
    child.stderr.on("data", c => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} exited ${code}: ${stderr.trim().slice(-600)}`));
    });
  });
}

/**
 * `run` with a one-shot retry — for the clip-cut encodes, which occasionally hit
 * a transient ffmpeg `+faststart` failure ("Unable to re-open output file for
 * shifting data"): the moov-relocation pass can't reopen the just-written file.
 * It's not deterministic (the same cut succeeds on a re-run), so a single retry
 * clears it without masking a real, repeatable error.
 */
async function runCut(bin: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  try {
    return await run(bin, args, opts);
  } catch {
    return await run(bin, args, opts);
  }
}

/** Media duration in seconds. */
export async function probeDuration(file: string): Promise<number> {
  const out = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const d = parseFloat(out.trim());
  if (!Number.isFinite(d)) throw new Error(`could not probe duration of ${file}`);
  return d;
}

/**
 * Extract mono 16 kHz mp3 audio and split it into fixed-length segments small
 * enough for the OpenAI 25 MB transcription limit. Returns each segment's path
 * plus its exact start offset (seconds) in the original timeline, so word
 * timestamps from per-segment transcription can be shifted back to absolute.
 */
export async function extractAudioSegments(
  videoFile: string,
  outDir: string,
  segmentSeconds = 600,
): Promise<{ path: string; offset: number }[]> {
  await mkdir(outDir, { recursive: true });
  await run("ffmpeg", [
    "-y",
    "-i",
    videoFile,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    "-f",
    "segment",
    "-segment_time",
    String(segmentSeconds),
    "-reset_timestamps",
    "1",
    "-loglevel",
    "error",
    join(outDir, "chunk_%04d.mp3"),
  ]);
  const names = (await readdir(outDir)).filter(n => /^chunk_\d+\.mp3$/.test(n)).sort();
  const out: { path: string; offset: number }[] = [];
  let offset = 0;
  for (const name of names) {
    const path = join(outDir, name);
    out.push({ path, offset });
    offset += await probeDuration(path);
  }
  return out;
}

/** Pixel dimensions of a video's first video stream. */
export async function probeSize(file: string): Promise<{ width: number; height: number }> {
  const out = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0:s=x",
    file,
  ]);
  const [w, h] = out.trim().split("x").map(Number);
  if (!w || !h) throw new Error(`could not probe size of ${file}`);
  return { width: w, height: h };
}

/**
 * Path to a libass-capable ffmpeg, or null if none is available. The system
 * `ffmpeg` is often a slim build without libass, so caption burn-in routes
 * through the keg-only `ffmpeg-full` (see config). Returns null so callers can
 * gracefully fall back to plain (un-captioned) clips instead of crashing.
 */
let libassChecked: string | null | undefined;
export function libassBin(): string | null {
  if (libassChecked !== undefined) return libassChecked;
  // An explicit override is trusted as-is; otherwise prefer ffmpeg-full if its
  // binary is actually present on disk.
  const candidate = process.env.CLIPPER_FFMPEG_FULL_BIN?.trim() || config.ffmpegFullBin;
  libassChecked = candidate && existsSync(candidate) ? candidate : null;
  return libassChecked;
}

/** Grab a single still frame at `atSec` as a high-quality image — the input we
 *  hand to the vision model for participant-tile detection (see vertical.ts). */
export async function extractFrame(source: string, atSec: number, dest: string): Promise<void> {
  await run(config.ffmpegBin, [
    "-y",
    "-ss",
    atSec.toFixed(3),
    "-i",
    source,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-loglevel",
    "error",
    dest,
  ]);
}

/** A pixel-space crop rectangle within the source frame (already inset/clamped). */
export type CropBox = { x: number; y: number; w: number; h: number };

/** A crop box plus the fraction of the 1920px tall frame it should occupy when
 *  stacked, and how it fills its cell: `cover` (fill + crop overflow — for camera
 *  faces) or `contain` (letterbox — for screen shares so demo content survives).
 *  Weights are relative (normalised by the caller's sum). */
export type StackTile = CropBox & { weight: number; fit: "cover" | "contain" };

// Mobile (9:16) frame geometry, shared by the background renderer (desktop-bg.ts),
// the layout's caption seam (vertical.ts) and the compositor below. The stacked
// speaker tiles don't fill the frame: a slop.computer-style desktop shows through
// as a TITLE BAR + top strip above the tiles and a desktop strip below, so the
// output reads like the native mobileMode. Tiles occupy [videoTop, videoBottom].
export const MOBILE_FRAME = { W: 1080, H: 1920, titleBarH: 104, videoTop: 240, videoBottom: 1680 } as const;
export const mobileVideoAreaH = MOBILE_FRAME.videoBottom - MOBILE_FRAME.videoTop;
/** Map a fraction WITHIN the video area (0=top tile edge, 1=bottom) to a fraction
 *  of the full frame — used to place the caption seam over the composited stack. */
export const mobileSeamFrac = (withinArea: number) => (MOBILE_FRAME.videoTop + withinArea * mobileVideoAreaH) / MOBILE_FRAME.H;

/**
 * Cut [startSec, endSec] into a 1080×1920 (9:16) mobile clip, then burn captions
 * (if `opts.assFile`). Composition depends on `opts.tiles`:
 *   - N tiles    → crop each region and vstack them, each tile's height set by
 *                  its `weight` (so a speaker cam can take 1/3 over a screen at
 *                  2/3, or two cams split 50/50). cover-fit fills each cell.
 *   - none/null  → blur-pad: the whole frame fit on a blurred, zoomed copy of
 *                  itself (the layout-agnostic fallback when tiles can't be found).
 * cover-fit = scale up to fill, then centre-crop the overflow, so tiles fill
 * their cell with no letterbox bars. Input-seek (`-ss` before `-i`) resets
 * timestamps to 0 to match the clip-relative ASS times, exactly like cutClip.
 */
export async function cutClipVertical(
  source: string,
  dest: string,
  startSec: number,
  endSec: number,
  opts: { tiles?: StackTile[] | null; assFile?: string; bin?: string; cwd?: string; bgPath?: string } = {},
): Promise<void> {
  const dur = Math.max(0.1, endSec - startSec);
  const W = MOBILE_FRAME.W;
  const H = MOBILE_FRAME.H;
  const tiles = opts.tiles && opts.tiles.length ? opts.tiles : null;
  // With a background image AND real tiles, the tiles fill only the VIDEO AREA
  // (the desktop/title show as padding above + below); otherwise they fill the
  // whole frame (back-compat, and the blur-pad fallback never uses the bg).
  const useBg = !!opts.bgPath && !!tiles;
  const areaH = useBg ? mobileVideoAreaH : H;
  // cover  = scale up to fill WxH (keep aspect), crop the overflow — no bars.
  // contain = scale down to fit inside WxH (keep aspect), pad the gaps black.
  const cover = (w: number, h: number) =>
    `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
  const contain = (w: number, h: number) =>
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  const fit = (w: number, h: number, mode: "cover" | "contain") => (mode === "contain" ? contain(w, h) : cover(w, h));

  // Build the tile-stack filter that crops each region and vstacks them into a
  // W×(areaH) column. The seeked source CANNOT be an overlay input directly (its
  // timestamps won't framesync against the looped background), so when there's a
  // background we render this stack to a temp clip first (pass 1), then composite
  // (pass 2). Without a background the stack fills the frame and is the output.
  const stackChain = (): string => {
    const total = tiles!.reduce((s, t) => s + (t.weight > 0 ? t.weight : 0), 0) || tiles!.length;
    const heights: number[] = [];
    let used = 0;
    tiles!.forEach((t, i) => {
      const h = i === tiles!.length - 1 ? areaH - used : Math.max(2, Math.round((areaH * t.weight) / total / 2) * 2);
      heights.push(h);
      used += h;
    });
    const parts = tiles!.map((t, i) => `[0:v]crop=${t.w}:${t.h}:${t.x}:${t.y},${fit(W, heights[i]!, t.fit)}[t${i}]`);
    if (tiles!.length === 1) return `${parts[0]!.replace(/\[t0\]$/, "[vs]")}`;
    const labels = tiles!.map((_, i) => `[t${i}]`).join("");
    return `${parts.join(";")};${labels}vstack=inputs=${tiles!.length}[vs]`;
  };

  if (useBg) {
    // PASS 1 — stack the tiles (with audio) into a clean W×areaH temp clip.
    const tmp = `${dest}.stack.mp4`;
    await runCut(
      opts.bin ?? config.ffmpegBin,
      ["-y", "-ss", startSec.toFixed(3), "-i", source, "-t", dur.toFixed(3), "-filter_complex", stackChain(),
        "-map", "[vs]", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-loglevel", "error", tmp],
      { cwd: opts.cwd },
    );
    // PASS 2 — composite the stack onto the looped desktop background (the desktop
    // shows above + below), burn captions, carry the stack's audio.
    let p2 = `[0:v][1:v]overlay=0:${MOBILE_FRAME.videoTop}:shortest=1[vs]`;
    if (opts.assFile) p2 += `;[vs]ass=${opts.assFile}[v]`;
    await runCut(
      opts.bin ?? config.ffmpegBin,
      ["-y", "-loop", "1", "-i", opts.bgPath!, "-i", tmp, "-filter_complex", p2, "-map", opts.assFile ? "[v]" : "[vs]",
        "-map", "1:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac",
        "-b:a", "160k", "-movflags", "+faststart", "-loglevel", "error", dest],
      { cwd: opts.cwd },
    );
    await rm(tmp, { force: true });
    return;
  }

  let chain: string;
  if (tiles) {
    chain = stackChain();
  } else {
    chain =
      `[0:v]split=2[bg][fg];` +
      `[bg]${cover(W, H)},gblur=sigma=28[bgb];` +
      `[fg]scale=${W}:-2[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2[vs]`;
  }
  if (opts.assFile) chain += `;[vs]ass=${opts.assFile}[v]`;
  const vOut = opts.assFile ? "[v]" : "[vs]";

  const args = [
    "-y",
    "-ss",
    startSec.toFixed(3),
    "-i",
    source,
    "-t",
    dur.toFixed(3),
    "-filter_complex",
    chain,
    "-map",
    vOut,
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    "-loglevel",
    "error",
    dest,
  ];
  await runCut(opts.bin ?? config.ffmpegBin, args, { cwd: opts.cwd });
}

/**
 * Cut [startSec, endSec] from the source into a standalone, re-encoded mp4.
 * Re-encoding (not -c copy) gives frame-accurate boundaries instead of
 * snapping to the nearest keyframe — clips are short so the cost is trivial.
 * +faststart so the file streams/plays without a full download.
 *
 * If `opts.assFile` (a basename, resolved against `opts.cwd`) is given, its
 * styled captions are burned into the video in the same pass via libass —
 * which requires a libass-capable ffmpeg (`opts.bin`, default system ffmpeg).
 * Input-seek (`-ss` before `-i`) resets output timestamps to 0, matching the
 * clip-relative ASS times.
 */
export async function cutClip(
  source: string,
  dest: string,
  startSec: number,
  endSec: number,
  opts: { assFile?: string; bin?: string; cwd?: string } = {},
): Promise<void> {
  const dur = Math.max(0.1, endSec - startSec);
  const args = ["-y", "-ss", startSec.toFixed(3), "-i", source, "-t", dur.toFixed(3)];
  // ass=<basename>; ffmpeg runs with cwd=clipsDir so we dodge filtergraph path
  // escaping entirely (slug-derived basenames have no special chars).
  if (opts.assFile) args.push("-vf", `ass=${opts.assFile}`);
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    "-loglevel",
    "error",
    dest,
  );
  await runCut(opts.bin ?? config.ffmpegBin, args, { cwd: opts.cwd });
}
