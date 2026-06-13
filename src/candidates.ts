import type { EpisodeMeta } from "./resolve.js";
import type { Transcript } from "./transcribe.js";
import { complete, extractJson } from "./llm.js";

// Ask the model to mine the episode for the most shareable 10-40s dialog
// moments. It returns verbatim start/end quotes (NOT timestamps — anchor.ts
// resolves those against the word-timed transcript, so the model can't
// hallucinate a cut point), plus a punchy title, a reason, a shareability
// score, and tags. Existing AI meta (title/description/topics/chapters) is fed
// in as a hint for "what the show was about / what's already flagged notable".

export type RawCandidate = {
  title: string;
  reason: string;
  startQuote: string;
  endQuote: string;
  score: number; // 0-100 shareability, model's own estimate
  tags: string[];
  kind?: string; // "hot-take" | "insight" | "funny" | "story" | "explainer" ...
};

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function buildPrompt(transcript: Transcript, meta: EpisodeMeta | undefined, target: number, ctx: SelectionContext): string {
  // Segment-level view keeps the prompt compact while still giving the model
  // copyable verbatim phrases. Word timing is recovered later from the quotes.
  // When speaker labels are available, prefix each line `handle: text` so the
  // model can spot exchanges and attribute takes — the quote text itself is
  // unchanged, so anchor.ts still matches against the raw whisper words.
  const labels = ctx.speakerLabels;
  const lines = transcript.segments
    .map((s, i) => {
      const who = labels?.[i];
      return who ? `[${mmss(s.start)}] ${who}: ${s.text}` : `[${mmss(s.start)}] ${s.text}`;
    })
    .join("\n");

  const hints: string[] = [];
  if (meta?.title) hints.push(`Episode title: ${meta.title}`);
  if (meta?.oneLiner) hints.push(`One-liner: ${meta.oneLiner}`);
  if (meta?.description) hints.push(`Description: ${meta.description}`);
  if (meta?.topics?.length) hints.push(`Topics: ${meta.topics.join(", ")}`);
  if (meta?.chapters?.length) hints.push(`Chapters: ${meta.chapters.map(c => `${mmss(c.tStart)} ${c.title}`).join(" | ")}`);

  const research = ctx.research?.trim();
  const chat = ctx.chatReactions?.trim();

  return `You are a video editor for "slop.computer", a live podcast for technical builders working with AI agents, LLM tooling, dev tools, and crypto/web3 crossover. Your job: mine a finished episode for the most SHAREABLE short clips — the moments someone would post to X/Farcaster to make people want to watch the whole show.

What makes a great clip (in rough priority):
- A strong, specific opinion or hot take ("X is dead", "everyone is wrong about Y").
- A genuinely useful or surprising insight, crisply stated.
- A funny exchange, a great one-liner, or a self-aware joke.
- A concrete story or reveal (a number, a result, a "we shipped X and Y happened").
- A vivid metaphor or quotable phrasing.
Avoid: pure logistics, dead air, mic checks, "can you hear me", rambling with no payoff, anything that only makes sense with lots of missing context.

Each clip must:
- Be SELF-CONTAINED: it should land without the surrounding hour. Start at a natural sentence start, end on a natural beat.
- Be roughly ${target} seconds of speech, and MUST fall within 10-40 seconds total. Pick start/end quotes that bound that much dialog.

The transcript below is auto speech-to-text (expect minor errors; read charitably). Timestamps are [M:SS] from the start of the video.${labels ? " Each line is prefixed with the speaker's handle — use it to attribute takes and to spot good back-and-forths." : ""}

${research ? `GUEST RESEARCH (host's pre-show dossier — correctly-spelled names, projects, and links; use it to understand who's talking and to spell proper nouns right in titles):\n${research}\n` : ""}${hints.length ? `CONTEXT (AI-generated metadata already produced for this episode — use as a guide to what mattered, not a constraint):\n${hints.join("\n")}\n` : ""}${chat ? `AUDIENCE REACTIONS (the live chat lit up at these moments — a strong signal that something landed; weight clips that overlap these windows, but only if the SPOKEN moment is genuinely good on its own):\n${chat}\n` : ""}
TRANSCRIPT:
${lines}

Return a JSON object: { "clips": [ ... ] } with 12-20 clip candidates, best first. Each clip:
- "title": punchy, max 70 chars, no clickbait, no emoji. What the moment IS.
- "reason": one sentence on why it's shareable.
- "kind": one of "hot-take","insight","funny","story","explainer","metaphor","banter".
- "startQuote": a VERBATIM snippet (6-12 words) copied EXACTLY from the transcript line where the clip should START. Copy the words exactly as written above — do not paraphrase, do not fix STT errors, do not include the [M:SS] timestamp. Pick a distinctive phrase (avoid generic filler).
- "endQuote": a VERBATIM snippet (6-12 words) copied EXACTLY from the transcript line where the clip should END (the last thing said in the clip). Same verbatim rules. It MUST occur AFTER the startQuote and bound ~${target}s of speech.
- "score": integer 0-100, your honest estimate of how shareable/impactful this clip is.
- "tags": 2-5 short lowercase tags.

OUTPUT ONLY THE JSON OBJECT. Start with { and end with }.`;
}

/** Optional, best-effort signals layered onto the selection prompt. Every field
 *  degrades to today's behavior when absent. */
export type SelectionContext = {
  /** Per-segment speaker handles, parallel to `transcript.segments` (speakers.ts). */
  speakerLabels?: (string | null)[];
  /** Pre-formatted "the chat lit up here" block (chat.ts:chatReactions). */
  chatReactions?: string;
  /** Pre-show guest-research dossier text (correctly-spelled proper nouns). */
  research?: string;
};

export async function selectCandidates(opts: {
  transcript: Transcript;
  meta?: EpisodeMeta;
  targetSeconds?: number;
  context?: SelectionContext;
}): Promise<RawCandidate[]> {
  const target = opts.targetSeconds ?? 25;
  const raw = await complete(buildPrompt(opts.transcript, opts.meta, target, opts.context ?? {}));
  const parsed = extractJson<{ clips?: RawCandidate[] }>(raw);
  const clips = parsed.clips ?? [];
  // Light shape sanitation; anchoring + range checks happen downstream.
  return clips.filter(
    c =>
      c &&
      typeof c.title === "string" &&
      typeof c.startQuote === "string" &&
      typeof c.endQuote === "string" &&
      typeof c.score === "number",
  );
}
