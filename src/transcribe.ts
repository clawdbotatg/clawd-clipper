import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import OpenAI from "openai";
import { config } from "./config.js";
import { extractAudioSegments, extractAudioWindow, probeDuration } from "./ffmpeg.js";

// Word-accurate transcription of the finished video. We re-transcribe the
// downloaded mp4 (rather than reuse the live in-browser transcript) so cut
// points are exact and video-relative — no clock-alignment guesswork. whisper-1
// is the OpenAI model that returns word + segment timestamps via verbose_json.
//
// The audio is split into <=10-min chunks for the 25 MB upload limit; each
// chunk's word/segment times are shifted by the chunk's offset back into the
// full-episode timeline. Result is cached to transcript.json.

export type Word = { start: number; end: number; word: string };
export type Segment = { start: number; end: number; text: string };
export type Transcript = { duration: number; words: Word[]; segments: Segment[] };

type VerboseJsonShape = {
  words?: { start: number; end: number; word: string }[];
  segments?: { start: number; end: number; text: string }[];
};

let cachedClient: OpenAI | null = null;
function client(): OpenAI {
  if (!config.openAiApiKey) throw new Error("OPENAI_API_KEY is not set");
  return (cachedClient ??= new OpenAI({ apiKey: config.openAiApiKey }));
}

async function transcribeChunk(path: string): Promise<VerboseJsonShape> {
  const res = await client().audio.transcriptions.create({
    file: createReadStream(path),
    model: config.transcribeModel,
    response_format: "verbose_json",
    timestamp_granularities: ["word", "segment"],
    language: "en",
  });
  return res as unknown as VerboseJsonShape;
}

export async function transcribeVideo(opts: {
  videoFile: string;
  workDir: string;
  cachePath: string;
  force?: boolean;
  log?: (m: string) => void;
}): Promise<Transcript> {
  const log = opts.log ?? (() => {});
  if (!opts.force) {
    try {
      return JSON.parse(await readFile(opts.cachePath, "utf8")) as Transcript;
    } catch {
      /* no cache */
    }
  }

  const audioDir = join(opts.workDir, "audio");
  log(`extracting + segmenting audio (${config.transcribeChunkSec}s chunks)…`);
  const chunks = await extractAudioSegments(opts.videoFile, audioDir, config.transcribeChunkSec);
  log(`transcribing ${chunks.length} chunk(s) with ${config.transcribeModel}…`);

  const words: Word[] = [];
  const segments: Segment[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const { path, offset } = chunks[i]!;
    log(`  chunk ${i + 1}/${chunks.length} (offset ${offset.toFixed(1)}s)`);
    const r = await transcribeChunk(path);
    for (const w of r.words ?? []) {
      words.push({ start: w.start + offset, end: w.end + offset, word: w.word });
    }
    for (const s of r.segments ?? []) {
      segments.push({ start: s.start + offset, end: s.end + offset, text: s.text.trim() });
    }
  }
  words.sort((a, b) => a.start - b.start);
  segments.sort((a, b) => a.start - b.start);

  const duration = await probeDuration(opts.videoFile);
  const transcript: Transcript = { duration, words, segments };

  await mkdir(dirname(opts.cachePath), { recursive: true });
  await writeFile(opts.cachePath, JSON.stringify(transcript));
  log(`transcript: ${words.length} words, ${segments.length} segments, ${duration.toFixed(0)}s`);
  return transcript;
}

/**
 * Re-transcribe ONE [start,end] audio window on its own — for custom clips
 * (`--clip-at`). The full-episode decode can hallucinate a repeat-loop over a
 * stretch of audio (shafu0x 7:23–8:05 came back as "A film by A film by…"),
 * which would burn garbage captions. A fresh decode of just the window is clean.
 *
 * We transcribe a little PAST `end` (contextTail) so a word cut at the clip
 * boundary has trailing context and doesn't itself trigger a loop, then discard
 * anything beginning at/after `end`. Returned times are absolute (episode) sec.
 */
export async function transcribeWindow(opts: {
  videoFile: string;
  workDir: string;
  start: number;
  end: number;
  contextTail?: number;
  log?: (m: string) => void;
}): Promise<{ words: Word[]; segments: Segment[] }> {
  const log = opts.log ?? (() => {});
  const tail = opts.contextTail ?? 3;
  const audioPath = join(opts.workDir, "audio", `window-${Math.round(opts.start)}-${Math.round(opts.end)}.mp3`);
  await extractAudioWindow(opts.videoFile, opts.start, opts.end + tail, audioPath);
  const r = await transcribeChunk(audioPath);
  // whisper times are relative to the extract start (opts.start) → shift to
  // absolute, and drop anything that begins in the discarded +contextTail.
  const words: Word[] = (r.words ?? [])
    .map(w => ({ start: w.start + opts.start, end: w.end + opts.start, word: w.word }))
    .filter(w => w.start < opts.end - 0.02);
  const segments: Segment[] = (r.segments ?? [])
    .map(s => ({ start: s.start + opts.start, end: s.end + opts.start, text: s.text.trim() }))
    .filter(s => s.start < opts.end - 0.02);
  log(`re-transcribed window: ${words.length} words`);
  return { words, segments };
}
