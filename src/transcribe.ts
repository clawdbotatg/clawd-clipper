import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import OpenAI from "openai";
import { config } from "./config.js";
import { extractAudioSegments, probeDuration } from "./ffmpeg.js";

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
  log("extracting + segmenting audio…");
  const chunks = await extractAudioSegments(opts.videoFile, audioDir);
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
