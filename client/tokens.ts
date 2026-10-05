/**
 * Display names for mints: wrapped XNT, Token-2022 metadata (most X1 tokens), or Metaplex
 * metadata; falls back to a shortened address.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";
import { METADATA_PROGRAM_ID, metadataPda } from "./lp-lock-nft.js";

export interface TokenLabel { mint: PublicKey; symbol: string; name: string }

const short = (k: PublicKey) => `${k.toBase58().slice(0, 4)}…${k.toBase58().slice(-4)}`;
const cache = new Map<string, Promise<TokenLabel>>();

/** Metaplex metadata: name, symbol and uri strings after key, update authority and mint. */
function readMetaplex(d: Buffer) {
  let o = 1 + 32 + 32;
  const str = () => {
    const len = d.readUInt32LE(o);
    const s = d.subarray(o + 4, o + 4 + len).toString("utf8").replace(/\0+$/, "").trim();
    o += 4 + len;
    return s;
  };
  const name = str(), symbol = str();
  return { name, symbol, uri: str() };
}

async function lookup(conn: Connection, mint: PublicKey): Promise<TokenLabel> {
  if (mint.equals(NATIVE_MINT)) return { mint, symbol: "XNT", name: "X1 native token" };
  try {
    const info = await conn.getAccountInfo(mint, "confirmed");
    if (info?.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      const m = await getTokenMetadata(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
      if (m?.symbol) return { mint, symbol: m.symbol, name: m.name || m.symbol };
    }
    const md = await conn.getAccountInfo(metadataPda(mint), "confirmed");
    if (md?.owner.equals(METADATA_PROGRAM_ID)) {
      const { name, symbol } = readMetaplex(md.data);
      if (symbol) return { mint, symbol, name: name || symbol };
    }
  } catch { /* fall through */ }
  return { mint, symbol: short(mint), name: mint.toBase58() };
}

export function tokenLabel(conn: Connection, mint: PublicKey) {
  const k = mint.toBase58();
  if (!cache.has(k)) cache.set(k, lookup(conn, mint));
  return cache.get(k)!;
}

/** A Metaplex NFT's name, symbol and metadata URI, or null. */
export async function nftMetadata(conn: Connection, mint: PublicKey) {
  const md = await conn.getAccountInfo(metadataPda(mint), "confirmed");
  if (!md?.owner.equals(METADATA_PROGRAM_ID) || md.data.length < 70) return null;
  try { return readMetaplex(md.data); } catch { return null; }
}
