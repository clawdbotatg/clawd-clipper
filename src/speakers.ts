import { findSpan } from "./anchor.js";
import { gatewayUrl } from "./resolve.js";
import type { Segment, Transcript } from "./transcribe.js";

// Speaker attribution — recovers WHO is talking, which the re-transcription
// throws away. whisper gives us word-accurate text + timing but no speakers;
// slop's LIVE transcript JSONL (manifest.transcript.cid) is the opposite — it
// carries a `handle`/`address` per segment but coarse, wall-clock timing from a
// different STT engine. We bridge them: match live lines into the whisper word
// stream to recover the constant video↔wall-clock offset, then attribute any
// clip window to the speaker(s) whose live lines land inside it.
//
// No new clock assumptions: the live `ts` is the relay's receive time (~end of
// utterance). We estimate the offset from the END of a matched tail phrase, so
// the receive-delay skew is baked into the offset constant and cancels when we
// apply the same offset to query a window.

export type LiveLine = { ts: number; speaker: string; text: string };

export type SpeakerShare = { speaker: string; chars: number; pct: number };
export type SpeakerInfo = { primary: string | null; shares: SpeakerShare[] };

export type Alignment = {
  /** wallClockMs ≈ videoSeconds * 1000 + offsetMs (i.e. offsetMs = videoStartMs). */
  offsetMs: number | null;
  matches: number; // how many live lines anchored into the whisper transcript
  spreadMs: number; // inter-quartile spread of the per-line estimates — low = confident
};

const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

/** Build an address→handle map from the manifest's participant roster, so a
 *  live line that only carries an address still resolves to a readable name. */
export function namesFromParticipants(
  participants?: { address?: string | null; handle?: string | null; ens?: string }[] | null,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of participants ?? []) {
    const name = p.handle || p.ens;
    if (p.address && name) map[p.address.toLowerCase()] = name;
  }
  return map;
}

/** Fetch + parse the live transcript JSONL. Keeps spoken lines only (drops the
 *  relay's narrated action rows: music/file/wallet/chess/…). `names` resolves
 *  bare addresses to handles (see {@link namesFromParticipants}). */
export async function fetchLiveTranscript(
  transcriptCid: string,
  names: Record<string, string> = {},
): Promise<LiveLine[]> {
  const res = await fetch(gatewayUrl(transcriptCid));
  if (!res.ok) throw new Error(`live transcript fetch ${res.status} for ${transcriptCid}`);
  const raw = await res.text();
  const out: LiveLine[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: { ts?: number; address?: string | null; handle?: string | null; anonId?: string | null; text?: string; kind?: string };
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o.kind && o.kind !== "speech") continue; // action row, not a spoken line
    if (typeof o.text !== "string" || typeof o.ts !== "number") continue;
    const byAddr = o.address ? names[o.address.toLowerCase()] : undefined;
    const speaker = o.handle || byAddr || (o.address ? short(o.address) : null) || o.anonId || "anon";
    out.push({ ts: o.ts, speaker, text: o.text });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/**
 * Estimate the constant offset between live wall-clock ms and whisper video
 * seconds by matching the tail of each live line into the whisper words and
 * pairing the line's `ts` with the matched phrase's end time. Median over all
 * matches is robust to the lines that don't match (different STT wording) and
 * to per-line jitter; the IQR spread is a confidence signal.
 */
export function alignToVideo(live: LiveLine[], whisper: Transcript): Alignment {
  const ests: number[] = [];
  for (const l of live) {
    const words = l.text.split(/\s+/).filter(Boolean);
    if (words.length < 6) continue;
    // Tail phrase: closest in time to `ts` (receive ≈ utterance end), and long
    // lines tend to be distinctive at the end.
    const quote = words.slice(-8).join(" ");
    const span = findSpan(whisper, quote, "last");
    if (!span) continue;
    ests.push(l.ts - span.end * 1000);
  }
  if (ests.length < 3) return { offsetMs: null, matches: ests.length, spreadMs: 0 };
  const sorted = ests.slice().sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  return { offsetMs: median(ests), matches: ests.length, spreadMs: q(0.75) - q(0.25) };
}

/**
 * Who is talking during [startSec, endSec] of the video. Tallies spoken
 * characters per speaker across the live lines whose (offset-adjusted) ts falls
 * in the window, with a little grace at each edge for straddling lines.
 */
export function attributeWindow(
  live: LiveLine[],
  offsetMs: number,
  startSec: number,
  endSec: number,
  graceMs = 1500,
): SpeakerInfo {
  const lo = startSec * 1000 + offsetMs - graceMs;
  const hi = endSec * 1000 + offsetMs + graceMs;
  const byChars = new Map<string, number>();
  for (const l of live) {
    if (l.ts < lo || l.ts > hi) continue;
    byChars.set(l.speaker, (byChars.get(l.speaker) ?? 0) + l.text.length);
  }
  const total = [...byChars.values()].reduce((a, b) => a + b, 0);
  if (!total) return { primary: null, shares: [] };
  const shares: SpeakerShare[] = [...byChars.entries()]
    .map(([speaker, chars]) => ({ speaker, chars, pct: Math.round((100 * chars) / total) }))
    .sort((a, b) => b.chars - a.chars);
  return { primary: shares[0]!.speaker, shares };
}

/**
 * Attribute a speaker handle to each whisper segment, so the candidate selector
 * can read the transcript as `binji: …` instead of anonymous text — which lets
 * it find back-and-forths and attribute hot-takes to a person. Same ownership
 * model as {@link speakerSpans}: a live line's `ts` is ~the end of its utterance,
 * so it owns the stretch up to that point; a segment is labelled by the live line
 * whose ownership covers the segment's midpoint. Returns an array parallel to
 * `segments` (null where no line owns that time). Best-effort — purely a prompt
 * hint; the verbatim quotes the model returns still match the raw whisper text.
 */
export function labelSegments(segments: Segment[], live: LiveLine[], offsetMs: number): (string | null)[] {
  const pts = live.map(l => ({ t: (l.ts - offsetMs) / 1000, speaker: l.speaker })).sort((a, b) => a.t - b.t);
  if (!pts.length) return segments.map(() => null);
  return segments.map(seg => {
    const mid = (seg.start + seg.end) / 2;
    // First live line whose utterance-end is at/after the segment midpoint owns it.
    const owner = pts.find(p => p.t >= mid);
    return (owner ?? pts[pts.length - 1]!).speaker;
  });
}

/** A stretch of clip-relative time (seconds from the clip's start) owned by one
 *  speaker — what the burned-in nameplate tracks. */
export type SpeakerSpan = { speaker: string; start: number; end: number };

/**
 * Who is talking *when* inside [startSec, endSec], as clip-relative spans so the
 * burned nameplate can switch as the speaker changes. Each live line's `ts` is
 * the relay's receive time (~end of utterance), so a line owns the gap from the
 * previous line up to its own ts; the first line gets a short assumed lead.
 * Consecutive same-speaker spans (and tiny gaps between them) are merged, and
 * slivers shorter than `minSpan` are dropped so the label doesn't flicker.
 */
export function speakerSpans(
  live: LiveLine[],
  offsetMs: number,
  startSec: number,
  endSec: number,
  opts: { leadSec?: number; minSpan?: number } = {},
): SpeakerSpan[] {
  const leadSec = opts.leadSec ?? 3;
  const minSpan = opts.minSpan ?? 0.5;
  const pts = live.map(l => ({ t: (l.ts - offsetMs) / 1000, speaker: l.speaker })).sort((a, b) => a.t - b.t);

  const abs: { speaker: string; s: number; e: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const e = pts[i]!.t;
    const s = i > 0 ? pts[i - 1]!.t : e - leadSec;
    if (e <= startSec || s >= endSec) continue; // no overlap with the clip window
    abs.push({ speaker: pts[i]!.speaker, s: Math.max(s, startSec), e: Math.min(e, endSec) });
  }
  const merged: { speaker: string; s: number; e: number }[] = [];
  for (const r of abs) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === r.speaker && r.s - last.e < 0.6) last.e = r.e;
    else merged.push({ ...r });
  }
  return merged
    .filter(m => m.e - m.s >= minSpan)
    .map(m => ({ speaker: m.speaker, start: m.s - startSec, end: m.e - startSec }));
}
