import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

// Thin wrappers over the system ffmpeg / ffprobe. Everything the clipper does
// to media flows through here: probe duration, extract+segment audio for
// transcription, and cut individual clips.

export function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
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

/**
 * Cut [startSec, endSec] from the source into a standalone, re-encoded mp4.
 * Re-encoding (not -c copy) gives frame-accurate boundaries instead of
 * snapping to the nearest keyframe — clips are short so the cost is trivial.
 * +faststart so the file streams/plays without a full download.
 */
export async function cutClip(source: string, dest: string, startSec: number, endSec: number): Promise<void> {
  const dur = Math.max(0.1, endSec - startSec);
  await run("ffmpeg", [
    "-y",
    "-ss",
    startSec.toFixed(3),
    "-i",
    source,
    "-t",
    dur.toFixed(3),
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
  ]);
}
