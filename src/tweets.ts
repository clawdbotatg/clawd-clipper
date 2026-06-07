import { config } from "./config.js";
import type { ResolvedClip } from "./clips.js";
import { clipKey } from "./judge.js";
import { complete, extractJson } from "./llm.js";
import type { Captions } from "./refine.js";
import type { EpisodeMeta } from "./resolve.js";

// Suggested post copy for each clip — a short, punchy tweet and a longer one —
// so the clip is ready to ship to X/Farcaster without writing copy by hand.
//
// One batched call (like the judge / caption passes). The model gets each clip's
// actual spoken words (context-corrected when available), its title/kind, and —
// crucially — the judge's critique, i.e. the single biggest reason it would flop
// cold. The tweet's job is to supply exactly the hook/context that critique says
// is missing, so the copy compensates for the clip's weakness. Cached to
// tweets.json keyed by clip content.

export type TweetPair = { short: string; long: string };
export type Tweets = Record<string, TweetPair>; // keyed by clipKey

type RawTweet = { index: number; short?: string; long?: string };

/** Joined, tidied caption text for a clip — context-corrected if refine ran, else raw. */
function clipText(c: ResolvedClip, captions: Captions): string {
  const toks = captions[clipKey(c)];
  const s = toks ? toks.map(t => t.text.trim()).join(" ") : c.text;
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:%)\]}…])/g, "$1")
    .trim();
}

function buildPrompt(blocks: { text: string; title: string; kind: string; tags: string[]; critique?: string; speaker?: string }[], meta: EpisodeMeta | undefined): string {
  const ctx: string[] = [];
  if (meta?.title) ctx.push(`Episode: ${meta.title}`);
  if (meta?.oneLiner) ctx.push(`One-liner: ${meta.oneLiner}`);
  if (meta?.topics?.length) ctx.push(`Topics: ${meta.topics.join(", ")}`);

  const clips = blocks
    .map((b, i) => {
      const lines = [
        `--- CLIP ${i} ---`,
        `title: ${b.title}`,
        b.kind ? `kind: ${b.kind}` : "",
        b.tags.length ? `tags: ${b.tags.join(", ")}` : "",
        b.speaker ? `speaker: ${b.speaker}` : "",
        b.critique ? `why it might flop cold: ${b.critique}` : "",
        `transcript: ${b.text}`,
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");

  return `You write social posts for "slop.computer", a live podcast for technical builders working with AI agents, LLM tooling, dev tools, and crypto/web3. For each video clip below, write the post copy that ships WITH the clip on X / Farcaster.

For EACH clip, write two options:
- "short": one punchy line, the scroll-stopper. Lead with the hook or the spiciest idea. Under ~180 characters (room for the video). No hashtags, no "🧵", at most one emoji and usually none.
- "long": 2-4 sentences. Set up the idea, land the point, hint at why it's worth watching. Under ~500 characters. A natural sign-off is fine; no hashtag spam, no engagement-bait ("comment below").

Rules:
- Sound like a sharp builder talking to peers — confident, specific, a little irreverent. NOT a marketer, no clickbait clichés ("You won't believe…"), no corporate voice.
- Be accurate to what's actually said in the clip; don't invent claims or numbers.
- Each clip lists "why it might flop cold" — the biggest weakness if seen with no context. Use the copy to SUPPLY that missing hook/context so the post overcomes it.
- Spell names/terms exactly as in the transcript (e.g. Clawd, Claude Code, GPT-4o).
- Plain text only, single paragraph each (no line breaks).

${ctx.length ? `CONTEXT:\n${ctx.join("\n")}\n` : ""}
CLIPS:
${clips}

Return ONLY a JSON object: { "tweets": [ { "index": <clip number>, "short": "<copy>", "long": "<copy>" } ] } with one entry per clip, in order. Start with { and end with }.`;
}

/** Make the (batched) call and return tweet copy keyed by clip content. */
export async function generateTweets(
  clips: ResolvedClip[],
  captions: Captions,
  meta: EpisodeMeta | undefined,
  log: (m: string) => void = () => {},
): Promise<Tweets> {
  const out: Tweets = {};
  if (!clips.length) return out;

  const blocks = clips.map(c => ({
    text: clipText(c, captions),
    title: c.title,
    kind: c.kind,
    tags: c.tags,
    critique: c.critique,
    speaker: c.speaker,
  }));

  let parsed: { tweets?: RawTweet[] };
  try {
    parsed = extractJson<{ tweets?: RawTweet[] }>(await complete(buildPrompt(blocks, meta), config.tweetsModel));
  } catch (err) {
    log(`tweet generation failed (${err instanceof Error ? err.message : err}); skipping`);
    return out;
  }

  const byIndex = new Map<number, RawTweet>();
  for (const t of parsed.tweets ?? []) if (typeof t?.index === "number") byIndex.set(t.index, t);

  let n = 0;
  clips.forEach((c, i) => {
    const t = byIndex.get(i);
    const short = typeof t?.short === "string" ? t.short.trim() : "";
    const long = typeof t?.long === "string" ? t.long.trim() : "";
    if (short || long) {
      out[clipKey(c)] = { short, long };
      n++;
    }
  });
  log(`wrote copy for ${n}/${clips.length} clips`);
  return out;
}

/** Fold tweet copy into the clips (by content key). */
export function applyTweets<T extends ResolvedClip>(clips: T[], tweets: Tweets): T[] {
  return clips.map(c => {
    const t = tweets[clipKey(c)];
    return t ? { ...c, tweetShort: t.short || undefined, tweetLong: t.long || undefined } : c;
  });
}
