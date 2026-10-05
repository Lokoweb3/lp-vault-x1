/**
 * Browser test of the web app: Chromium (Playwright) clicks through connect -> lock ->
 * claim -> unlock against a LOCAL validator cloned from X1 mainnet (start it as in
 * tests/e2e-local.ts), with a test wallet injected through the Wallet Standard that signs
 * with a local keypair. The dev server runs with fake pins (no Pinata key needed).
 *
 *   npx playwright install chromium   # once
 *   npm run web:build -- --dev && npx tsx tests/web-e2e.ts
 *
 * SHOTS=<dir> saves screenshots.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMint, createSyncNativeInstruction,
  getAccount, getAssociatedTokenAddressSync, mintTo,
} from "@solana/spl-token";
import { chromium, type Page } from "playwright";
import { XDEX_PROGRAM, buildCreatePool, readPool, swapIx } from "../client/xdex.js";
import { getLock, locksHeldBy } from "../client/lp-lock-nft.js";
import { nftMetadata } from "../client/tokens.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8899";
const PORT = 8821;
const SITE = `http://localhost:${PORT}/?rpc=${encodeURIComponent(RPC)}`;
const conn = new Connection(RPC, "confirmed");
const PROGRAM = new PublicKey("8N4E3ZHBiYRMia8Hs27J6f3b9QM8wiTYcMXukSq96Ejf");
const XDEX = XDEX_PROGRAM.mainnet;
const ok = (s: string) => console.log(`  ✓ ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
assert.equal((await conn.getClusterNodes()).length, 1, "refusing to run: this RPC is not a single-node local validator");

const send = (ixs: TransactionInstruction[], signers: Keypair[]) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
const fund = async (k: Keypair) => conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
const chainTime = async () => Number((await conn.getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111")))!.data.readBigInt64LE(32));

// ---------- chain fixtures: a TOKEN/XNT pool whose LP Alice holds ----------
const alice = Keypair.generate(), trader = Keypair.generate(), stranger = Keypair.generate();
await Promise.all([alice, trader, stranger].map(fund));
const mint = await createMint(conn, alice, alice.publicKey, null, 9);
const wrap = (k: Keypair, lamports: number) => {
  const w = getAssociatedTokenAddressSync(NATIVE_MINT, k.publicKey);
  return [createAssociatedTokenAccountIdempotentInstruction(k.publicKey, w, k.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: w, lamports }), createSyncNativeInstruction(w)];
};
const aliceTok = getAssociatedTokenAddressSync(mint, alice.publicKey);
await send([createAssociatedTokenAccountIdempotentInstruction(alice.publicKey, aliceTok, alice.publicKey, mint), ...wrap(alice, 20 * LAMPORTS_PER_SOL)], [alice]);
await mintTo(conn, alice, mint, aliceTok, alice, 2_000_000n * 10n ** 9n);
const created = buildCreatePool("mainnet", alice.publicKey,
  { mint, program: TOKEN_PROGRAM_ID, amount: 1_000_000n * 10n ** 9n }, { mint: NATIVE_MINT, program: TOKEN_PROGRAM_ID, amount: 20n * BigInt(LAMPORTS_PER_SOL) });
await send([created.ix], [alice]);
const traderTok = getAssociatedTokenAddressSync(mint, trader.publicKey), traderWxnt = getAssociatedTokenAddressSync(NATIVE_MINT, trader.publicKey);
await send([createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, traderTok, trader.publicKey, mint), ...wrap(trader, 50 * LAMPORTS_PER_SOL)], [trader]);
async function churn(rounds: number) {
  const { pool } = await readPool(conn, XDEX, created.pool);
  while ((await chainTime()) <= pool.openTime) await sleep(500);
  const x = pool.mints[0].equals(NATIVE_MINT) ? 0 : 1;
  for (let i = 0; i < rounds; i++) {
    await send([swapIx(XDEX, trader.publicKey, pool, x as 0 | 1, traderWxnt, traderTok, 5n * BigInt(LAMPORTS_PER_SOL), 1n)], [trader]);
    await send([swapIx(XDEX, trader.publicKey, pool, (1 - x) as 0 | 1, traderTok, traderWxnt, (await getAccount(conn, traderTok)).amount, 1n)], [trader]);
  }
}
ok(`pool ${created.pool.toBase58().slice(0, 8)}… with Alice's LP`);

// ---------- dev server with fake pins ----------
// Own process group, so stopping it also stops tsx's child node process.
const server = spawn("node_modules/.bin/tsx", ["web/dev-server.ts"], {
  env: { ...process.env, PORT: String(PORT), FAKE_PIN: "1", RPC_MAINNET: RPC }, stdio: ["ignore", "pipe", "inherit"], detached: true,
});
const stopServer = () => { try { process.kill(-server.pid!, "SIGTERM"); } catch { /* already gone */ } };
await new Promise<void>((ok, fail) => { server.stdout!.on("data", (d) => String(d).includes("http://") && ok()); server.on("exit", fail); });
process.on("exit", stopServer);

// The pin service only pins for wallets holding the LP they're about to lock.
{
  const r = await fetch(`http://localhost:${PORT}/api/pin`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ network: "mainnet", owner: stranger.publicKey.toBase58(), pool: created.pool.toBase58(), nftMint: Keypair.generate().publicKey.toBase58(),
      lpAmount: "1000", durationSeconds: 60, name: "x", symbol: "X", image: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString("base64") }),
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /doesn't hold/);
  ok("pin service refuses a wallet that doesn't hold the LP");
  const r2 = await fetch(`http://localhost:${PORT}/api/pin`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ network: "mainnet", owner: alice.publicKey.toBase58(), pool: mint.toBase58(), nftMint: mint.toBase58(), lpAmount: "1", durationSeconds: 60, name: "x", symbol: "X", image: "AAAA" }) });
  assert.equal(r2.status, 400);
  ok("pin service refuses a non-image / non-pool request");
}

// ---------- browser with a Wallet Standard test wallet ----------
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("dialog", (d) => d.accept());
await page.exposeFunction("__testSign", (b64: string) => {
  const tx = Transaction.from(Buffer.from(b64, "base64"));
  tx.partialSign(alice);
  return tx.serialize().toString("base64");
});
// A plain string: tsx would otherwise add helpers to a function body that don't exist in the page.
await page.addInitScript(`(() => {
  const account = { address: ${JSON.stringify(alice.publicKey.toBase58())}, publicKey: new Uint8Array(32), chains: ["solana:mainnet"], features: ["solana:signTransaction"] };
  const testWallet = {
    version: "1.0.0", name: "Test Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", chains: ["solana:mainnet"], accounts: [account],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "solana:signTransaction": {
        version: "1.0.0", supportedTransactionVersions: ["legacy"],
        signTransaction: async (...inputs) => Promise.all(inputs.map(async (i) => {
          let s = "";
          for (const c of i.transaction) s += String.fromCharCode(c);
          const signed = await window.__testSign(btoa(s));
          return { signedTransaction: Uint8Array.from(atob(signed), (c) => c.charCodeAt(0)) };
        })),
      },
    },
  };
  window.addEventListener("wallet-standard:app-ready", (e) => e.detail.register(testWallet));
})();`);

/** Wait for a success status; on timeout, fail with what the page actually says. */
async function waitOk(p: Page, okSel: string, statusSel: string, timeout = 60_000) {
  try { await p.waitForSelector(okSel, { timeout }); } catch {
    throw new Error(`timed out waiting for ${okSel}; page says: ${await p.locator(statusSel).first().textContent()}`);
  }
}
const shot = async (p: Page, name: string) => { if (process.env.SHOTS) await p.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }); };
await page.goto(SITE);
await page.click("#connect");
await page.click("#walletMenu >> text=Test Wallet");
await page.waitForSelector("#lockForm:not([hidden])", { timeout: 30_000 });
const option = await page.textContent("#position option");
assert.match(option!, /LP/);
ok(`wallet connected; the page found Alice's LP: "${option}"`);

// Lock half for ~25 seconds.
await page.click("#pctChips >> text=50%");
// Value locked: half of Alice's LP in a 20 XNT / 1M TOKEN pool is worth about 20 XNT in total.
await page.waitForSelector("#amountValue:not([hidden])");
const total = Number((await page.textContent("#valueTotal"))!.replace(/[^\d.]/g, ""));
assert.ok(total > 19.9 && total <= 20, `value locked shows ${total} XNT`);
assert.match((await page.textContent("#valueParts"))!, /XNT \+ /);
ok(`value card: ≈ ${total} XNT (${await page.textContent("#valueParts")})`);
await page.fill("#days", "0.0003"); // 26 s
await page.dispatchEvent("#days", "input");
assert.equal(await page.isDisabled("#lockBtn"), true, "Lock stays disabled until the warning is ticked");
// The preview is the server-rendered live card, 500x500.
await page.waitForFunction(() => { const i = document.getElementById("artPreview") as HTMLImageElement; return i.complete && i.naturalWidth === 500; }, null, { timeout: 30_000 });
ok("form shows the live 500x500 card preview from /api/key/preview.png");
await page.check("#understand");
await shot(page, "1-lock-form");
await page.click("#lockBtn");
await waitOk(page, "#lockStatus.ok", "#lockStatus");
assert.match((await page.textContent("#lockStatus"))!, /Vault sealed/);
const [lock] = await locksHeldBy(conn, PROGRAM, alice.publicKey);
assert.ok(lock, "lock exists on chain");
const md = await nftMetadata(conn, lock.nftMint);
// The NFT points at the live card: /api/key/<nft>.json, whose image is a live 500x500 PNG.
assert.equal(md?.uri, `http://localhost:${PORT}/api/key/${lock.nftMint.toBase58()}.json`, `metadata uri: ${md?.uri}`);
const json = await (await fetch(md!.uri)).json();
assert.ok(json.attributes.some((a: { trait_type: string }) => a.trait_type === "Pair"), "live metadata JSON");
assert.match(json.external_url, new RegExp(`nft=${lock.nftMint.toBase58()}`));
assert.match(json.image, new RegExp(`/api/key/${lock.nftMint.toBase58()}\\.png\\?v=\\d+$`));
const imgRes = await fetch(json.image);
assert.equal(imgRes.status, 200);
assert.equal(imgRes.headers.get("content-type"), "image/png");
const pngBytes = Buffer.from(await imgRes.arrayBuffer());
assert.equal(pngBytes.readUInt32BE(16), 500, "500 px wide");
assert.equal(pngBytes.readUInt32BE(20), 500, "500 px high");
ok(`locked through the page; NFT ${lock.nftMint.toBase58().slice(0, 8)}… with the live card ("${json.name}", ${json.attributes.find((a: { trait_type: string }) => a.trait_type === "LP locked").value} LP)`);

// A custom image still goes through the pin service (Alice still holds the other half of her LP).
{
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  const r = await fetch(`http://localhost:${PORT}/api/pin`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ network: "mainnet", owner: alice.publicKey.toBase58(), pool: created.pool.toBase58(), nftMint: Keypair.generate().publicKey.toBase58(),
      lpAmount: "1000", durationSeconds: 86_400, name: "Custom", symbol: "C", image: tinyPng }) });
  assert.equal(r.status, 200, await r.clone().text());
  const pinned = await r.json();
  assert.match(pinned.uri, /\/api\/art\/bafkrei[a-z2-7]+\.json$/);
  assert.equal((await fetch(pinned.image)).headers.get("content-type"), "image/png");
  ok("custom upload: pinned image + metadata served from /api/art");
}

// Your locks: card shows, nothing to claim yet, unlock not yet available.
await page.waitForSelector(".lock h3");
assert.equal(await page.isDisabled(".lock >> text=Claim rewards"), true);
assert.equal(await page.isDisabled(".lock >> text=Withdraw LP"), true);
ok("card shows the lock; Claim and Unlock are disabled");

// Fees accrue, Claim works.
await churn(3);
await page.click("#refresh");
await page.waitForSelector(".lock >> text=Claim rewards >> :scope:not([disabled])", { timeout: 30_000 });
await shot(page, "2-rewards-ready");
const tokBefore = (await getAccount(conn, aliceTok)).amount;
await page.click(".lock >> text=Claim rewards");
await waitOk(page, ".lock .status.ok", ".lock .status");
assert.ok((await getAccount(conn, aliceTok)).amount > tokBefore, "token rewards arrived");
ok("claimed rewards through the page");

// Public view by link.
const viewer = await browser.newPage();
await viewer.goto(`${SITE}&nft=${lock.nftMint.toBase58()}`);
await viewer.waitForSelector("#viewBody .lock h3");
assert.equal(await viewer.locator("#viewBody >> text=Claim rewards").count(), 0, "no actions for a visitor without the NFT");
ok("anyone can view the lock by link (no buttons without the NFT)");

// Unlock after the end.
while ((await chainTime()) <= lock.unlockAt) await sleep(1000);
await sleep(1500);
await page.reload();
await page.waitForSelector(".lock >> text=Withdraw LP >> :scope:not([disabled])", { timeout: 30_000 });
await page.click(".lock >> text=Withdraw LP");
await waitOk(page, ".lock .status.ok", ".lock .status");
assert.equal(await getLock(conn, PROGRAM, lock.nftMint), null, "lock closed");
await page.waitForSelector("#mine >> text=holds no vault keys", { timeout: 30_000 });
await shot(page, "3-after-unlock");
assert.equal((await fetch(`http://localhost:${PORT}/api/key/${lock.nftMint.toBase58()}.json`)).status, 404, "withdrawn vault: no live card");
ok("unlocked through the page; LP back, NFT burned, list empty, live card gone");

await browser.close();
stopServer();
console.log("\nAll web app checks passed (mainnet clone).");
process.exit(0);
