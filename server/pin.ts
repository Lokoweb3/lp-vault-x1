/**
 * Pins a lock NFT's art and Metaplex metadata JSON to public IPFS through Pinata, for the
 * web app (the Pinata key must stay on a server). Used by the Vercel function
 * (api/pin.ts) and the local dev server.
 *
 * It isn't an open upload service: the request must name a real XDEX pool on the chosen
 * network and a wallet that holds at least the LP it is about to lock; only a PNG, JPEG,
 * WebP or GIF image up to 500 KB is accepted; and the metadata JSON is built here, not
 * taken from the request.
 *
 * The NFT links point at this site's /api/art/<cid>.<ext> (server/art.ts), not at an /ipfs/
 * gateway path: X1 Wallet shows plain https images but leaves /ipfs/ ones blank.
 *
 * Environment: PINATA_JWT (key with Files: Write), optional PINATA_API_URL, IPFS_GATEWAY
 * (where /api/art reads pinned files; e.g. your dedicated Pinata gateway, ending in /ipfs/),
 * PUBLIC_URL (base of the art links; defaults to the request's own origin), RPC_MAINNET / RPC_TESTNET.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { Network, XDEX_PROGRAM, readPool } from "../client/xdex.js";
import { MAX_LOCK_DURATION } from "../client/lp-lock-nft.js";
import { tokenLabel } from "../client/tokens.js";
import { artUrl } from "./art.js";

export const PINATA_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
export const DEFAULT_GATEWAY = "https://gateway.pinata.cloud/ipfs/";
export const MAX_IMAGE_BYTES = 500_000;
const RPC: Record<Network, string> = { mainnet: "https://rpc.mainnet.x1.xyz", testnet: "https://rpc.testnet.x1.xyz" };

export interface PinRequest {
  network: Network;
  owner: string;
  pool: string;
  nftMint: string;
  lpAmount: string;
  durationSeconds: number;
  name: string;
  symbol: string;
  /** base64 image bytes */
  image: string;
  /** Page that shows the lock live (sent by the site, checked to be http(s)). */
  siteUrl?: string;
}

export class BadRequest extends Error {}

/** The image type from its first bytes, or null if it isn't a PNG, JPEG, WebP or GIF (from x1-reflection-token). */
export function sniffImage(b: Buffer): { type: string; ext: string } | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: "image/png", ext: "png" };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return { type: "image/webp", ext: "webp" };
  if (b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return { type: "image/gif", ext: "gif" };
  return null;
}

export interface Pinner { pin(blob: Blob, filename: string, label: string): Promise<string>; gateway: string }

/** Pinata (or a stand-in with the same API): returns the content ID. */
export function pinata(env: Record<string, string | undefined> = process.env): Pinner | null {
  const jwt = env.PINATA_JWT;
  if (!jwt) return null;
  return {
    gateway: (env.IPFS_GATEWAY || DEFAULT_GATEWAY).replace(/\/?$/, "/"),
    async pin(blob, filename, label) {
      const form = new FormData();
      form.append("file", blob, filename);
      form.append("network", "public"); // public IPFS, so wallets and gateways can fetch it
      form.append("name", label.slice(0, 100));
      const r = await fetch(env.PINATA_API_URL || PINATA_UPLOAD_URL, {
        method: "POST", body: form, headers: { Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(30_000),
      });
      const text = await r.text();
      if (r.status === 401 || r.status === 403) throw new Error("IPFS upload was refused: check the Pinata key has Files: Write.");
      if (!r.ok) throw new Error(`IPFS upload failed (${r.status}): ${text.slice(0, 160)}`);
      const cid = (JSON.parse(text) as { data?: { cid?: string } }).data?.cid;
      if (!cid) throw new Error("IPFS upload returned no content ID");
      return cid;
    },
  };
}

const key = (v: unknown, what: string) => {
  try { return new PublicKey(String(v)); } catch { throw new BadRequest(`Invalid ${what}`); }
};
const fmtUnits = (v: bigint, decimals: number) => {
  const s = v.toString().padStart(decimals + 1, "0");
  return decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "") : s;
};
const fmtDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export async function handlePin(body: PinRequest, pinner: Pinner, artBase: string, env: Record<string, string | undefined> = process.env) {
  const network = body.network;
  if (network !== "mainnet" && network !== "testnet") throw new BadRequest("Unknown network");
  const owner = key(body.owner, "wallet"), poolAddr = key(body.pool, "pool"), nftMint = key(body.nftMint, "NFT mint");
  const name = String(body.name ?? "").trim(), symbol = String(body.symbol ?? "").trim();
  if (!name || Buffer.byteLength(name) > 32) throw new BadRequest("Name must be 1-32 bytes");
  if (!symbol || Buffer.byteLength(symbol) > 10) throw new BadRequest("Symbol must be 1-10 bytes");
  const duration = Number(body.durationSeconds);
  if (!Number.isInteger(duration) || duration <= 0 || duration > MAX_LOCK_DURATION) throw new BadRequest("Invalid lock duration");
  if (!/^\d{1,20}$/.test(String(body.lpAmount))) throw new BadRequest("Invalid LP amount");
  const lpAmount = BigInt(body.lpAmount);
  if (lpAmount <= 0n) throw new BadRequest("Invalid LP amount");
  const image = Buffer.from(String(body.image ?? ""), "base64");
  if (image.length === 0 || image.length > MAX_IMAGE_BYTES) throw new BadRequest(`The image must be under ${MAX_IMAGE_BYTES / 1000} KB`);
  const kind = sniffImage(image);
  if (!kind) throw new BadRequest("The image must be a PNG, JPG, WebP or GIF");

  // Only for real locks: a real XDEX pool, and a wallet holding the LP it's about to lock.
  const conn = new Connection(env[`RPC_${network.toUpperCase()}`] || RPC[network], "confirmed");
  let state;
  try { state = await readPool(conn, XDEX_PROGRAM[network], poolAddr); } catch { throw new BadRequest(`Not an XDEX pool on ${network}`); }
  const { pool, reserves } = state;
  const ata = getAssociatedTokenAddressSync(pool.lpMint, owner, false, TOKEN_PROGRAM_ID);
  const info = await conn.getAccountInfo(ata, "confirmed");
  const held = info ? unpackAccount(ata, info, TOKEN_PROGRAM_ID).amount : 0n;
  if (held < lpAmount) throw new BadRequest("That wallet doesn't hold this much of the pool's LP");

  const [a, b] = await Promise.all(pool.mints.map((m) => tokenLabel(conn, m)));
  const pair = `${a.symbol}/${b.symbol}`;
  const share = Number((lpAmount * 1_000_000n) / pool.lpSupply) / 10_000;
  const value = reserves.map((r, i) => `${fmtUnits((lpAmount * r) / pool.lpSupply, pool.mintDecimals[i])} ${[a, b][i].symbol}`).join(" + ");
  const unlockAt = Math.floor(Date.now() / 1000) + duration;
  const site = body.siteUrl && /^https?:\/\/[^\s]{1,150}$/.test(body.siteUrl) ? body.siteUrl.replace(/\/?$/, "/") : null;
  const page = site ? `${site}?network=${network}&nft=${nftMint.toBase58()}` : undefined;

  const imageCid = await pinner.pin(new Blob([new Uint8Array(image)], { type: kind.type }), `lock.${kind.ext}`, `LP lock art ${nftMint.toBase58()}`);
  const imageUrl = artUrl(artBase, imageCid, kind.ext);
  const json = {
    name, symbol,
    description: `${fmtUnits(lpAmount, pool.lpDecimals)} ${pair} XDEX LP (${share}% of the pool, about ${value} at lock time), `
      + `locked until about ${fmtDate(unlockAt)} on X1 ${network}. The holder of this NFT claims the LP's trading fees, `
      + `and the LP itself once the lock ends.${page ? ` Live details: ${page}` : ""}`,
    image: imageUrl,
    ...(page ? { external_url: page } : {}),
    attributes: [
      { trait_type: "Pair", value: pair },
      { trait_type: "Pool", value: poolAddr.toBase58() },
      { trait_type: "LP locked", value: fmtUnits(lpAmount, pool.lpDecimals) },
      { trait_type: "Pool share", value: `${share}%` },
      { trait_type: "Lock days", value: Math.round(duration / 864) / 100 },
      { trait_type: "Network", value: `X1 ${network}` },
    ],
    properties: { category: "image", files: [{ uri: imageUrl, type: kind.type }] },
  };
  const jsonCid = await pinner.pin(new Blob([JSON.stringify(json)], { type: "application/json" }), "metadata.json", `LP lock metadata ${nftMint.toBase58()}`);
  const uri = artUrl(artBase, jsonCid, "json");
  if (Buffer.byteLength(uri) > 200) throw new Error("The metadata link is longer than Metaplex's 200-byte limit; use a shorter PUBLIC_URL.");
  return { uri, image: imageUrl, metadata: json, cids: { image: imageCid, metadata: jsonCid } };
}

/** Request -> Response wrapper shared by Vercel and the dev server. */
export async function pinResponse(req: Request, pinner: Pinner | null, env: Record<string, string | undefined> = process.env) {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!pinner) return json(503, { error: "Art uploads aren't set up on this site (PINATA_JWT)." });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_IMAGE_BYTES * 1.4 + 10_000) return json(413, { error: "Request too large" });
  try {
    const base = env.PUBLIC_URL || new URL(req.url).origin;
    return json(200, await handlePin(await req.json() as PinRequest, pinner, base, env));
  } catch (e) {
    if (e instanceof BadRequest || e instanceof SyntaxError) return json(400, { error: e.message });
    console.error("pin failed:", e);
    return json(502, { error: e instanceof Error ? e.message : String(e) });
  }
}
