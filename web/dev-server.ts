/**
 * Local server for the web app: serves web/public and runs the same /api/pin as Vercel.
 *
 *   npm run web:dev                      # PORT=8820; uses PINATA_JWT if set
 *   FAKE_PIN=1 npm run web:dev           # no Pinata: pins kept in memory, served at /ipfs/<cid>
 *   RPC_MAINNET=http://127.0.0.1:8899    # the pin check reads this RPC (match the page's ?rpc=)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Pinner, pinResponse, pinata } from "../server/pin.js";
import { artResponse } from "../server/art.js";
import { keyResponse } from "../server/key-route.js";

const PORT = Number(process.env.PORT ?? 8820);
const ROOT = path.resolve("web/public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

const fakeStore = new Map<string, { type: string; bytes: Buffer }>();
const fakePinner: Pinner = {
  gateway: `http://localhost:${PORT}/ipfs/`,
  async pin(blob) {
    const bytes = Buffer.from(await blob.arrayBuffer());
    // Shaped like a real CIDv1 (base32), so it passes the same checks as Pinata's.
    let bits = "", b32 = "";
    for (const byte of crypto.createHash("sha256").update(bytes).digest()) bits += byte.toString(2).padStart(8, "0");
    for (let i = 0; i + 5 <= bits.length; i += 5) b32 += "abcdefghijklmnopqrstuvwxyz234567"[parseInt(bits.slice(i, i + 5), 2)];
    const cid = "bafkrei" + b32.slice(0, 52);
    fakeStore.set(cid, { type: blob.type, bytes });
    return cid;
  },
};
const pinner = process.env.FAKE_PIN ? fakePinner : pinata();

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/api/pin") {
      const body = await new Promise<Buffer>((ok) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });
      const r = await pinResponse(new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === "POST" ? body : undefined }), pinner);
      res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
      return;
    }
    if (url.pathname.startsWith("/api/key/")) {
      const r = await keyResponse(new Request(url), process.env);
      res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (url.pathname.startsWith("/api/art/")) {
      // Same route as Vercel; with fake pins it reads the in-memory store instead of a gateway.
      const fetchCid = process.env.FAKE_PIN
        ? async (cid: string) => {
          const f = fakeStore.get(cid);
          return f ? new Response(new Uint8Array(f.bytes), { headers: { "content-type": f.type } }) : new Response("", { status: 404 });
        }
        : undefined;
      const r = await artResponse(new Request(url), process.env, fetchCid);
      res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    const fake = url.pathname.match(/^\/ipfs\/([a-z0-9]+)$/); // old-style links from earlier test pins
    if (fake && fakeStore.has(fake[1])) {
      const f = fakeStore.get(fake[1])!;
      res.writeHead(200, { "content-type": f.type, "access-control-allow-origin": "*" }).end(f.bytes);
      return;
    }
    const file = path.join(ROOT, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(fs.readFileSync(file));
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(PORT, () => console.log(`LP Lock NFT on http://localhost:${PORT} (${process.env.FAKE_PIN ? "fake pins" : pinner ? "Pinata" : "no art uploads"})`));
