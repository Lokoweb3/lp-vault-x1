/**
 * HTTP side of the live vault key (server/key-card.ts):
 *
 *   GET /api/key/<nft>.json       Metaplex metadata JSON, live (the NFT's uri for new vaults)
 *   GET /api/key/<nft>.png        the 500x500 card, live
 *   GET /api/key/preview.png?pool=&lp=&unlockAt=   the card a vault about to be opened gets
 *
 * Add ?network=testnet for testnet. Responses are cached briefly at the edge; a missing
 * vault (not confirmed yet, or withdrawn) is a 404 that is never cached.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { Network, XDEX_PROGRAM } from "../client/xdex.js";
import { MAX_LOCK_DURATION } from "../client/lp-lock-nft.js";
import { nftMetadata } from "../client/tokens.js";
import { cardSvg, previewCardData, renderPng, vaultCardData } from "./key-card.js";

const DEFAULT_PROGRAM = "8N4E3ZHBiYRMia8Hs27J6f3b9QM8wiTYcMXukSq96Ejf";
const RPC: Record<Network, string> = { mainnet: "https://rpc.mainnet.x1.xyz", testnet: "https://rpc.testnet.x1.xyz" };

/** The metadata URI a new vault's NFT gets (stored on chain, so it must stay stable). */
export const liveKeyUri = (base: string, nftMint: string, network: Network) =>
  `${base.replace(/\/$/, "")}/api/key/${nftMint}.json${network === "testnet" ? "?network=testnet" : ""}`;

const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
const cached = (seconds: number) => `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=86400`;

export async function keyResponse(req: Request, env: Record<string, string | undefined> = process.env) {
  const url = new URL(req.url);
  const m = url.pathname.match(/\/api\/key\/([1-9A-HJ-NP-Za-km-z]{32,44}|preview)\.(png|json)$/);
  if (!m) return text(404, "Not found");
  const [, id, ext] = m;
  const network: Network = url.searchParams.get("network") === "testnet" ? "testnet" : "mainnet";
  const programId = new PublicKey(env[`LP_LOCK_PROGRAM_ID_${network.toUpperCase()}`] || env.LP_LOCK_PROGRAM_ID || DEFAULT_PROGRAM);
  const conn = new Connection(env[`RPC_${network.toUpperCase()}`] || RPC[network], "confirmed");
  const xdex = XDEX_PROGRAM[network];
  const png = (bytes: Uint8Array, seconds: number) =>
    new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png", "cache-control": cached(seconds), "access-control-allow-origin": "*" } });

  try {
    if (id === "preview") {
      if (ext !== "png") return text(404, "Not found");
      let pool: PublicKey;
      try { pool = new PublicKey(url.searchParams.get("pool") ?? ""); } catch { return text(400, "Invalid pool"); }
      const lp = url.searchParams.get("lp") ?? "";
      const unlockAt = Number(url.searchParams.get("unlockAt"));
      const now = Date.now() / 1000;
      if (!/^\d{1,20}$/.test(lp) || !Number.isInteger(unlockAt) || unlockAt < now - 86_400 || unlockAt > now + MAX_LOCK_DURATION + 86_400) return text(400, "Invalid preview");
      const card = await previewCardData(conn, xdex, pool, BigInt(lp), unlockAt, network).catch(() => null);
      if (!card) return text(404, "Not an XDEX pool on this network");
      return png(renderPng(cardSvg(card)), 60);
    }

    const nft = new PublicKey(id);
    const r = await vaultCardData(conn, programId, xdex, nft, network);
    if (!r) return text(404, "No open vault for this key");
    if (ext === "png") return png(renderPng(cardSvg(r.card)), 300);

    const md = await nftMetadata(conn, nft);
    const c = r.card;
    const base = (env.PUBLIC_URL || url.origin).replace(/\/$/, "");
    const net = network === "testnet" ? "&network=testnet" : "";
    // The image link changes hourly so wallets that cache by URL pick up the new numbers.
    const image = `${base}/api/key/${id}.png?v=${Math.floor(Date.now() / 3_600_000)}${net}`;
    const page = `${base}/?network=${network}&nft=${id}`;
    const matures = new Date(c.unlockAt * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
    const json = {
      name: md?.name || `${c.pair} LP Vault`, symbol: md?.symbol || "LPLOCK",
      description: `${c.lpAmount} ${c.pair} XDEX LP (${c.sharePct} of the pool, ${c.amounts} now), locked until ${matures} on X1 ${network}. `
        + `The holder of this NFT claims the LP's trading fees, and the LP itself once the lock ends. The picture updates with the pool. Live details: ${page}`,
      image, external_url: page,
      attributes: [
        { trait_type: "Pair", value: c.pair },
        { trait_type: "Pool", value: c.pool },
        { trait_type: "LP locked", value: c.lpAmount },
        { trait_type: "Pool share", value: c.sharePct },
        { trait_type: "Matures", value: matures },
        { trait_type: "Network", value: `X1 ${network}` },
      ],
      properties: { category: "image", files: [{ uri: image, type: "image/png" }] },
    };
    return new Response(JSON.stringify(json), { headers: { "content-type": "application/json", "cache-control": cached(300), "access-control-allow-origin": "*" } });
  } catch (e) {
    console.error("key render failed:", e);
    return text(502, "Couldn't read the vault right now");
  }
}
