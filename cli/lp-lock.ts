/**
 * lp_lock_nft command line. Mainnet by default. Every command that sends a transaction
 * only simulates it unless --yes is given.
 *
 *   npm run lp-lock -- status [--wallet <address>]
 *   npm run lp-lock -- info --nft <mint>
 *   npm run lp-lock -- lock --pool <pool> --amount <LP base units|all> --days <n> \
 *       --name "TOKEN/XNT LP Lock" --symbol LPLOCK (--uri <metadata uri> | --image art.png) [--yes]
 *       (--image pins to IPFS through Pinata: set PINATA_JWT; --site <url> is the site that serves the art
 *       links and the lock page, default https://lp-lock-nft.vercel.app)
 *   npm run lp-lock -- claim --nft <mint> [--slippage-bps 100] [--yes]
 *   npm run lp-lock -- unlock --nft <mint> [--yes]
 *
 * Common: --network mainnet|testnet, --rpc <url>, --keypair <path> (default
 * ~/.config/solana/id.json), --program <id> (your deployed lp_lock_nft).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { prepareTx, sendAndConfirmRaw } from "../client/tx.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { handlePin, pinata } from "../server/pin.js";
import { Network, XDEX_PROGRAM, readPool } from "../client/xdex.js";
import {
  buildClaimRewards, buildLockLp, buildUnlock, getLock, locksHeldBy, nftHolder, quoteRewards, type Lock,
} from "../client/lp-lock-nft.js";

const DEFAULT_PROGRAM = "8N4E3ZHBiYRMia8Hs27J6f3b9QM8wiTYcMXukSq96Ejf";
const RPC: Record<Network, string> = { mainnet: "https://rpc.mainnet.x1.xyz", testnet: "https://rpc.testnet.x1.xyz" };

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    network: { type: "string", default: "mainnet" }, rpc: { type: "string" }, keypair: { type: "string" },
    program: { type: "string", default: DEFAULT_PROGRAM }, yes: { type: "boolean", default: false },
    wallet: { type: "string" }, nft: { type: "string" }, pool: { type: "string" }, amount: { type: "string" },
    days: { type: "string" }, seconds: { type: "string" }, name: { type: "string" }, symbol: { type: "string", default: "LPLOCK" },
    uri: { type: "string" }, image: { type: "string" }, site: { type: "string" },
    "slippage-bps": { type: "string", default: "100" },
  },
});
const network = o.network as Network;
if (!(network in XDEX_PROGRAM)) throw new Error("--network must be mainnet or testnet");
const conn = new Connection(o.rpc ?? RPC[network], "confirmed");
const programId = new PublicKey(o.program!);
const xdex = XDEX_PROGRAM[network];
const expand = (p: string) => p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
const loadKeypair = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(expand(p), "utf8"))));
const wallet = () => loadKeypair(o.keypair ?? "~/.config/solana/id.json");
const need = (v: string | undefined, flag: string) => { if (!v) throw new Error(`${flag} is required`); return v; };
/** In the local time zone of whoever runs the CLI, with its abbreviation. */
const when = (t: number) => new Date(t * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "long" });
const units = (v: bigint, decimals: number) => {
  const s = v.toString().padStart(decimals + 1, "0");
  return decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "") : s;
};

async function run(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  const [payer, ...extra] = signers;
  const { tx, lastValidBlockHeight, unitsConsumed } = await prepareTx(conn, payer.publicKey, ixs, extra);
  if (!o.yes) {
    console.log(`${label}: simulation OK (${unitsConsumed} CU). Re-run with --yes to send it on ${network}.`);
    return null;
  }
  tx.partialSign(payer);
  const sig = await sendAndConfirmRaw(conn, tx.serialize(), lastValidBlockHeight);
  console.log(`${label}: confirmed ${sig}`);
  return sig;
}

async function describe(lock: Lock) {
  const q = await quoteRewards(conn, programId, xdex, lock);
  const { pool } = q.state;
  const holder = await nftHolder(conn, lock.nftMint);
  const name = (i: number) => pool.mints[i].equals(NATIVE_MINT) ? "XNT" : pool.mints[i].toBase58().slice(0, 6) + "…";
  const now = Date.now() / 1000;
  console.log(`NFT ${lock.nftMint.toBase58()}`);
  console.log(`  pool       ${lock.pool.toBase58()}`);
  console.log(`  holder     ${holder?.owner.toBase58() ?? "?"}   (locked by ${lock.locker.toBase58()})`);
  console.log(`  LP locked  ${units(q.lpInVault, pool.lpDecimals)}  ≈ ${[0, 1].map((i) => `${units(q.lockedValue[i], pool.mintDecimals[i])} ${name(i)}`).join(" + ")}`);
  console.log(`  unlocks    ${when(lock.unlockAt)}${lock.unlockAt <= now ? "  (ended: unlock is available)" : ""}`);
  console.log(`  rewards    ${[0, 1].map((i) => `${units(q.out[i], pool.mintDecimals[i])} ${name(i)}`).join(" + ")} claimable now`);
}

const cmd = positionals[0];
if (cmd === "status") {
  const who = o.wallet ? new PublicKey(o.wallet) : wallet().publicKey;
  const locks = await locksHeldBy(conn, programId, who);
  console.log(`${locks.length} open lock(s) held by ${who.toBase58()} on ${network}\n`);
  for (const l of locks) { await describe(l); console.log(); }
} else if (cmd === "info") {
  const lock = await getLock(conn, programId, new PublicKey(need(o.nft, "--nft")));
  if (!lock) throw new Error("No open lock for that NFT (never locked, or already unlocked).");
  await describe(lock);
} else if (cmd === "lock") {
  const owner = wallet();
  const pool = new PublicKey(need(o.pool, "--pool"));
  const seconds = o.seconds ? Number(o.seconds) : Math.round(Number(need(o.days, "--days or --seconds")) * 86_400);
  const amountArg = need(o.amount, "--amount");
  const amount = amountArg === "all" ? "all" as const : BigInt(amountArg);
  const name = need(o.name, "--name");
  const nft = Keypair.generate();
  let uri = o.uri;
  if (!uri && o.image) {
    // Same pinning as the web app: art + metadata JSON to IPFS through Pinata.
    const pinner = pinata();
    if (!pinner) throw new Error("Set PINATA_JWT (a Pinata key with Files: Write) to upload --image, or pass --uri.");
    if (!o.yes) throw new Error("Pinning uploads to IPFS; pass --uri to simulate, or --yes to pin and lock.");
    const { pool: p } = await readPool(conn, xdex, pool);
    const ata = getAssociatedTokenAddressSync(p.lpMint, owner.publicKey, false, TOKEN_PROGRAM_ID);
    const lpAmount = amount === "all" ? (await getAccount(conn, ata, "confirmed")).amount : amount;
    const pinned = await handlePin({
      network, owner: owner.publicKey.toBase58(), pool: pool.toBase58(), nftMint: nft.publicKey.toBase58(),
      lpAmount: lpAmount.toString(), durationSeconds: seconds, name, symbol: o.symbol!,
      image: fs.readFileSync(expand(o.image)).toString("base64"), siteUrl: o.site,
    }, pinner, o.site ?? process.env.PUBLIC_URL ?? "https://lp-lock-nft.vercel.app", { ...process.env, [`RPC_${network.toUpperCase()}`]: o.rpc ?? RPC[network] });
    console.log(`Art pinned: ${pinned.image}\nMetadata:   ${pinned.uri}`);
    uri = pinned.uri;
  }
  if (!uri) throw new Error("--uri <metadata json> or --image <file> is required (the NFT's art).");
  const b = await buildLockLp(conn, programId, xdex, owner.publicKey, { pool, amount, durationSeconds: seconds, name, symbol: o.symbol!, uri, nftMint: nft });
  console.log(`Locking ${units(b.summary.lp, b.summary.lpDecimals)} of ${units(b.summary.held, b.summary.lpDecimals)} LP until ${when(Math.floor(Date.now() / 1000) + seconds)}.`);
  console.log("The LP cannot be withdrawn by anyone before then. Rewards (trading fees) stay claimable by the NFT holder.");
  if (await run("lock", b.ixs, [owner, ...b.signers])) console.log(`NFT mint: ${b.summary.nftMint.toBase58()}`);
} else if (cmd === "claim") {
  const holder = wallet();
  const b = await buildClaimRewards(conn, programId, xdex, holder.publicKey, new PublicKey(need(o.nft, "--nft")), { slippageBps: Number(o["slippage-bps"]) });
  const { pool } = b.quote.state;
  console.log(`Rewards: ${[0, 1].map((i) => `${units(b.quote.out[i], pool.mintDecimals[i])} of ${pool.mints[i].equals(NATIVE_MINT) ? "XNT" : pool.mints[i].toBase58()}`).join(" + ")}`);
  if (!b.ixs) console.log("Nothing to claim yet (or only dust).");
  else await run("claim", b.ixs, [holder]);
} else if (cmd === "unlock") {
  const holder = wallet();
  const b = await buildUnlock(conn, programId, holder.publicKey, new PublicKey(need(o.nft, "--nft")));
  console.log(`Unlocking ${b.summary.lp} LP base units to ${b.summary.holderLp.toBase58()}; the NFT is burned.`);
  await run("unlock", b.ixs, [holder]);
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?|^ \* ?/gm, ""));
  process.exit(cmd ? 1 : 0);
}
