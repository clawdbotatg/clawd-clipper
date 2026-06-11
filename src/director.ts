import { config } from "./config.js";
import type { ResolvedClip } from "./clips.js";
import { clipKey } from "./judge.js";
import { complete, extractJson } from "./llm.js";
import type { EpisodeMeta } from "./resolve.js";
import type { DetectedWindow } from "./vertical.js";

// "Shot director" pass — decides WHAT deserves the bottom tile of each 9:16
// clip. Window detection (vertical.ts) answers "what windows exist and where";
// it can't answer "which one is this conversation ABOUT". Without that, the
// composer pairs the speaker with the first screen share it finds — often an
// idle, irrelevant window — and never considers apps (the chess board mid-match,
// the browser page being read aloud).
//
// One batched call (like judge/refine/tweets). Per clip the model gets who's
// speaking (with % share), the spoken words, and the labels of the windows open
// on the desktop; it returns the labels worth featuring, ordered, or [] when
// the clip is pure conversation (→ the composer prefers cameras). Cached to
// director.json keyed by clip content.

/** clipKey -> ordered window labels to feature ([] = pure conversation, show
 *  cameras). A clip absent from the map means the director didn't rule on it —
 *  the composer falls back to its screen-share heuristic. */
export type Director = Record<string, string[]>;

type RawPick = { index: number; show?: unknown };

function buildPrompt(
  blocks: { title: string; text: string; speakers: string; windows: string[] }[],
  meta: EpisodeMeta | undefined,
): string {
  const ctx: string[] = [];
  if (meta?.title) ctx.push(`Episode: ${meta.title}`);
  if (meta?.oneLiner) ctx.push(`One-liner: ${meta.oneLiner}`);
  if (meta?.topics?.length) ctx.push(`Topics: ${meta.topics.join(", ")}`);

  const clips = blocks
    .map((b, i) => {
      const lines = [
        `--- CLIP ${i} ---`,
        `title: ${b.title}`,
        b.speakers ? `speaking: ${b.speakers}` : "",
        `windows on the desktop: ${b.windows.length ? b.windows.join(" | ") : "(none detected)"}`,
        `transcript: ${b.text}`,
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");

  return `You are the shot director for "slop.computer", a live podcast recorded as a shared DESKTOP: every participant webcam, screen share and app is a window. Each clip below gets re-cut to a 9:16 mobile video showing the current speaker's camera on top and ONE other window below it. Your job: for each clip, decide which window (if any) the conversation is actually ABOUT, so the bottom tile shows the thing being discussed instead of an arbitrary screen.

For each clip you get who is speaking (with their % of the words), the spoken transcript, and the windows open on the desktop during that clip (cameras are listed for context but are handled separately — never pick them).

Rules:
- "show" lists ONLY non-camera windows the dialog genuinely references or that visibly carry the moment: a demo being narrated, a chess game being played and discussed, a website being read aloud, a wallet balance being reacted to. Order by relevance, best first. Usually 0 or 1 entries.
- If they are just talking to each other — no demo, no shared artifact under discussion — return an EMPTY list. The cut then shows the speakers' cameras, which is the right call; do NOT force a window in.
- Never pick TRANSCRIPT (captions are already burned into the clip). Pick CHAT only when the dialog is explicitly reacting to chat messages.
- Copy window labels EXACTLY as listed (the part after the kind prefix is fine, e.g. "CHESS" or "SCREEN — austin").

${ctx.length ? `CONTEXT:\n${ctx.join("\n")}\n` : ""}CLIPS:
${clips}

Return ONLY a JSON object: { "picks": [ { "index": <clip number>, "show": ["<label>", ...] } ] } with one entry per clip, in order. Start with { and end with }.`;
}

/** Make the (batched) call and return per-clip window picks keyed by clip
 *  content. Best-effort: any failure → {} (composer falls back to heuristics). */
export async function directWindows(
  clips: ResolvedClip[],
  windows: Record<string, DetectedWindow[]>,
  meta: EpisodeMeta | undefined,
  log: (m: string) => void = () => {},
): Promise<Director> {
  const out: Director = {};
  if (!clips.length) return out;

  const blocks = clips.map(c => {
    const wins = windows[clipKey(c)] ?? [];
    return {
      title: c.title,
      text: c.text,
      speakers: (c.speakers ?? []).map(s => `${s.speaker} (${s.pct}%)`).join(", "),
      windows: wins.map(w => `${w.kind.toUpperCase()}${w.label ? ` — ${w.label}` : ""}`),
    };
  });

  let parsed: { picks?: RawPick[] };
  try {
    parsed = extractJson<{ picks?: RawPick[] }>(await complete(buildPrompt(blocks, meta), config.directorModel));
  } catch (err) {
    log(`director pass failed (${err instanceof Error ? err.message : err}); composer will use heuristics`);
    return out;
  }

  const byIndex = new Map<number, RawPick>();
  for (const p of parsed.picks ?? []) if (typeof p?.index === "number") byIndex.set(p.index, p);

  let featured = 0;
  clips.forEach((c, i) => {
    const p = byIndex.get(i);
    if (!p) return; // no ruling — leave this clip to the heuristic fallback
    const show = Array.isArray(p.show) ? p.show.filter((s): s is string => typeof s === "string" && !!s.trim()) : [];
    out[clipKey(c)] = show;
    if (show.length) featured++;
  });
  log(`directed ${Object.keys(out).length}/${clips.length} clips · ${featured} feature a window, rest are camera-first`);
  return out;
}
