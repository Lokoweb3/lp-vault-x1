/**
 * Vault key art stored permanently on X1 through X1 VAULT (https://x1vault.com), as an
 * alternative to pinning it to IPFS. The owner uploads the image on x1vault.com (their wallet
 * pays the one-time storage deposit there); the NFT then points at
 * /api/key/<nft>.json?art=<file address>, and the image is served here at
 *
 *   GET /api/x1vault/<file address>.<ext>      the image; add ?network=testnet for testnet
 *   GET /api/x1vault/<file address>.json       { mime, ext, size, image }: whether it can be used, before locking
 *
 * read straight from the chain: the file account plus one account per 9 KB piece, laid out as
 * in x1vault.com/docs ("Read a file back without this site"). Only sealed, unencrypted PNG,
 * JPEG, WebP or GIF files up to 500 KB whose BLAKE3 hash checks out are served, so it isn't an
 * open proxy for X1 VAULT. Sealed files can't change, so responses are cached for a year.
 *
 * Environment: X1VAULT_PROGRAM_ID (default: the mainnet and testnet program), RPC_MAINNET / RPC_TESTNET.
 */
import { gunzipSync } from "node:zlib";
import { Connection, PublicKey } from "@solana/web3.js";
import { blake3 } from "@noble/hashes/blake3";
import { Network } from "../client/xdex.js";
import { MAX_IMAGE_BYTES, sniffImage } from "./pin.js";

export const X1VAULT_PROGRAM = "34JxpA5LRsuVfvTSDtT1omsuZj6mKmuVKhvd6cQj2VYb";
const RPC: Record<Network, string> = { mainnet: "https://rpc.mainnet.x1.xyz", testnet: "https://rpc.testnet.x1.xyz" };
const INSCRIPTION = Buffer.from([100, 11, 151, 42, 228, 38, 69, 187]);
const CHUNK = Buffer.from([35, 234, 244, 157, 224, 224, 175, 19]);
const PIECE_BYTES = 9216;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export class NotVaultArt extends Error {}

export interface VaultFile {
  mime: string;
  ext: string;
  size: number;
  hash: Buffer;
  chunkCount: number;
  compressed: boolean;
}

export const x1vaultConfig = (network: Network, env: Record<string, string | undefined> = process.env) => ({
  conn: new Connection(env[`RPC_${network.toUpperCase()}`] || RPC[network], "confirmed"),
  programId: new PublicKey(env.X1VAULT_PROGRAM_ID || X1VAULT_PROGRAM),
});

/** The file account's header (Borsh, after the 8-byte discriminator), if it is usable vault key art. */
export async function readVaultFile(conn: Connection, programId: PublicKey, file: PublicKey): Promise<VaultFile> {
  const info = await conn.getAccountInfo(file, "confirmed");
  if (!info || !info.owner.equals(programId)) throw new NotVaultArt("Not an X1 VAULT file on this network");
  const d = info.data;
  if (d.length < 8 || !d.subarray(0, 8).equals(INSCRIPTION)) throw new NotVaultArt("Not an X1 VAULT file on this network");
  try {
    let o = 8 + 1 + 32; // discriminator, version, owner
    const mimeLen = d.readUInt32LE(o); o += 4;
    const mime = d.toString("utf8", o, o + mimeLen).trim().toLowerCase(); o += mimeLen;
    const size = Number(d.readBigUInt64LE(o)); o += 8;
    const hash = Buffer.from(d.subarray(o, o + 32)); o += 32;
    o += 8 + 1; // created_slot, network
    o += d[o] ? 33 : 1; // parent_id
    const chunkCount = d.readUInt32LE(o); o += 4;
    const sealed = d[o] === 1, encrypted = d[o + 1] === 1; o += 2;
    let compressed = false;
    if (d[o] === 1) {
      const len = d.readUInt32LE(o + 1);
      try { compressed = !!JSON.parse(d.toString("utf8", o + 5, o + 5 + len))?.compression?.compressed; } catch { /* no metadata */ }
    }
    if (!sealed) throw new NotVaultArt("That X1 VAULT file isn't sealed yet");
    if (encrypted) throw new NotVaultArt("That X1 VAULT file is encrypted; wallets can't show it");
    if (!EXT[mime]) throw new NotVaultArt("The X1 VAULT file must be a PNG, JPG, WebP or GIF image");
    if (size === 0 || size > MAX_IMAGE_BYTES) throw new NotVaultArt(`The X1 VAULT image must be under ${MAX_IMAGE_BYTES / 1000} KB`);
    if (chunkCount !== Math.ceil(size / PIECE_BYTES)) throw new NotVaultArt("That X1 VAULT file looks damaged");
    return { mime, ext: EXT[mime], size, hash, chunkCount, compressed };
  } catch (e) {
    if (e instanceof NotVaultArt) throw e;
    throw new NotVaultArt("That X1 VAULT file looks damaged");
  }
}

/** Every piece of a file, joined, checked against its BLAKE3 hash and its image type. */
export async function readVaultImage(conn: Connection, programId: PublicKey, file: PublicKey) {
  const f = await readVaultFile(conn, programId, file);
  const pdas = Array.from({ length: f.chunkCount }, (_, i) => {
    const idx = Buffer.alloc(4); idx.writeUInt32LE(i);
    return PublicKey.findProgramAddressSync([Buffer.from("chunk"), file.toBuffer(), idx], programId)[0];
  });
  const infos = await conn.getMultipleAccountsInfo(pdas, "confirmed");
  const parts = infos.map((c, i) => {
    const d = c?.owner.equals(programId) ? c.data : null;
    if (!d || !d.subarray(0, 8).equals(CHUNK) || !d.subarray(8, 40).equals(file.toBuffer()) || d.readUInt32LE(40) !== i)
      throw new NotVaultArt("A piece of that X1 VAULT file is missing");
    return d.subarray(49, 49 + Math.min(d.readUInt32LE(44), PIECE_BYTES));
  });
  let bytes = Buffer.concat(parts).subarray(0, f.size);
  if (bytes.length !== f.size || !Buffer.from(blake3(bytes)).equals(f.hash)) throw new NotVaultArt("That X1 VAULT file doesn't match its hash");
  if (f.compressed) {
    try { bytes = gunzipSync(bytes, { maxOutputLength: MAX_IMAGE_BYTES }); } catch { throw new NotVaultArt("Couldn't unpack that X1 VAULT file"); }
  }
  if (sniffImage(bytes)?.type !== f.mime) throw new NotVaultArt("That X1 VAULT file isn't the image it says it is");
  return { ...f, bytes };
}

/** The public link to a vault file's image, served by vaultArtResponse. */
export const vaultArtUrl = (base: string, file: string, ext: string, network: Network) =>
  `${base.replace(/\/$/, "")}/api/x1vault/${file}.${ext}${network === "testnet" ? "?network=testnet" : ""}`;

export async function vaultArtResponse(req: Request, env: Record<string, string | undefined> = process.env) {
  const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain", "cache-control": "no-store", "access-control-allow-origin": "*" } });
  const url = new URL(req.url);
  const m = url.pathname.match(/\/api\/x1vault\/([1-9A-HJ-NP-Za-km-z]{32,44})\.([a-z]+)$/);
  if (!m || (m[2] !== "json" && !Object.values(EXT).includes(m[2]))) return text(404, "Not found");
  const network: Network = url.searchParams.get("network") === "testnet" ? "testnet" : "mainnet";
  const { conn, programId } = x1vaultConfig(network, env);
  try {
    if (m[2] === "json") {
      // Checks the whole file (every piece and the hash), so a lock never points at art that won't load.
      const f = await readVaultImage(conn, programId, new PublicKey(m[1]));
      const image = vaultArtUrl(env.PUBLIC_URL || url.origin, m[1], f.ext, network);
      return new Response(JSON.stringify({ mime: f.mime, ext: f.ext, size: f.size, image }), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*" },
      });
    }
    const img = await readVaultImage(conn, programId, new PublicKey(m[1]));
    if (img.ext !== m[2]) return text(404, "Not found");
    return new Response(new Uint8Array(img.bytes), {
      headers: {
        "content-type": img.mime,
        "cache-control": "public, max-age=31536000, immutable",
        "access-control-allow-origin": "*",
        "x-blake3": img.hash.toString("hex"),
      },
    });
  } catch (e) {
    if (e instanceof NotVaultArt) return text(404, e.message);
    console.error("x1vault read failed:", e);
    return text(502, "Couldn't read X1 right now");
  }
}
