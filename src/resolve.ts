import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { alchemyRpcUrl, config } from "./config.js";

// Resolve an episode slug to its on-chain record and off-chain manifest.
//
// slop.computer/<slug>  ->  SlopComputer.getEpisodeBySlug(slug)  ->  Episode
// struct whose `manifest` is an ipfs://<cid> pointing at the JSON that lists
// the video / transcript / chat CIDs + the AI-generated meta (title, desc,
// chapters). This mirrors what the frontpage's EpisodeView does client-side.

const IPFS_PREFIX = "ipfs://";

const ABI = [
  {
    type: "function",
    stateMutability: "view",
    name: "getEpisodeBySlug",
    inputs: [{ name: "slug", type: "string" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "id", type: "bytes32" },
          { name: "name", type: "string" },
          { name: "slug", type: "string" },
          { name: "liveSlug", type: "string" },
          { name: "manifest", type: "string" },
          { name: "contractAddr", type: "address" },
          { name: "datetime", type: "uint256" },
          { name: "addedAt", type: "uint256" },
          { name: "nextId", type: "bytes32" },
        ],
      },
    ],
  },
] as const;

export type EpisodeChapter = { tStart: number; title: string };

export type EpisodeMeta = {
  title?: string;
  oneLiner?: string;
  description?: string;
  topics?: string[];
  chapters?: EpisodeChapter[];
};

export type EpisodeManifest = {
  version?: number;
  description?: string;
  video?: { cid: string; durationSeconds?: number; sizeBytes?: number; format?: string };
  transcript?: { cid: string; segmentCount?: number };
  chat?: { cid: string; messageCount?: number };
  meta?: EpisodeMeta;
  participants?: { address: string | null; handle?: string | null; role?: string }[];
};

export type ResolvedEpisode = {
  slug: string;
  name: string;
  manifestCid: string;
  manifest: EpisodeManifest;
  videoUrl: string;
  videoDownloadUrl: string;
};

export const isIpfsUrl = (s: string) => s.startsWith(IPFS_PREFIX);
export const cidOf = (ipfsUrl: string) => (isIpfsUrl(ipfsUrl) ? ipfsUrl.slice(IPFS_PREFIX.length) : ipfsUrl);

/** Resolve an ipfs:// URL (or bare CID) to an HTTP gateway URL. */
export function gatewayUrl(ipfsOrCid: string, filename?: string, download?: boolean): string {
  const cid = cidOf(ipfsOrCid);
  if (!filename) return `${config.ipfsGateway}/${cid}`;
  const dl = download ? "&download=true" : "";
  return `${config.ipfsGateway}/${cid}?filename=${encodeURIComponent(filename)}${dl}`;
}

export async function fetchManifestByCid(manifestCid: string): Promise<EpisodeManifest> {
  const url = gatewayUrl(manifestCid);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`manifest fetch ${res.status} from ${url}`);
  return (await res.json()) as EpisodeManifest;
}

function buildResolved(slug: string, name: string, manifestCid: string, manifest: EpisodeManifest): ResolvedEpisode {
  const videoCid = manifest.video?.cid;
  if (!videoCid) throw new Error(`manifest ${manifestCid} has no video.cid — nothing to clip`);
  const fileName = `${slug}.mp4`;
  return {
    slug,
    name,
    manifestCid,
    manifest,
    videoUrl: gatewayUrl(videoCid, fileName),
    videoDownloadUrl: gatewayUrl(videoCid, fileName, true),
  };
}

/** Standalone path: skip the chain, point straight at a manifest CID. */
export async function resolveByManifestCid(slug: string, manifestCid: string): Promise<ResolvedEpisode> {
  const manifest = await fetchManifestByCid(manifestCid);
  return buildResolved(slug, manifest.meta?.title ?? slug, manifestCid, manifest);
}

/** Full path: slug -> mainnet contract -> manifest. */
export async function resolveBySlug(slug: string): Promise<ResolvedEpisode> {
  const client = createPublicClient({ chain: mainnet, transport: http(alchemyRpcUrl()) });
  const ep = (await client.readContract({
    address: config.contract,
    abi: ABI,
    functionName: "getEpisodeBySlug",
    args: [slug],
  })) as { name: string; slug: string; manifest: string };

  if (!ep.manifest || !isIpfsUrl(ep.manifest)) {
    throw new Error(`episode "${slug}" has no manifest yet (live or unfinalized?) — manifest="${ep.manifest}"`);
  }
  const manifestCid = cidOf(ep.manifest);
  const manifest = await fetchManifestByCid(manifestCid);
  return buildResolved(slug, ep.name || slug, manifestCid, manifest);
}
