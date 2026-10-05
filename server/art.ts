/**
 * Serves pinned NFT art and metadata at `/api/art/<cid>.<ext>`: plain https links with no
 * `/ipfs/` in the path. Some wallets (X1 Wallet among them) rewrite `/ipfs/` gateway links to
 * a public IPFS gateway that now rate-limits apps, so the image never loads; every NFT that
 * does show in those wallets uses a plain path like this. The CID stays in the link, so the
 * content is still addressable on IPFS without this site.
 *
 * Only small images and JSON are passed through (it is not an open IPFS proxy), and the
 * content is immutable, so it is cached for a year at the edge.
 */
import { DEFAULT_GATEWAY, MAX_IMAGE_BYTES } from "./pin.js";

const TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", json: "application/json" };
const CID = /^(baf[a-z2-7]{50,70}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;

/** The public link for pinned content, served by this route. */
export const artUrl = (base: string, cid: string, ext: string) => `${base.replace(/\/$/, "")}/api/art/${cid}.${ext}`;

/** Fetch a CID from the gateway (or a local stand-in) and serve it with a fixed type. */
export async function artResponse(
  req: Request, env: Record<string, string | undefined> = process.env,
  fetchCid: (cid: string) => Promise<Response> = (cid) =>
    fetch((env.IPFS_GATEWAY || DEFAULT_GATEWAY).replace(/\/?$/, "/") + cid, { signal: AbortSignal.timeout(20_000) }),
) {
  const m = new URL(req.url).pathname.match(/\/api\/art\/([A-Za-z0-9]+)\.([a-z]+)$/);
  if (!m || !CID.test(m[1]) || !TYPES[m[2]]) return new Response("Not found", { status: 404 });
  const [, cid, ext] = m;
  const upstream = await fetchCid(cid).catch(() => null);
  if (!upstream?.ok) return new Response("Not available", { status: 502, headers: { "cache-control": "no-store" } });
  const got = (upstream.headers.get("content-type") ?? "").split(";")[0].trim();
  // Serve only what was asked for: an image as that image type, metadata as JSON.
  const wantJson = ext === "json";
  if (wantJson ? got !== "application/json" && got !== "text/plain" : !got.startsWith("image/")) return new Response("Not found", { status: 404 });
  const body = new Uint8Array(await upstream.arrayBuffer());
  if (body.length > MAX_IMAGE_BYTES) return new Response("Too large", { status: 413 });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": wantJson ? "application/json" : TYPES[ext],
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
      "x-ipfs-cid": cid,
    },
  });
}
