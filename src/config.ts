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

  // whisper-1 is the only OpenAI model that returns word-level timestamps
  // (verbose_json + timestamp_granularities). gpt-4o-transcribe does not.
  transcribeModel: env("CLIPPER_TRANSCRIBE_MODEL") || "whisper-1",

  // Clip-selection model. Direct Anthropic by default; Bankr gateway fallback.
  anthropicModel: env("CLIPPER_ANTHROPIC_MODEL") || "claude-opus-4-7",
  bankrModel: env("CLIPPER_BANKR_MODEL") || "claude-opus-4.7",
} as const;

export function alchemyRpcUrl(): string {
  if (!config.alchemyApiKey) {
    throw new Error(
      "ALCHEMY_API_KEY is not set. Public RPCs are not allowed — grab a free key at https://dashboard.alchemy.com and put it in .env",
    );
  }
  return `https://eth-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`;
}
