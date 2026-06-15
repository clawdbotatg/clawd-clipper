import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findSpan } from "./anchor.js";
import { buildAss } from "./ass.js";
import type { RawCandidate } from "./candidates.js";
import { cutClip, cutClipVertical, libassBin, probeSize, spliceSegments } from "./ffmpeg.js";
import { clipKey } from "./judge.js";
import { rawTokens, windowWords, type CaptionToken, type Captions } from "./refine.js";
import type { Segment, Transcript, Word } from "./transcribe.js";
import type { ClipLayout } from "./vertical.js";

// Bounds + padding for a finished clip.
const MIN = 10;
const MAX = 40;
const LEAD = 0.4; // seconds of breathing room before the first word
const TAIL = 0.7; // and after the last
const OVERLAP_DROP = 0.5; // drop a lower-scored clip overlapping a kept one by >50%
// Snap the cut to the enclosing whisper segment's boundary so clips begin and
// end on a natural sentence beat instead of mid-phrase — but never reach more
// than this far for a boundary (guards against a long run-on segment ballooning
// the clip).
const SNAP_MAX = 6;

export type ResolvedClip = {
  title: string;
  reason: string;
  kind: string;
  tags: string[];
  score: number; // selection model's own shareability estimate (0-100)
  start: number;
  end: number;
  duration: number; // actual clip length (for stitched clips, the SUM of spans, not end-start)
  text: string; // transcript inside the clip window
  // Stitched clips only: the ordered word-gap-snapped spans (absolute episode
  // seconds) that splice together into this clip. Absent → a normal contiguous
  // clip (start..end). When present, `start`/`end` are the outer envelope and
  // `duration` is the summed span length.
  segments?: { start: number; end: number }[];
  // Filled in by the adversarial judge pass (judge.ts), if run:
  judgeScore?: number; // independent, skeptical re-score (0-100)
  critique?: string; // the judge's single biggest knock against the clip
  verdict?: "keep" | "cut";
  finalScore?: number; // blend of score + judgeScore used for the final rank
  captionText?: string; // context-corrected caption text (refine.ts), if it ran
  // Filled in by the tweet pass (tweets.ts), if it ran — suggested post copy:
  tweetShort?: string; // one-line scroll-stopper
  tweetLong?: string; // 2-4 sentence version
  // Filled in by speaker attribution (speakers.ts), if a live transcript aligned:
  speaker?: string; // dominant speaker in the clip (handle/ENS, else short addr)
  speakers?: { speaker: string; chars: number; pct: number }[]; // full share split
  speakerSpans?: { speaker: string; start: number; end: number }[]; // clip-relative, for the burned nameplate
};

export type Clip = ResolvedClip & {
  rank: number;
  file: string; // mp4 filename (relative to clips dir)
  srt: string; // srt filename
  mobileFile?: string; // 9:16 mobile mp4 (relative to clips dir), when --vertical
  altMobileFile?: string; // ALT 9:16 mobile mp4 (geometry/alt-config take), when --vertical
};

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "clip";

// Note: snap helpers (snapStart/snapEnd/snapEndDown) are defined below and used
// by makeWindow — function declarations hoist, so order here is cosmetic.

/**
 * Turn anchored word times into a final clip window: snap both edges to
 * sentence/pause boundaries, add breathing room, then enforce MIN/MAX — and
 * when MAX forces a trim, land that trim on a boundary too rather than
 * mid-word. Returns null if the clip can't reach MIN (e.g. near a media edge).
 */
function makeWindow(transcript: Transcript, rawStart: number, rawEnd: number): { start: number; end: number } | null {
  const duration = transcript.duration;
  let s = Math.max(0, snapStart(transcript, rawStart) - LEAD);
  let e = Math.min(duration, snapEnd(transcript, rawEnd) + TAIL);
  if (e - s < MIN) {
    const need = MIN - (e - s);
    s = Math.max(0, s - need / 2);
    e = Math.min(duration, e + need / 2);
  }
  if (e - s > MAX) {
    // Too long: pull the end back to the last natural boundary before the cap,
    // falling back to a hard cut at the cap if none is close enough.
    const target = s + MAX;
    e = snapEndDown(transcript, target) ?? target;
  }
  if (e - s < MIN) return null;
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

// A clean cut lands on a sentence boundary if one is near (whisper punctuates
// its segment text), else on a silence gap, else not at all. whisper segment
// boundaries alone are unreliable — they often break mid-sentence — so we walk
// across continuation segments to the real sentence edge.
const GAP = 0.45; // inter-word silence (s) that reads as a natural beat
const endsSentence = (text: string) => /[.!?]["')\]]?$/.test(text.trim());

// Index of the segment enclosing `t`, else the first segment ending after it.
function segIndexAt(segments: Segment[], t: number): number {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (t >= s.start - 0.25 && t <= s.end + 0.25) return i;
  }
  return segments.findIndex(s => s.end >= t);
}

// Start of the sentence containing `t` — walk back over segments whose
// predecessor didn't end a sentence.
function sentenceStart(segments: Segment[], t: number): number | null {
  let i = segIndexAt(segments, t);
  if (i < 0) return null;
  while (i > 0 && !endsSentence(segments[i - 1]!.text)) i--;
  return segments[i]!.start;
}

// End of the sentence containing `t` — walk forward over segments that don't
// themselves end a sentence.
function sentenceEnd(segments: Segment[], t: number): number | null {
  let i = segIndexAt(segments, t);
  if (i < 0) return null;
  while (i < segments.length - 1 && !endsSentence(segments[i]!.text)) i++;
  return segments[i]!.end;
}

// Nearest silence-gap edge on either side of `t` (fallback when no punctuation).
function pauseBefore(words: Word[], t: number): number | null {
  for (let i = words.length - 1; i > 0; i--) {
    const w = words[i]!;
    if (w.start <= t && w.start - words[i - 1]!.end >= GAP) return w.start;
  }
  return null;
}
function pauseAfter(words: Word[], t: number): number | null {
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i]!;
    if (w.end >= t && words[i + 1]!.start - w.end >= GAP) return w.end;
  }
  return null;
}

/** Pull the clip start back to its sentence start (or a prior pause), ≤ SNAP_MAX. */
function snapStart(transcript: Transcript, t: number): number {
  const s = sentenceStart(transcript.segments, t);
  if (s != null && s <= t && t - s <= SNAP_MAX) return s;
  const p = pauseBefore(transcript.words, t);
  if (p != null && p <= t && t - p <= SNAP_MAX) return p;
  return t;
}

/** Push the clip end out to its sentence end (or a following pause), ≤ SNAP_MAX. */
function snapEnd(transcript: Transcript, t: number): number {
  const e = sentenceEnd(transcript.segments, t);
  if (e != null && e >= t && e - t <= SNAP_MAX) return e;
  const p = pauseAfter(transcript.words, t);
  if (p != null && p >= t && p - t <= SNAP_MAX) return p;
  return t;
}

/** Latest natural stop AT OR BEFORE `t` (sentence end, else pause), ≤ SNAP_MAX
 *  back. Used to land a MAX-length trim on a boundary instead of mid-word. */
function snapEndDown(transcript: Transcript, t: number): number | null {
  let best: number | null = null;
  for (const s of transcript.segments) {
    if (s.end <= t + 0.05 && endsSentence(s.text) && (best == null || s.end > best)) best = s.end;
  }
  if (best != null && t - best <= SNAP_MAX) return best;
  const w = transcript.words;
  for (let i = w.length - 2; i >= 0; i--) {
    if (w[i]!.end <= t && w[i + 1]!.start - w[i]!.end >= GAP && t - w[i]!.end <= SNAP_MAX) return w[i]!.end;
  }
  return null;
}

/**
 * Resolve a STITCHED clip: each span's quotes are anchored, then snapped to
 * word-gap silence (snapStart/snapEnd — the HARD RULE that cuts land between
 * words, never mid-word) with the same breathing room as a normal clip edge.
 * There's no per-span MIN (a span can be short); instead the SUMMED span length
 * is bounded to [MIN, MAX]. Any bad/overlapping/out-of-order span drops the whole
 * clip — a stitch is all-or-nothing. Returns the ordered spans + the envelope.
 */
type CompoundResolved = { segments: { start: number; end: number }[]; start: number; end: number; duration: number; text: string };

function resolveCompound(
  transcript: Transcript,
  spanQuotes: { startQuote: string; endQuote: string }[],
): { ok: true; value: CompoundResolved } | { ok: false; reason: string } {
  const segs: { start: number; end: number }[] = [];
  let prevEnd = -Infinity;
  for (let i = 0; i < spanQuotes.length; i++) {
    const q = spanQuotes[i]!;
    const a = findSpan(transcript, q.startQuote, "first");
    const b = findSpan(transcript, q.endQuote, "last");
    if (!a) return { ok: false, reason: `span ${i + 1} startQuote not found: "${q.startQuote}"` };
    if (!b) return { ok: false, reason: `span ${i + 1} endQuote not found: "${q.endQuote}"` };
    if (b.end <= a.start) return { ok: false, reason: `span ${i + 1} end is before its start` };
    const s = Math.max(0, snapStart(transcript, a.start) - LEAD);
    const e = Math.min(transcript.duration, snapEnd(transcript, b.end) + TAIL);
    if (e - s < 0.5) return { ok: false, reason: `span ${i + 1} is degenerate (<0.5s)` };
    if (s <= prevEnd) return { ok: false, reason: `span ${i + 1} overlaps or precedes span ${i}` };
    segs.push({ start: s, end: e });
    prevEnd = e;
  }
  if (segs.length < 2) return { ok: false, reason: "fewer than 2 valid spans" };
  const duration = segs.reduce((acc, s) => acc + (s.end - s.start), 0);
  if (duration < MIN || duration > MAX) return { ok: false, reason: `summed duration ${duration.toFixed(1)}s outside [${MIN},${MAX}]` };
  const text = segs.map(s => wordsBetween(transcript.words, s.start, s.end)).join(" … ");
  return { ok: true, value: { segments: segs, start: segs[0]!.start, end: segs[segs.length - 1]!.end, duration: +duration.toFixed(2), text } };
}

/** Diagnostic record for one model-proposed stitch — written to out/<slug>/stitches.json
 *  and logged, so a later inspection can see what the model tried and why it was
 *  kept or dropped. */
export type StitchDiag = {
  title: string;
  spanQuotes: { startQuote: string; endQuote: string }[];
  resolved: boolean;
  reason?: string; // why it was dropped (when !resolved)
  segments?: { start: number; end: number }[]; // resolved spans, absolute episode seconds
  durationSec?: number; // summed span length actually kept
  cutSec?: number[]; // duration of each gap removed between consecutive spans
};

/**
 * Re-base each span's word tokens onto the spliced (contiguous) timeline: span k
 * is shifted by the cumulative duration of the spans before it. Within-word
 * timing (whisper word starts — what the karaoke highlight tracks) is preserved,
 * so on the spliced clip the highlighted word stays the position-of-truth; the
 * caller passes clipStart 0 to buildAss / buildSrt.
 */
export function splicedCaptionTokens(words: Word[], segments: { start: number; end: number }[]): CaptionToken[] {
  const out: CaptionToken[] = [];
  let offset = 0;
  for (const seg of segments) {
    const dur = seg.end - seg.start;
    // Only words FULLY inside the span (same tolerance as wordsBetween) — a word
    // straddling the seam must not be painted into both spans or past the cut.
    for (const w of words.filter(x => x.start >= seg.start - 0.05 && x.end <= seg.end + 0.05)) {
      const start = Math.min(dur, Math.max(0, w.start - seg.start));
      const end = Math.min(dur, Math.max(0, w.end - seg.start));
      out.push({ text: w.word.trim(), start: offset + start, end: offset + end });
    }
    offset += dur;
  }
  return out;
}

/** Resolve candidates to concrete time windows, dropping unanchorable / out-of-range ones.
 *  With `stitch`, a candidate's optional `segments` produce a multi-span clip. */
/**
 * Build a single ResolvedClip from an operator-chosen [start,end] window
 * (absolute episode seconds) — the `--clip-at` path. Unlike resolveCandidates
 * this does NOT anchor to a quote (the operator watched the video and has a
 * timestamp, not verbatim words), does NOT enforce the 10-40s product bounds
 * (the window is their call), and is never judged or de-overlapped. By default
 * it still snaps each edge to the nearest sentence beat (within SNAP_MAX) so the
 * cut lands clean; pass {snap:false} (`--clip-exact`) to honour the given times
 * to the frame. Everything downstream — speaker attribution, captions, the 9:16
 * reframe — then runs on it exactly as for an auto-picked clip.
 */
export function resolveManualClip(
  transcript: Transcript,
  spec: { start: number; end: number; title?: string },
  opts: { snap?: boolean } = {},
): ResolvedClip {
  const duration = transcript.duration;
  let s = Math.max(0, Math.min(spec.start, duration));
  let e = Math.max(0, Math.min(spec.end, duration));
  if (!(e > s)) throw new Error(`manual clip end (${spec.end}s) must be after start (${spec.start}s)`);
  if (opts.snap !== false) {
    s = Math.max(0, snapStart(transcript, s) - LEAD);
    e = Math.min(duration, snapEnd(transcript, e) + TAIL);
  }
  return {
    title: spec.title?.trim() || "custom clip",
    reason: "manual clip — operator-specified window",
    kind: "manual",
    tags: [],
    score: 100,
    start: s,
    end: e,
    duration: +(e - s).toFixed(2),
    text: wordsBetween(transcript.words, s, e),
  };
}

export function resolveCandidates(
  candidates: RawCandidate[],
  transcript: Transcript,
  opts: { stitch?: boolean; onStitch?: (d: StitchDiag) => void } = {},
): ResolvedClip[] {
  const resolved = candidates
    .map(c => {
      // Stitched path: main span + the model's follow-up spans, spliced in order.
      if (opts.stitch && c.segments?.length) {
        const spanQuotes = [{ startQuote: c.startQuote, endQuote: c.endQuote }, ...c.segments];
        const comp = resolveCompound(transcript, spanQuotes);
        if (!comp.ok) {
          opts.onStitch?.({ title: c.title, spanQuotes, resolved: false, reason: comp.reason });
          return null;
        }
        const segs = comp.value.segments;
        // Gap durations removed between consecutive kept spans — the "dead middle".
        const cutSec = segs.slice(1).map((s, i) => +(s.start - segs[i]!.end).toFixed(1));
        opts.onStitch?.({
          title: c.title,
          spanQuotes,
          resolved: true,
          segments: segs,
          durationSec: comp.value.duration,
          cutSec,
        });
        return {
          title: c.title,
          reason: c.reason,
          kind: c.kind ?? "",
          tags: Array.isArray(c.tags) ? c.tags : [],
          score: Math.max(0, Math.min(100, Math.round(c.score))),
          start: comp.value.start,
          end: comp.value.end,
          duration: comp.value.duration,
          text: comp.value.text,
          segments: segs,
        };
      }
      const a = findSpan(transcript, c.startQuote, "first");
      const b = findSpan(transcript, c.endQuote, "last");
      if (!a || !b) return null;
      if (b.end <= a.start) return null; // end before start — bad anchor pair
      // makeWindow snaps both edges to sentence/pause boundaries + bounds length.
      const win = makeWindow(transcript, a.start, b.end);
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
  // Skip the test when either side is stitched: a compound clip's [start,end] is
  // its wide envelope (it jumps over a dropped gap), so envelope overlap would be
  // misleading — it could swallow a contiguous clip living in that gap they don't
  // actually share. Stitches are rare and reviewed before publish; let them stand.
  const kept: typeof resolved = [];
  for (const c of resolved) {
    const clash = kept.some(k => {
      if (c.segments?.length || k.segments?.length) return false;
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

// Tidy joined caption text: collapse spaces, pull punctuation onto the prior word.
function joinTokens(tokens: CaptionToken[]): string {
  return tokens
    .map(t => t.text.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:%)\]}…])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .trim();
}

/** Build a clip-relative SRT from caption tokens (carries the refined text). */
function buildSrt(tokens: CaptionToken[], clipStart: number): string {
  // Group ~7 tokens per caption line for readability.
  const lines: string[] = [];
  let idx = 1;
  for (let i = 0; i < tokens.length; i += 7) {
    const group = tokens.slice(i, i + 7);
    if (!group.length) break;
    const a = Math.max(0, group[0]!.start - clipStart);
    const b = Math.max(a + 0.3, group[group.length - 1]!.end - clipStart);
    lines.push(`${idx}\n${toSrtTime(a)} --> ${toSrtTime(b)}\n${joinTokens(group)}\n`);
    idx++;
  }
  return lines.join("\n");
}

export async function buildClips(opts: {
  source: string;
  transcript: Transcript;
  resolved: ResolvedClip[];
  clipsDir: string;
  captions?: Captions; // context-corrected tokens (refine.ts); falls back to raw STT per clip
  burn?: boolean; // burn karaoke captions into the video
  vertical?: boolean; // render 9:16 mobile clips (stacked speaker tiles)
  layouts?: Record<string, ClipLayout>; // per-clip crop boxes (clipKey -> layout), for vertical
  altLayouts?: Record<string, ClipLayout>; // ALT 9:16 layouts (geometry/alt-config take); doubles vertical render
  mobileBg?: string; // slop-desktop background PNG composited behind the tiles (vertical)
  limit?: number;
  log?: (m: string) => void;
}): Promise<Clip[]> {
  const log = opts.log ?? (() => {});
  // Start clean so clips from a prior run (different titles → different
  // filenames) don't linger as orphans.
  await rm(opts.clipsDir, { recursive: true, force: true });
  await mkdir(opts.clipsDir, { recursive: true });

  // Burning styled captions needs a libass-capable ffmpeg + the video's pixel
  // size (so the ASS scales right). If burn was asked for but no libass build
  // is around, warn once and fall back to plain clips rather than failing.
  const wantBurn = opts.burn ?? false;
  const burnBin = wantBurn ? libassBin() : null;
  if (wantBurn && !burnBin) {
    log("burn-in requested but no libass ffmpeg found (set CLIPPER_FFMPEG_FULL_BIN) — writing plain clips");
  }
  // When --vertical is on we emit BOTH a 16:9 landscape clip and a 9:16 mobile
  // clip per pick (the mobile one re-cut with stacked speaker tiles), so the
  // gallery can toggle between them. The landscape ASS is sized to the source;
  // the mobile ASS is a fixed 1080×1920.
  const vertical = opts.vertical ?? false;
  const size = burnBin ? await probeSize(opts.source) : null;

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
    // Stitched clip: splice its word-gap-snapped spans into one contiguous per-
    // clip source FIRST, then treat it as a normal [0, duration] clip — every cut
    // + caption path below works unchanged on `clipSource`. Captions are re-based
    // onto the spliced timeline (so the highlight stays in sync) with clipStart 0.
    const compound = !!(c.segments && c.segments.length > 1);
    let clipSource = opts.source;
    let cutStart = c.start;
    let cutEnd = c.end;
    let captionStart = c.start;
    let splicedPath: string | null = null;
    if (compound) {
      splicedPath = join(opts.clipsDir, `${base}.spliced.mp4`);
      await spliceSegments(opts.source, splicedPath, c.segments!);
      clipSource = splicedPath;
      cutStart = 0;
      cutEnd = c.duration; // summed span length
      captionStart = 0;
    }
    // The burned nameplate's spans are envelope-relative (and would name the
    // dropped speaker) — meaningless on a spliced timeline, so suppress it for
    // stitched clips. Captions are re-based above; nameplates aren't worth it here.
    const nameplateSpans = compound ? undefined : c.speakerSpans;

    // Caption tokens: stitched → re-based per-span raw tokens; single → the
    // corrected ones if refine ran for this clip, else raw STT over the window.
    const tokens = compound
      ? splicedCaptionTokens(opts.transcript.words, c.segments!)
      : (opts.captions?.[clipKey(c)] ?? rawTokens(windowWords(opts.transcript.words, c.start, c.end)));

    log(
      `clip ${rank}/${list.length} [${c.finalScore ?? c.score}] ${c.title} (${c.duration}s${compound ? `, ${c.segments!.length}-span stitch` : ""}${burnBin ? ", burning captions" : ""})`,
    );

    // Landscape (always): write the clip-relative ASS next to the mp4, then cut
    // + burn in one pass (ffmpeg runs in clipsDir so the filter takes a bare
    // basename). Without a libass build, fall back to a plain (un-captioned) cut.
    if (burnBin && size) {
      const assName = `${base}.ass`;
      await writeFile(
        join(opts.clipsDir, assName),
        buildAss(tokens, captionStart, size.width, size.height, { speakerSpans: nameplateSpans }),
      );
      await cutClip(clipSource, join(opts.clipsDir, file), cutStart, cutEnd, {
        assFile: assName,
        bin: burnBin,
        cwd: opts.clipsDir,
      });
    } else {
      await cutClip(clipSource, join(opts.clipsDir, file), cutStart, cutEnd);
    }

    // Mobile (--vertical): a second cut into <base>.mobile.mp4 — the clip's
    // detected windows stacked into 1080×1920 (or blur-pad when tiles are null),
    // with captions burned on the layout's seam.
    let mobileFile: string | undefined;
    if (vertical) {
      mobileFile = `${base}.mobile.mp4`;
      const layout = opts.layouts?.[clipKey(c)];
      const assName = `${base}.mobile.ass`;
      if (burnBin)
        await writeFile(
          join(opts.clipsDir, assName),
          buildAss(tokens, captionStart, 1080, 1920, {
            vertical: true,
            seamFrac: layout?.seamFrac,
            speakerSpans: nameplateSpans,
          }),
        );
      await cutClipVertical(clipSource, join(opts.clipsDir, mobileFile), cutStart, cutEnd, {
        tiles: layout?.tiles ?? null,
        assFile: burnBin ? assName : undefined,
        bin: burnBin ?? undefined,
        cwd: opts.clipsDir,
        bgPath: opts.mobileBg,
      });
    }

    // ALT 9:16 (--vertical, when an alt layout is supplied): a SECOND mobile cut
    // into <base>.alt.mobile.mp4 — the geometry-detector / alt-config take. This
    // is the "double the effort, double the size" pass; it shares the caption ASS
    // shape but on the alt layout's seam.
    let altMobileFile: string | undefined;
    if (vertical && opts.altLayouts) {
      const altLayout = opts.altLayouts[clipKey(c)];
      if (altLayout) {
        altMobileFile = `${base}.alt.mobile.mp4`;
        const altAssName = `${base}.alt.mobile.ass`;
        if (burnBin)
          await writeFile(
            join(opts.clipsDir, altAssName),
            buildAss(tokens, captionStart, 1080, 1920, { vertical: true, seamFrac: altLayout.seamFrac, speakerSpans: nameplateSpans }),
          );
        await cutClipVertical(clipSource, join(opts.clipsDir, altMobileFile), cutStart, cutEnd, {
          tiles: altLayout.tiles ?? null,
          assFile: burnBin ? altAssName : undefined,
          bin: burnBin ?? undefined,
          cwd: opts.clipsDir,
          bgPath: opts.mobileBg,
        });
      }
    }

    await writeFile(join(opts.clipsDir, srt), buildSrt(tokens, captionStart));
    // Drop the per-clip spliced intermediate — it's consumed by the cuts above
    // and must not linger in clipsDir (publish pins the whole dir).
    if (splicedPath) await rm(splicedPath, { force: true });
    clips.push({ rank, ...c, captionText: joinTokens(tokens), file, srt, mobileFile, altMobileFile });
  }
  return clips;
}
