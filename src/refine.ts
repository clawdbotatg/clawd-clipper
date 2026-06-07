import { config } from "./config.js";
import type { ResolvedClip } from "./clips.js";
import { clipKey } from "./judge.js";
import { complete, extractJson } from "./llm.js";
import type { EpisodeMeta } from "./resolve.js";
import type { Transcript, Word } from "./transcribe.js";

// Caption correction — the "better than raw STT" pass.
//
// whisper-1 hears a crypto/AI podcast through a generic ear: it spells proper
// nouns wrong, splits jargon ("GPT 4 0"), and can't tell Austin's agent "Clawd"
// from the harness "Claude Code" from the model "Claude". A second pass with
// real context (the episode's own AI meta + a domain glossary) fixes most of
// that — without a human in the loop, per the brief.
//
// The hard constraint is KEEPING WORD-LEVEL TIMING, because the burned captions
// highlight the word being spoken. So this never free-rewrites: the model
// returns only EDITS — spans of source word indices to replace with corrected
// text — and every untouched index passes through as its own raw token. Timing
// is read straight off the source words an edit covers (an edit may merge a few,
// e.g. "GPT 4 0" -> "GPT-4o"). Edits that are out of range or overlap are
// dropped individually, so a bad suggestion never corrupts timing and the worst
// case for any clip is plain raw STT. Returning only the diffs (not every word)
// also keeps the model's output small enough to never truncate.

export type CaptionToken = { text: string; start: number; end: number }; // absolute (episode) seconds
export type Captions = Record<string, CaptionToken[]>; // keyed by clipKey (content hash)

// Domain glossary — THE place to teach the system new vocabulary. These are the
// terms generic STT mangles; listing them (with the distinction that matters)
// lets the model snap a garbled transcription back to the intended word. Edit
// freely as the show's vocabulary grows.
const GLOSSARY = [
  '"Clawd" — the host\'s own personal AI agent (spelled C-L-A-W-D, the slop.computer mascot). Distinct from:',
  '"Claude Code" — Anthropic\'s agentic coding CLI / harness (always two words).',
  '"Claude" — the Anthropic model itself; "Opus", "Sonnet", "Haiku" are its tiers; "Codex" is OpenAI\'s.',
  '"slop.computer" / "slop" — this show / platform. "BuidlGuidl" (one word, that spelling). "Kohaku". "Bankr". "OpenClaw".',
  "People & orgs: Austin Griffith, Anthropic, OpenAI, Vitalik, Farcaster, Vercel.",
  "Crypto: Ethereum, mainnet, onchain, L2, rollup, ENS, gwei, wei, ETH, EVM, smart contract, wallet, gas, IPFS, CID, NFT, DeFi, zk / zero-knowledge.",
  "AI/dev: LLM, agent, agentic, prompt, token, context window, RAG, MCP, embeddings, fine-tune, inference, STT, harness, repo, commit, viem, wagmi, Foundry, hardhat, Next.js, TypeScript, API, SDK.",
];

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Source words inside a clip window — the exact, ordered list the model indexes against. */
export function windowWords(words: Word[], start: number, end: number): Word[] {
  return words.filter(w => w.end > start && w.start < end);
}

/** Raw passthrough: one token per source word (the fallback when refinement is off or fails). */
export function rawTokens(words: Word[]): CaptionToken[] {
  return words.map(w => ({ text: w.word.trim(), start: w.start, end: w.end }));
}

type Edit = { a: number; b: number; t: string }; // replace source words [a..b] (inclusive) with text t

/**
 * Apply the model's edits to a clip's source words, returning timed tokens.
 * Untouched indices pass through as raw 1:1 tokens; an edit collapses its span
 * into one token timed by the words it covers. Invalid edits (out of range,
 * a>b, or overlapping an already-accepted edit) are dropped individually —
 * never throwing, always producing a valid, fully-timed token stream. Returns
 * the tokens plus how many edits actually landed.
 */
function applyEdits(words: Word[], edits: Edit[] | undefined): { tokens: CaptionToken[]; applied: number } {
  const valid = (Array.isArray(edits) ? edits : [])
    .filter(
      e => Number.isInteger(e?.a) && Number.isInteger(e?.b) && e.a >= 0 && e.b >= e.a && e.b < words.length,
    )
    .sort((x, y) => x.a - y.a);

  // Greedily accept non-overlapping edits in index order.
  const accepted: Edit[] = [];
  let guard = -1;
  for (const e of valid) {
    if (e.a <= guard) continue; // overlaps a kept edit
    accepted.push(e);
    guard = e.b;
  }

  const editAt = new Map(accepted.map(e => [e.a, e] as const));
  const tokens: CaptionToken[] = [];
  let i = 0;
  let applied = 0;
  while (i < words.length) {
    const e = editAt.get(i);
    if (e) {
      const text = (typeof e.t === "string" ? e.t : "").trim();
      tokens.push({ text: text || words[i]!.word.trim(), start: words[i]!.start, end: words[e.b]!.end });
      if (text) applied++;
      i = e.b + 1;
    } else {
      tokens.push({ text: words[i]!.word.trim(), start: words[i]!.start, end: words[i]!.end });
      i++;
    }
  }
  return { tokens, applied };
}

function buildPrompt(clips: { words: Word[] }[], meta: EpisodeMeta | undefined): string {
  const hints: string[] = [];
  if (meta?.title) hints.push(`Episode title: ${meta.title}`);
  if (meta?.oneLiner) hints.push(`One-liner: ${meta.oneLiner}`);
  if (meta?.description) hints.push(`Description: ${meta.description}`);
  if (meta?.topics?.length) hints.push(`Topics: ${meta.topics.join(", ")}`);
  if (meta?.chapters?.length)
    hints.push(`Chapters: ${meta.chapters.map(c => `${mmss(c.tStart)} ${c.title}`).join(" | ")}`);

  const blocks = clips
    .map((c, i) => {
      const indexed = c.words.map((w, j) => `[${j}]${w.word.trim()}`).join(" ");
      return `--- CLIP ${i} (${c.words.length} words) ---\n${indexed}`;
    })
    .join("\n\n");

  return `You are cleaning up auto speech-to-text for ON-SCREEN CAPTIONS of "slop.computer", a live podcast for technical builders (AI agents, LLM tooling, dev tools, crypto/web3). Generic STT mangles this show's vocabulary; your job is to recover what was ACTUALLY said using the context below — proper nouns, jargon, casing, and punctuation — so the burned-in captions read correctly.

Each clip is given as INDEXED source words: \`[i]word\`. For each clip, return ONLY the EDITS needed — a list of corrections, where each edit replaces a span of source words [a,b] (inclusive indices) with corrected text. Leave everything you don't list untouched.
- Fix one word: {"a":5,"b":5,"t":"Claude"} (correct only the spelling/casing of word 5).
- Merge a split term: [4]GPT [5]4 [6]0  ->  {"a":4,"b":6,"t":"GPT-4o"}.
- Edits must NOT overlap and should be in ascending index order. If a clip needs no fixes, return an empty list.

RULES:
- Fix only transcription: spelling of names/jargon, casing, obvious mis-hearings, and light punctuation/apostrophes. DO NOT paraphrase, summarize, censor, reorder, or change meaning — the words stay the same words, just spelled/cased right.
- Don't bother editing words that are already correct; only emit edits that change something.
- Use the glossary and episode context to disambiguate. Pay special attention to "Clawd" vs "Claude Code" vs "Claude".
- Keep replacement text the same length in words as the span, EXCEPT when merging a genuinely single term that STT split.

GLOSSARY (intended spellings / the distinction that matters):
${GLOSSARY.map(g => `- ${g}`).join("\n")}

${hints.length ? `EPISODE CONTEXT (what this show was about):\n${hints.join("\n")}\n` : ""}
CLIPS:
${blocks}

Return ONLY a JSON object:
{ "clips": [ { "index": <clip number>, "edits": [ {"a":<int>,"b":<int>,"t":"<corrected text>"}, ... ] } ] }
one entry per clip, in order (empty "edits" if nothing to fix). Start with { and end with }.`;
}

/**
 * Run the (single, batched) correction call and return timed caption tokens
 * keyed by clip content. Clips whose spans don't validate — or every clip, if
 * no model is configured or the call fails — fall back to raw words, so this
 * never throws and never produces misaligned timing.
 */
export async function refineCaptions(
  clips: ResolvedClip[],
  transcript: Transcript,
  meta: EpisodeMeta | undefined,
  log: (m: string) => void = () => {},
): Promise<Captions> {
  const out: Captions = {};
  if (!clips.length) return out;

  const windows = clips.map(c => ({ words: windowWords(transcript.words, c.start, c.end) }));

  let byIndex = new Map<number, Edit[]>();
  try {
    const raw = await complete(buildPrompt(windows, meta), config.refineModel);
    const parsed = extractJson<{ clips?: { index: number; edits?: Edit[] }[] }>(raw);
    for (const entry of parsed.clips ?? []) {
      if (typeof entry?.index === "number") byIndex.set(entry.index, entry.edits ?? []);
    }
  } catch (err) {
    log(`correction call failed (${err instanceof Error ? err.message : err}); using raw STT`);
    byIndex = new Map();
  }

  let corrected = 0;
  let edits = 0;
  clips.forEach((c, i) => {
    const words = windows[i]!.words;
    const { tokens, applied } = applyEdits(words, byIndex.get(i));
    if (applied > 0) corrected++;
    edits += applied;
    out[clipKey(c)] = tokens;
  });
  log(`captions: ${edits} fixes across ${corrected}/${clips.length} clips`);
  return out;
}
