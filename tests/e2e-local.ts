/**
 * End-to-end test against a LOCAL validator that clones X1 mainnet's XDEX program, its fee
 * config and Metaplex Token Metadata, and runs the mainnet build of lp_lock_nft (nothing is
 * sent to mainnet). From the repo root, with the Agave 3.1.x tools:
 *
 *   npm run build
 *   solana-test-validator --reset --ledger test-ledger --rpc-port 8899 \
 *     --url https://rpc.mainnet.x1.xyz \
 *     --clone-upgradeable-program sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN \
 *     --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
 *     --clone 2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c \
 *     --maybe-clone SKc6b6zAv2kkB9EtitjppbzPVR48bCMfRtE5B8KDuF1 \
 *     --bpf-program 8N4E3ZHBiYRMia8Hs27J6f3b9QM8wiTYcMXukSq96Ejf target/deploy/lp_lock_nft.so
 *   npm run test:e2e
 *
 * NETWORK=testnet (with the testnet XDEX/config clones and the testnet build) tests testnet.
 */
import assert from "node:assert/strict";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMint, createSyncNativeInstruction,
  createTransferInstruction, getAccount, getAssociatedTokenAddressSync, getMint, mintTo,
} from "@solana/spl-token";
import { Network, XDEX_PROGRAM, buildCreatePool, readPool, swapIx } from "../client/xdex.js";
import {
  buildClaimRewards, buildLockLp, buildUnlock, getLock, locksHeldBy, lpVaultPda, masterEditionPda, metadataPda, quoteRewards, vaultLp,
} from "../client/lp-lock-nft.js";

const conn = new Connection(process.env.LOCAL_RPC ?? "http://127.0.0.1:8899", "confirmed");
const network = (process.env.NETWORK ?? "mainnet") as Network;
const PROGRAM = new PublicKey(process.env.PROGRAM_ID ?? "8N4E3ZHBiYRMia8Hs27J6f3b9QM8wiTYcMXukSq96Ejf");
const XDEX = XDEX_PROGRAM[network];
const LOCK_SECONDS = 20;
const ok = (s: string) => console.log(`  ✓ ${s}`);

// Airdrops of 100 XNT only work on a local validator; refuse anything else outright.
assert.equal((await conn.getClusterNodes()).length, 1, "refusing to run: this RPC is not a single-node local validator");

async function fund(k: Keypair, sol = 100) {
  await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
}
const send = (ixs: TransactionInstruction[], signers: Keypair[]) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
async function fails(label: string, p: Promise<unknown>, match: RegExp) {
  try { await p; } catch (e) {
    const logs = ((e as { logs?: string[] }).logs ?? []).join("\n") + String(e);
    assert.match(logs, match, `${label}: failed, but not for the expected reason:\n${logs.slice(-800)}`);
    ok(`rejected: ${label}`);
    return;
  }
  throw new Error(`${label}: should have failed`);
}
const tokenBal = async (a: PublicKey) => (await getAccount(conn, a, "confirmed")).amount;
const lpBal = async (owner: PublicKey, lpMint: PublicKey) => {
  try { return await tokenBal(getAssociatedTokenAddressSync(lpMint, owner)); } catch { return 0n; }
};

const alice = Keypair.generate(), bob = Keypair.generate(), trader = Keypair.generate();
await Promise.all([alice, bob, trader].map((k) => fund(k)));

// ---------- A fresh TOKEN/XNT pool on the cloned XDEX ----------
const mint = await createMint(conn, alice, alice.publicKey, null, 9);
const aliceTok = getAssociatedTokenAddressSync(mint, alice.publicKey);
const aliceWxnt = getAssociatedTokenAddressSync(NATIVE_MINT, alice.publicKey);
await send([
  createAssociatedTokenAccountIdempotentInstruction(alice.publicKey, aliceTok, alice.publicKey, mint),
  createAssociatedTokenAccountIdempotentInstruction(alice.publicKey, aliceWxnt, alice.publicKey, NATIVE_MINT),
  SystemProgram.transfer({ fromPubkey: alice.publicKey, toPubkey: aliceWxnt, lamports: 20 * LAMPORTS_PER_SOL }),
  createSyncNativeInstruction(aliceWxnt),
], [alice]);
await mintTo(conn, alice, mint, aliceTok, alice, 2_000_000n * 10n ** 9n);
const created = buildCreatePool(network, alice.publicKey,
  { mint, program: TOKEN_PROGRAM_ID, amount: 1_000_000n * 10n ** 9n },
  { mint: NATIVE_MINT, program: TOKEN_PROGRAM_ID, amount: 20n * BigInt(LAMPORTS_PER_SOL) });
await send([created.ix], [alice]);
const poolAddr = created.pool;
const lpMint = created.lpMint;
const aliceLp = await lpBal(alice.publicKey, lpMint);
assert.ok(aliceLp > 0n);
ok(`pool ${poolAddr.toBase58().slice(0, 8)}… created; Alice holds ${aliceLp} LP`);

// Trader: tokens and wrapped XNT to swap with, to make the pool earn fees.
const traderTok = getAssociatedTokenAddressSync(mint, trader.publicKey);
const traderWxnt = getAssociatedTokenAddressSync(NATIVE_MINT, trader.publicKey);
await send([
  createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, traderTok, trader.publicKey, mint),
  createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, traderWxnt, trader.publicKey, NATIVE_MINT),
  SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: traderWxnt, lamports: 50 * LAMPORTS_PER_SOL }),
  createSyncNativeInstruction(traderWxnt),
], [trader]);
const chainTime = async () => Number((await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed"))!.data.readBigInt64LE(32));
const waitUntil = async (t: number) => { while ((await chainTime()) < t) await new Promise((r) => setTimeout(r, 500)); };
async function churn(rounds: number) {
  await waitUntil((await readPool(conn, XDEX, poolAddr)).pool.openTime + 1); // XDEX opens a new pool a little after creation
  for (let i = 0; i < rounds; i++) {
    const { pool } = await readPool(conn, XDEX, poolAddr);
    const xntSide = pool.mints[0].equals(NATIVE_MINT) ? 0 : 1;
    await send([swapIx(XDEX, trader.publicKey, pool, xntSide as 0 | 1, traderWxnt, traderTok, 5n * BigInt(LAMPORTS_PER_SOL), 1n)], [trader]);
    const got = await tokenBal(traderTok);
    await send([swapIx(XDEX, trader.publicKey, pool, (1 - xntSide) as 0 | 1, traderTok, traderWxnt, got, 1n)], [trader]);
  }
}

// ---------- Lock ----------
const nftArgs = { name: "TEST/XNT LP Lock", symbol: "LPLOCK", uri: "https://example.com/lock.json" };
const lockTx = (amount: bigint | "all", durationSeconds: number, extra: Partial<typeof nftArgs> = {}) =>
  buildLockLp(conn, PROGRAM, XDEX, alice.publicKey, { pool: poolAddr, amount, durationSeconds, ...nftArgs, ...extra });

await fails("lock 0 seconds", lockTx(1n, 0), /duration/i);
await fails("lock more LP than held", lockTx(aliceLp + 1n, 60), /cannot lock/);
// Program-side checks, bypassing the client's validation.
{
  const b = await lockTx(1000n, 60);
  const data = Buffer.from(b.ixs[1].data);
  data.writeBigInt64LE(315_360_001n, 16);
  b.ixs[1].data = data;
  await fails("program: lock longer than 10 years", send(b.ixs, [alice, ...b.signers]), /DurationTooLong|10-year/);
  const c = await lockTx(1000n, 60);
  c.ixs[1].keys[2] = { ...c.ixs[1].keys[2], pubkey: c.ixs[1].keys[3].pubkey }; // token_0_vault := token_1_vault
  await fails("program: pool vault swapped", send(c.ixs, [alice, ...c.signers]), /WrongPoolAccount|does not belong/);
}

const lockAmount = aliceLp / 2n;
const lb = await lockTx(lockAmount, LOCK_SECONDS);
await send(lb.ixs, [alice, ...lb.signers]);
const nft = lb.summary.nftMint;
const lock = (await getLock(conn, PROGRAM, nft))!;
assert.equal(lock.lockedLp, lockAmount);
assert.equal(await vaultLp(conn, PROGRAM, lock.address), lockAmount);
assert.equal(await lpBal(alice.publicKey, lpMint), aliceLp - lockAmount);
assert.equal(lock.unlockAt - lock.lockedAt, LOCK_SECONDS);
const nftMintState = await getMint(conn, nft, "confirmed");
assert.equal(nftMintState.supply, 1n);
assert.equal(nftMintState.decimals, 0);
assert.ok(nftMintState.mintAuthority && !nftMintState.mintAuthority.equals(PROGRAM), "mint authority moved to the master edition");
assert.ok(await conn.getAccountInfo(metadataPda(nft)), "Metaplex metadata exists");
assert.ok(await conn.getAccountInfo(masterEditionPda(nft)), "master edition exists");
const md = (await conn.getAccountInfo(metadataPda(nft)))!.data;
assert.ok(md.includes(Buffer.from(nftArgs.name)) && md.includes(Buffer.from(nftArgs.uri)), "metadata has the name and uri");
assert.equal((await locksHeldBy(conn, PROGRAM, alice.publicKey)).length, 1);
ok(`locked ${lockAmount} LP for ${LOCK_SECONDS}s; NFT ${nft.toBase58().slice(0, 8)}… (Metaplex 1/1) in Alice's wallet`);

// ---------- No early exit ----------
const early = await buildUnlock(conn, PROGRAM, alice.publicKey, nft, { force: true });
await fails("unlock before the lock ends", send(early.ixs, [alice]), /StillLocked|not reached its unlock time/);
await fails("client: unlock before the lock ends", buildUnlock(conn, PROGRAM, alice.publicKey, nft), /Still locked/);

// ---------- Rewards ----------
const none = await buildClaimRewards(conn, PROGRAM, XDEX, alice.publicKey, nft);
assert.equal(none.ixs, null, "nothing to claim before any trading");
const forced = await buildClaimRewards(conn, PROGRAM, XDEX, alice.publicKey, nft, { force: true });
await fails("program: claim with no fees", send(forced.ixs!, [alice]), /NoRewardsYet|No trading fees/);

await churn(4);
const q1 = await quoteRewards(conn, PROGRAM, XDEX, lock);
assert.ok(q1.feeLp > 0n, "fees accrued");
const aTok0 = await tokenBal(aliceTok), aXnt0 = BigInt(await conn.getBalance(alice.publicKey, "confirmed"));
const c1 = await buildClaimRewards(conn, PROGRAM, XDEX, alice.publicKey, nft);
await send(c1.ixs!, [alice]);
const tokGot = (await tokenBal(aliceTok)) - aTok0;
const xntGot = BigInt(await conn.getBalance(alice.publicKey, "confirmed")) - aXnt0;
const xntSide = q1.state.pool.mints[0].equals(NATIVE_MINT) ? 0 : 1;
assert.equal(tokGot, q1.out[1 - xntSide], "token reward matches the quote");
assert.ok(xntGot > q1.out[xntSide] - 50_000n, `XNT reward (minus tx fee) ${xntGot} vs quote ${q1.out[xntSide]}`);
assert.equal(await vaultLp(conn, PROGRAM, lock.address), lockAmount - q1.feeLp);
ok(`Alice claimed ${tokGot} token + ~${q1.out[xntSide]} lamports XNT (unwrapped); ${q1.feeLp} fee-LP left the vault, principal intact`);
{
  const left = await quoteRewards(conn, PROGRAM, XDEX, lock);
  // XDEX rounds withdrawals down, so a claim leaves a speck of extra value behind.
  assert.ok(left.feeLp * 10_000n < q1.feeLp, "only rounding dust left right after claiming");
  if (left.out[0] === 0n || left.out[1] === 0n) assert.equal((await buildClaimRewards(conn, PROGRAM, XDEX, alice.publicKey, nft)).ixs, null, "client skips dust");
}

// ---------- Rights follow the NFT ----------
const bobNft = getAssociatedTokenAddressSync(nft, bob.publicKey);
await send([
  createAssociatedTokenAccountIdempotentInstruction(alice.publicKey, bobNft, bob.publicKey, nft),
  createTransferInstruction(getAssociatedTokenAddressSync(nft, alice.publicKey), bobNft, alice.publicKey, 1),
], [alice]);
ok("Alice transferred the lock NFT to Bob");
await churn(3);
await fails("client: Alice claims without the NFT", buildClaimRewards(conn, PROGRAM, XDEX, alice.publicKey, nft), /held by/);
const stolen = await buildClaimRewards(conn, PROGRAM, XDEX, alice.publicKey, nft, { force: true });
await fails("program: Alice claims without the NFT", send(stolen.ixs!, [alice]), /NotNftHolder|does not hold/);
const c2 = await buildClaimRewards(conn, PROGRAM, XDEX, bob.publicKey, nft);
assert.ok(c2.ixs);
const bobTok = getAssociatedTokenAddressSync(mint, bob.publicKey);
await send(c2.ixs, [bob]);
assert.equal(await tokenBal(bobTok), c2.quote.out[1 - xntSide]);
ok(`Bob (new NFT holder) claimed ${c2.quote.out[1 - xntSide]} token + XNT`);

// ---------- Unlock ----------
await waitUntil(lock.unlockAt + 1);
const aliceUnlock = await buildUnlock(conn, PROGRAM, alice.publicKey, nft, { force: true });
await fails("program: Alice unlocks without the NFT", send(aliceUnlock.ixs, [alice]), /NotNftHolder|does not hold|AccountNotInitialized|3012/);
const inVault = await vaultLp(conn, PROGRAM, lock.address);
const u = await buildUnlock(conn, PROGRAM, bob.publicKey, nft);
await send(u.ixs, [bob]);
assert.equal(await lpBal(bob.publicKey, lpMint), inVault, "Bob received every LP token in the vault");
assert.equal(await getLock(conn, PROGRAM, nft), null, "lock account closed");
assert.equal(await conn.getAccountInfo(lpVaultPda(PROGRAM, lock.address)), null, "LP vault closed");
assert.equal((await getMint(conn, nft, "confirmed")).supply, 0n, "NFT burned");
{
  const [mdLeft, edLeft] = await conn.getMultipleAccountsInfo([metadataPda(nft), masterEditionPda(nft)], "confirmed");
  assert.equal(edLeft, null, "master edition closed");
  // Metaplex keeps its 0.01 XNT protocol fee in a 1-byte, uninitialized metadata stub.
  assert.ok(mdLeft === null || (mdLeft.data.length === 1 && mdLeft.data[0] === 0), "metadata burned");
}
assert.equal(await conn.getAccountInfo(bobNft), null, "Bob's NFT account closed");
ok(`Bob unlocked ${inVault} LP; NFT burned, lock/vault/edition closed, rent refunded`);
await fails("client: claim after unlock", buildClaimRewards(conn, PROGRAM, XDEX, bob.publicKey, nft), /No open lock/);

console.log(`\nAll lp_lock_nft checks passed (${network} clone).`);
