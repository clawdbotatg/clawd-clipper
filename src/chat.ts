import { gatewayUrl } from "./resolve.js";

// Audience-reaction signal for clip selection. The live chat is the room telling
// you, in real time, which moments landed — a burst of "LOL" / "🔥" / "clip that"
// is a stronger "this is shareable" vote than anything the model can infer from
// the transcript alone. We download the chat JSONL, bucket it over the video
// timeline, and surface the spikes (with a few sample messages) to the candidate
// selector. Best-effort: needs the live-transcript alignment offset to place chat
// wall-clock timestamps onto the video clock; without it we just don't emit the
// signal.

export type ChatLine = { ts: number; handle: string | null; text: string };

/** Fetch + parse the chat JSONL (manifest.chat.cid). Keeps lines with a numeric
 *  `ts` and non-empty text; tolerates unknown extra fields and bad lines. */
export async function fetchChat(chatCid: string): Promise<ChatLine[]> {
  const res = await fetch(gatewayUrl(chatCid));
  if (!res.ok) throw new Error(`chat fetch ${res.status} for ${chatCid}`);
  const raw = await res.text();
  const out: ChatLine[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: { ts?: number; handle?: string | null; text?: string; kind?: string };
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (typeof o.ts !== "number") continue;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (!text) continue;
    out.push({ ts: o.ts, handle: o.handle ?? null, text });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

const BUCKET_SEC = 15; // window over which chat volume is tallied
const MIN_SPIKE = 4; // a bucket needs at least this many messages to count as a spike
const SPIKE_MULT = 2.5; // ...and at least this multiple of the typical (median) bucket
const MAX_SPIKES = 14; // cap the block so it stays a signal, not a second transcript
const MAX_SAMPLES = 3; // sample messages shown per spike
const MAX_SAMPLE_LEN = 60;

/**
 * Summarize chat into a compact "where the room lit up" block for the selector
 * prompt: the highest-volume {@link BUCKET_SEC}s windows, each with a few sample
 * messages, timestamped on the VIDEO clock (chat wall-clock `ts` minus the
 * recovered `offsetMs`). Returns undefined when there's no usable spike — the
 * caller then just omits the signal. Short messages are preferred as samples
 * (reactions like "lol" / "no way" / emoji are the tell, not long takes).
 */
export function chatReactions(chat: ChatLine[], offsetMs: number, durationSec: number): string | undefined {
  if (!chat.length || durationSec <= 0) return undefined;
  const nBuckets = Math.ceil(durationSec / BUCKET_SEC);
  if (nBuckets <= 0) return undefined;
  const buckets: ChatLine[][] = Array.from({ length: nBuckets }, () => []);
  for (const c of chat) {
    const v = (c.ts - offsetMs) / 1000; // video seconds
    if (v < 0 || v > durationSec) continue;
    const b = Math.min(nBuckets - 1, Math.floor(v / BUCKET_SEC));
    buckets[b]!.push(c);
  }
  const counts = buckets.map(b => b.length);
  const nonEmpty = counts.filter(n => n > 0);
  if (!nonEmpty.length) return undefined;
  const base = Math.max(1, median(nonEmpty));
  const threshold = Math.max(MIN_SPIKE, base * SPIKE_MULT);

  const spikes = buckets
    .map((msgs, i) => ({ tSec: i * BUCKET_SEC, count: msgs.length, msgs }))
    .filter(s => s.count >= threshold)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_SPIKES)
    .sort((a, b) => a.tSec - b.tSec); // chronological for the prompt

  if (!spikes.length) return undefined;

  const lines = spikes.map(s => {
    const samples: string[] = [];
    const seen = new Set<string>();
    // Shortest-first: reactions are terse; long messages are usually side-chat.
    for (const m of [...s.msgs].sort((a, b) => a.text.length - b.text.length)) {
      const t = m.text.replace(/\s+/g, " ").slice(0, MAX_SAMPLE_LEN);
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push(t);
      if (samples.length >= MAX_SAMPLES) break;
    }
    return `[${mmss(s.tSec)}] ${s.count} msgs: ${samples.map(t => `"${t}"`).join(", ")}`;
  });

  return lines.join("\n");
}
