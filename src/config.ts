import "dotenv/config";

// Central config. Keys come from a local .env (see .env.example). All of
// these except the model/gateway overrides are required for a full
// slug -> clips run; individual stages assert the ones they need so a
// partial setup still fails with a clear message.

const env = (k: string): string => process.env[k]?.trim() ?? "";

export const config = {
  alchemyApiKey: env("ALCHEMY_API_KEY"),
  openAiApiKey: env("OPENAI_API_KEY"),
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  bankrApiKey: env("BANKR_API_KEY"),

  // SlopComputer is on Ethereum mainnet.
  contract: (env("SLOP_CONTRACT") || "0xf3ce3614fe8cd4294a0bf05d10cfda9d9cbc4886").toLowerCase() as `0x${string}`,

  // Self-hosted kubo gateway behind Caddy (same default the frontpage uses).
  ipfsGateway: env("IPFS_GATEWAY") || "https://media.slop.computer/ipfs",
  // kubo RPC API (/api/v0/add) for PINNING clips during `--publish`. No default
  // — publishing requires it explicitly (e.g. http://127.0.0.1:5001), the same
  // node the relay pins to. Read-only runs (clipping without --publish) ignore it.
  ipfsApiUrl: env("IPFS_API_URL"),

  // whisper-1 is the only OpenAI model that returns word-level timestamps
  // (verbose_json + timestamp_granularities). gpt-4o-transcribe does not.
  transcribeModel: env("CLIPPER_TRANSCRIBE_MODEL") || "whisper-1",

  // Clip-selection model. Direct Anthropic by default; Bankr gateway fallback.
  anthropicModel: env("CLIPPER_ANTHROPIC_MODEL") || "claude-opus-4-7",
  bankrModel: env("CLIPPER_BANKR_MODEL") || "claude-opus-4.7",

  // Adversarial judge re-rank model. Defaults to the selection model; set to a
  // cheaper one (e.g. a Sonnet) to trim credits on the second-opinion pass.
  judgeModel: env("CLIPPER_JUDGE_MODEL") || env("CLIPPER_ANTHROPIC_MODEL") || "claude-opus-4-7",

  // Caption-correction model (refine.ts). It needs strong context-reasoning to
  // recover crypto/AI jargon + proper nouns from rough STT, so it defaults to
  // the selection model rather than a cheaper one.
  refineModel: env("CLIPPER_REFINE_MODEL") || env("CLIPPER_ANTHROPIC_MODEL") || "claude-opus-4-7",

  // Per-clip tweet/post copy (tweets.ts). Defaults to the selection model.
  tweetsModel: env("CLIPPER_TWEETS_MODEL") || env("CLIPPER_ANTHROPIC_MODEL") || "claude-opus-4-7",

  // ffmpeg binaries. The everyday ops (probe / audio extract / plain cut) use
  // the system `ffmpeg`. Burning styled captions needs libass, which the slim
  // homebrew `ffmpeg` lacks — so the burn pass uses the keg-only `ffmpeg-full`
  // (installed alongside, NOT symlinked onto PATH, so the shared system binary
  // your other pipelines call is left untouched). Override either via env.
  ffmpegBin: env("CLIPPER_FFMPEG_BIN") || "ffmpeg",
  ffmpegFullBin: env("CLIPPER_FFMPEG_FULL_BIN") || "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",

  // Burned-caption look — slop.computer theme: dark video, purple/pink text,
  // the word being spoken pops white. ASS colours are &HAABBGGRR (AA=00 opaque,
  // and the bytes are reversed from #RRGGBB). All tunable via env.
  caption: {
    font: env("CLIPPER_CAPTION_FONT") || "Menlo", // monospace, fits slop's code aesthetic; has a Bold face
    scale: Number(env("CLIPPER_CAPTION_SCALE")) || 0.085, // font height as a fraction of video height
    marginV: Number(env("CLIPPER_CAPTION_MARGIN")) || 0.13, // caption baseline height above the bottom, as a fraction of height
    box: env("CLIPPER_CAPTION_BOX") !== "0", // draw a translucent band behind the line (off: CLIPPER_CAPTION_BOX=0)
    boxColor: env("CLIPPER_CAPTION_BOX_COLOR") || "&H1A0A1F", // band fill — dark plum (&HBBGGRR)
    boxAlpha: env("CLIPPER_CAPTION_BOX_ALPHA") || "&H55", // band transparency (&H00 opaque … &HFF clear)
    base: env("CLIPPER_CAPTION_BASE") || "&H00E04DD2", // #D24DE0 purple-magenta — the resting word colour
    active: env("CLIPPER_CAPTION_ACTIVE") || "&H00FFFFFF", // white — the word currently being said
    outline: env("CLIPPER_CAPTION_OUTLINE") || "&H00200818", // #180820 near-black plum — outline for legibility
    glow: env("CLIPPER_CAPTION_GLOW") || "&H00D85FE0", // #E05FD8 pink — outline halo on the live word only
  },
} as const;

export function alchemyRpcUrl(): string {
  if (!config.alchemyApiKey) {
    throw new Error(
      "ALCHEMY_API_KEY is not set. Public RPCs are not allowed — grab a free key at https://dashboard.alchemy.com and put it in .env",
    );
  }
  return `https://eth-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`;
}
