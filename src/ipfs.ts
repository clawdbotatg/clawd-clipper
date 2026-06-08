import { openAsBlob } from "node:fs";
import { basename } from "node:path";

// Pin bytes/files/JSON to a kubo node via its RPC API (/api/v0/add?pin=true),
// the SAME mechanism the relay uses (slop-computer-live/packages/relay/src/ipfs.ts)
// so clips land on the same IPFS node as the episode video/transcript/chat. kubo
// streams NDJSON; the final line carries the root { Hash }.

async function addToKubo(apiUrl: string, body: FormData, what: string): Promise<{ cid: string; size: number }> {
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/api/v0/add?pin=true&cid-version=1`, { method: "POST", body });
  if (!res.ok) throw new Error(`kubo /api/v0/add (${what}) ${res.status}: ${(await res.text()).slice(-200)}`);
  // The response is one JSON object per line; the LAST with a Hash is the root.
  const text = await res.text();
  let cid = "";
  let size = 0;
  for (const line of text.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { Hash?: string; Size?: string };
      if (j.Hash) {
        cid = j.Hash;
        size = j.Size ? Number(j.Size) : size;
      }
    } catch {
      /* skip non-JSON noise */
    }
  }
  if (!cid) throw new Error(`kubo: ${what} returned no Hash`);
  return { cid, size };
}

/** Pin an in-memory buffer/blob under `filename`. Returns the CID. */
export async function pinBytes(apiUrl: string, bytes: Buffer | Blob, filename: string): Promise<string> {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
  const form = new FormData();
  form.append("file", blob, filename);
  return (await addToKubo(apiUrl, form, filename)).cid;
}

/** Pin a JSON value (pretty-printed). Returns the CID. */
export async function pinJson(apiUrl: string, json: unknown, filename = "data.json"): Promise<string> {
  return pinBytes(apiUrl, Buffer.from(JSON.stringify(json, null, 2), "utf8"), filename);
}

/** Pin a file from disk (streamed, so multi-MB clips don't load into RAM). */
export async function pinFile(apiUrl: string, path: string): Promise<{ cid: string; size: number }> {
  const blob = await openAsBlob(path);
  const form = new FormData();
  form.append("file", blob, basename(path));
  return addToKubo(apiUrl, form, basename(path));
}
