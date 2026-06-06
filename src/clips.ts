import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findSpan } from "./anchor.js";
import type { RawCandidate } from "./candidates.js";
import { cutClip } from "./ffmpeg.js";
import type { Transcript, Word } from "./transcribe.js";

// Bounds + padding for a finished clip.
const MIN = 10;
const MAX = 40;
const LEAD = 0.4; // seconds of breathing room before the first word
const TAIL = 0.7; // and after the last
const OVERLAP_DROP = 0.5; // drop a lower-scored clip overlapping a kept one by >50%

export type ResolvedClip = {
  title: string;
  reason: string;
  kind: string;
  tags: string[];
  score: number; // selection model's own shareability estimate (0-100)
  start: number;
  end: number;
  duration: number;
  text: string; // transcript inside the clip window
  // Filled in by the adversarial judge pass (judge.ts), if run:
  judgeScore?: number; // independent, skeptical re-score (0-100)
  critique?: string; // the judge's single biggest knock against the clip
  verdict?: "keep" | "cut";
  finalScore?: number; // blend of score + judgeScore used for the final rank
};

export type Clip = ResolvedClip & {
  rank: number;
  file: string; // mp4 filename (relative to clips dir)
  srt: string; // srt filename
};

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "clip";

function clamp(start: number, end: number, duration: number): { start: number; end: number } | null {
  let s = Math.max(0, start - LEAD);
  let e = Math.min(duration, end + TAIL);
  if (e - s < MIN) {
    // Too short: grow symmetrically toward MIN, respecting the media bounds.
    const need = MIN - (e - s);
    s = Math.max(0, s - need / 2);
    e = Math.min(duration, e + need / 2);
  }
  if (e - s > MAX) e = s + MAX; // too long: trim the tail, keep the hook
  if (e - s < MIN) return null; // couldn't reach MIN (clip near a media edge)
  return { start: s, end: e };
}

// whisper-1 emits bare word tokens (no leading space), so join with a space
// and tidy up: collapse runs, and pull punctuation back onto the prior word.
function joinWords(words: Word[]): string {
  return words
    .map(w => w.word.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:%)\]}…])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .trim();
}

function wordsBetween(words: Word[], start: number, end: number): string {
  return joinWords(words.filter(w => w.start >= start - 0.05 && w.end <= end + 0.05));
}

/** Resolve candidates to concrete time windows, dropping unanchorable / out-of-range ones. */
export function resolveCandidates(candidates: RawCandidate[], transcript: Transcript): ResolvedClip[] {
  const resolved = candidates
    .map(c => {
      const a = findSpan(transcript, c.startQuote, "first");
      const b = findSpan(transcript, c.endQuote, "last");
      if (!a || !b) return null;
      let lo = a.start;
      let hi = b.end;
      if (hi <= lo) return null; // end before start — bad anchor pair
      const win = clamp(lo, hi, transcript.duration);
      if (!win) return null;
      return {
        title: c.title,
        reason: c.reason,
        kind: c.kind ?? "",
        tags: Array.isArray(c.tags) ? c.tags : [],
        score: Math.max(0, Math.min(100, Math.round(c.score))),
        start: win.start,
        end: win.end,
        duration: +(win.end - win.start).toFixed(2),
        text: wordsBetween(transcript.words, win.start, win.end),
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => b.score - a.score);

  // Greedy de-overlap: keep highest-scored, drop later ones that overlap it heavily.
  const kept: typeof resolved = [];
  for (const c of resolved) {
    const clash = kept.some(k => {
      const ov = Math.min(c.end, k.end) - Math.max(c.start, k.start);
      if (ov <= 0) return false;
      return ov / Math.min(c.duration, k.duration) > OVERLAP_DROP;
    });
    if (!clash) kept.push(c);
  }
  return kept;
}

function toSrtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const f = ms % 1000;
  const p = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(f, 3)}`;
}

/** Build a clip-relative SRT from the words inside the window. */
function buildSrt(words: Word[], start: number, end: number): string {
  const inWin = words.filter(w => w.end > start && w.start < end);
  // Group ~7 words per caption line for readability.
  const lines: string[] = [];
  let idx = 1;
  for (let i = 0; i < inWin.length; i += 7) {
    const group = inWin.slice(i, i + 7);
    if (!group.length) break;
    const a = Math.max(0, group[0]!.start - start);
    const b = Math.max(a + 0.3, group[group.length - 1]!.end - start);
    lines.push(`${idx}\n${toSrtTime(a)} --> ${toSrtTime(b)}\n${joinWords(group)}\n`);
    idx++;
  }
  return lines.join("\n");
}

export async function buildClips(opts: {
  source: string;
  transcript: Transcript;
  resolved: ResolvedClip[];
  clipsDir: string;
  limit?: number;
  log?: (m: string) => void;
}): Promise<Clip[]> {
  const log = opts.log ?? (() => {});
  // Start clean so clips from a prior run (different titles → different
  // filenames) don't linger as orphans.
  await rm(opts.clipsDir, { recursive: true, force: true });
  await mkdir(opts.clipsDir, { recursive: true });
  // Final order = judge-blended score when the judge ran, else the
  // selection score. (resolveCandidates already de-overlapped on score.)
  const ranked = [...opts.resolved].sort((a, b) => (b.finalScore ?? b.score) - (a.finalScore ?? a.score));
  const list = opts.limit ? ranked.slice(0, opts.limit) : ranked;
  const clips: Clip[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    const rank = i + 1;
    const base = `${rank.toString().padStart(2, "0")}_${slugify(c.title)}`;
    const file = `${base}.mp4`;
    const srt = `${base}.srt`;
    log(`clip ${rank}/${list.length} [${c.finalScore ?? c.score}] ${c.title} (${c.duration}s)`);
    await cutClip(opts.source, join(opts.clipsDir, file), c.start, c.end);
    await writeFile(join(opts.clipsDir, srt), buildSrt(opts.transcript.words, c.start, c.end));
    clips.push({ rank, ...c, file, srt });
  }
  return clips;
}
