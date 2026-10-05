/**
 * Client for the lp_lock_nft program (programs/lp_lock_nft): PDAs, account decoding, the
 * same reward math the program uses, and instruction builders for `lock_lp`,
 * `claim_rewards` and `unlock`. Builders return instructions (plus any extra signer);
 * nothing here signs or sends, so the same code serves the CLI and a browser wallet.
 */
import { sha256 } from "@noble/hashes/sha2";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, calculateEpochFee,
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createInitializeAccount3Instruction,
  getAssociatedTokenAddressSync, getTransferFeeConfig, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { Pool, PoolState, poolAuthority, readPool } from "./xdex.js";

export const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const MAX_LOCK_DURATION = 315_360_000; // 10 years, as in the program

const disc = (s: string) => Buffer.from(sha256(new TextEncoder().encode(s))).subarray(0, 8);
const LOCK_LP_IX = disc("global:lock_lp");
const CLAIM_IX = disc("global:claim_rewards");
const UNLOCK_IX = disc("global:unlock");
const LOCK_ACCOUNT = disc("account:Lock");
export const LOCK_LEN = 8 + 32 * 4 + 8 + 16 + 8 + 8 + 8 + 1 + 1;
/** Seed of the temporary wrapped-XNT account a claim unwraps through. */
const WXNT_TEMP_SEED = "lp-lock-nft-claim";

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

// ---------- PDAs ----------

const pda = (programId: PublicKey, ...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
export const nftAuthorityPda = (programId: PublicKey) => pda(programId, Buffer.from("nft_authority"));
export const lockPda = (programId: PublicKey, nftMint: PublicKey) => pda(programId, Buffer.from("lock"), nftMint.toBuffer());
export const lpVaultPda = (programId: PublicKey, lock: PublicKey) => pda(programId, Buffer.from("vault"), lock.toBuffer());
export const metadataPda = (nftMint: PublicKey) =>
  pda(METADATA_PROGRAM_ID, Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), nftMint.toBuffer());
export const masterEditionPda = (nftMint: PublicKey) =>
  pda(METADATA_PROGRAM_ID, Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), nftMint.toBuffer(), Buffer.from("edition"));

// ---------- Accounts ----------

export interface Lock {
  address: PublicKey;
  nftMint: PublicKey;
  pool: PublicKey;
  lpMint: PublicKey;
  /** Wallet that created the lock (the NFT, and with it every right, may have moved since). */
  locker: PublicKey;
  lockedLp: bigint;
  principal: bigint;
  feeLpClaimed: bigint;
  lockedAt: number;
  unlockAt: number;
}

export function decodeLock(address: PublicKey, d: Buffer): Lock {
  if (d.length !== LOCK_LEN || !d.subarray(0, 8).equals(LOCK_ACCOUNT)) throw new Error("Not a lock account");
  const key = (i: number) => new PublicKey(d.subarray(8 + i * 32, 40 + i * 32));
  return {
    address, nftMint: key(0), pool: key(1), lpMint: key(2), locker: key(3),
    lockedLp: d.readBigUInt64LE(136),
    principal: d.readBigUInt64LE(144) + (d.readBigUInt64LE(152) << 64n),
    feeLpClaimed: d.readBigUInt64LE(160),
    lockedAt: Number(d.readBigInt64LE(168)),
    unlockAt: Number(d.readBigInt64LE(176)),
  };
}

export async function getLock(conn: Connection, programId: PublicKey, nftMint: PublicKey): Promise<Lock | null> {
  const address = lockPda(programId, nftMint);
  const info = await conn.getAccountInfo(address, "confirmed");
  return info ? decodeLock(address, info.data) : null;
}

/** Every open lock, optionally only those on `pool`, oldest first. */
export async function listLocks(conn: Connection, programId: PublicKey, pool?: PublicKey): Promise<Lock[]> {
  const raw = await conn.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ dataSize: LOCK_LEN }, ...(pool ? [{ memcmp: { offset: 8 + 32, bytes: pool.toBase58() } }] : [])],
  });
  return raw.flatMap(({ pubkey, account }) => { try { return [decodeLock(pubkey, account.data)]; } catch { return []; } })
    .sort((a, b) => a.lockedAt - b.lockedAt);
}

/** The open locks whose NFT `wallet` holds right now (the ones it can claim and unlock). */
export async function locksHeldBy(conn: Connection, programId: PublicKey, wallet: PublicKey): Promise<Lock[]> {
  const { value } = await conn.getTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM_ID }, "confirmed");
  const nfts = value.map((a) => unpackAccount(a.pubkey, a.account, TOKEN_PROGRAM_ID)).filter((a) => a.amount === 1n).map((a) => a.mint);
  const locks: Lock[] = [];
  for (let i = 0; i < nfts.length; i += 100) {
    const batch = nfts.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(batch.map((n) => lockPda(programId, n)), "confirmed");
    infos.forEach((info, j) => { if (info?.owner.equals(programId)) locks.push(decodeLock(lockPda(programId, batch[j]), info.data)); });
  }
  return locks.sort((a, b) => a.lockedAt - b.lockedAt);
}

/** LP tokens currently in a lock's vault. */
export async function vaultLp(conn: Connection, programId: PublicKey, lock: PublicKey) {
  const vault = lpVaultPda(programId, lock);
  const info = await conn.getAccountInfo(vault, "confirmed");
  return info ? unpackAccount(vault, info, TOKEN_PROGRAM_ID).amount : 0n;
}

/** The wallet holding a lock NFT, and its token account. */
export async function nftHolder(conn: Connection, nftMint: PublicKey) {
  const largest = await conn.getTokenLargestAccounts(nftMint, "confirmed");
  const acc = largest.value.find((a) => a.amount === "1");
  if (!acc) return null;
  const info = await conn.getAccountInfo(acc.address, "confirmed");
  return { account: acc.address, owner: unpackAccount(acc.address, info, TOKEN_PROGRAM_ID).owner };
}

// ---------- Reward math (mirrors the program) ----------

export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) / 2n;
    if (y >= x) return x;
    x = y;
  }
}

/** LP tokens worth of trading fees, exactly as `claim_rewards` computes it. */
export function pendingFeeLp(lockedLp: bigint, principal: bigint, sqrtK: bigint, supply: bigint) {
  const value = (lockedLp * sqrtK) / supply;
  return value > principal ? ((value - principal) * supply) / sqrtK : 0n;
}

export interface RewardQuote {
  lock: Lock;
  state: PoolState;
  lpInVault: bigint;
  feeLp: bigint;
  /** What the holder receives of each pool token (net of any Token-2022 transfer fee). */
  out: [bigint, bigint];
  /** Minimums passed to the program (`out` minus slippage). */
  min: [bigint, bigint];
  /** The locked LP's share of each pool token right now (principal plus unclaimed fees). */
  lockedValue: [bigint, bigint];
}

/** What `claim_rewards` would pay right now. */
export async function quoteRewards(
  conn: Connection, programId: PublicKey, xdex: PublicKey, lock: Lock, slippageBps = 100,
): Promise<RewardQuote> {
  const state = await readPool(conn, xdex, lock.pool);
  const { pool, reserves } = state;
  const lpInVault = await vaultLp(conn, programId, lock.address);
  const feeLp = pendingFeeLp(lpInVault, lock.principal, isqrt(reserves[0] * reserves[1]), pool.lpSupply);
  const { epoch } = await conn.getEpochInfo("confirmed");
  const mintInfos = await conn.getMultipleAccountsInfo(pool.mints, "confirmed");
  const out = [0, 1].map((i) => {
    const gross = (feeLp * reserves[i]) / pool.lpSupply;
    if (!pool.programs[i].equals(TOKEN_2022_PROGRAM_ID)) return gross;
    const feeCfg = getTransferFeeConfig(unpackMint(pool.mints[i], mintInfos[i], TOKEN_2022_PROGRAM_ID));
    return feeCfg ? gross - calculateEpochFee(feeCfg, BigInt(epoch), gross) : gross;
  }) as [bigint, bigint];
  const min = out.map((o) => (o * BigInt(10_000 - slippageBps)) / 10_000n) as [bigint, bigint];
  const lockedValue = reserves.map((r) => (lpInVault * r) / pool.lpSupply) as [bigint, bigint];
  return { lock, state, lpInVault, feeLp, out, min, lockedValue };
}

// ---------- Instruction builders ----------

const borshString = (s: string) => {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};

export interface LockParams {
  pool: PublicKey;
  /** LP base units, or "all" of the owner's LP. */
  amount: bigint | "all";
  durationSeconds: number;
  name: string;
  symbol: string;
  /** Metaplex metadata JSON (an https link to IPFS or Arweave). */
  uri: string;
  /** The NFT mint to create; a fresh one when omitted (pass one to know its address before pinning art). */
  nftMint?: Keypair;
}

/**
 * Lock LP from `owner`'s associated LP account and mint the lock NFT to them. Returns the
 * fresh NFT mint keypair, which must co-sign.
 */
export async function buildLockLp(conn: Connection, programId: PublicKey, xdex: PublicKey, owner: PublicKey, p: LockParams) {
  if (!Number.isInteger(p.durationSeconds) || p.durationSeconds <= 0) throw new Error("Lock duration must be a whole number of seconds > 0.");
  if (p.durationSeconds > MAX_LOCK_DURATION) throw new Error("Lock duration exceeds the 10-year maximum.");
  if (Buffer.byteLength(p.name) > 32) throw new Error("NFT name is longer than 32 bytes.");
  if (Buffer.byteLength(p.symbol) > 10) throw new Error("NFT symbol is longer than 10 bytes.");
  if (Buffer.byteLength(p.uri) > 200) throw new Error("NFT metadata URI is longer than 200 bytes.");

  const { pool } = await readPool(conn, xdex, p.pool);
  const ownerLp = getAssociatedTokenAddressSync(pool.lpMint, owner, false, TOKEN_PROGRAM_ID);
  const lpInfo = await conn.getAccountInfo(ownerLp, "confirmed");
  const held = lpInfo ? unpackAccount(ownerLp, lpInfo, TOKEN_PROGRAM_ID).amount : 0n;
  const lp = p.amount === "all" ? held : p.amount;
  if (lp <= 0n || lp > held) throw new Error(`Wallet holds ${held} LP base units; cannot lock ${p.amount}.`);

  const nft = p.nftMint ?? Keypair.generate();
  const lock = lockPda(programId, nft.publicKey);
  const vault = lpVaultPda(programId, lock);
  const ownerNft = getAssociatedTokenAddressSync(nft.publicKey, owner, false, TOKEN_PROGRAM_ID);
  const amount = Buffer.alloc(16);
  amount.writeBigUInt64LE(lp, 0);
  amount.writeBigInt64LE(BigInt(p.durationSeconds), 8);
  const data = Buffer.concat([LOCK_LP_IX, amount, borshString(p.name), borshString(p.symbol), borshString(p.uri)]);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    new TransactionInstruction({
      programId, data,
      keys: [
        meta(owner, true, true), meta(p.pool, false, false),
        meta(pool.vaults[0], false, false), meta(pool.vaults[1], false, false),
        meta(pool.lpMint, false, false), meta(ownerLp, false, true),
        meta(nftAuthorityPda(programId), false, false), meta(nft.publicKey, true, true), meta(ownerNft, false, true),
        meta(lock, false, true), meta(vault, false, true),
        meta(metadataPda(nft.publicKey), false, true), meta(masterEditionPda(nft.publicKey), false, true),
        meta(TOKEN_PROGRAM_ID, false, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
        meta(METADATA_PROGRAM_ID, false, false), meta(SystemProgram.programId, false, false), meta(SYSVAR_RENT_PUBKEY, false, false),
      ],
    }),
  ];
  return { ixs, signers: [nft], summary: { lp, held, lpDecimals: pool.lpDecimals, nftMint: nft.publicKey, lock, vault } };
}

/**
 * Options for the claim and unlock builders. `force` skips the client-side checks (who
 * holds the NFT, nothing to claim, still locked) and uses `holder`'s own NFT account, so
 * the program's checks can be exercised; the program enforces all of them regardless.
 */
export interface BuildOpts { slippageBps?: number; force?: boolean }

const holderNftAccount = async (conn: Connection, holder: PublicKey, nftMint: PublicKey, force?: boolean) => {
  if (force) return getAssociatedTokenAddressSync(nftMint, holder, false, TOKEN_PROGRAM_ID);
  const nftAcc = await nftHolder(conn, nftMint);
  if (!nftAcc?.owner.equals(holder)) throw new Error(`That lock's NFT is held by ${nftAcc?.owner.toBase58() ?? "nobody"}, not this wallet.`);
  return nftAcc.account;
};

/**
 * Claim the trading fees of the lock `holder`'s NFT controls. Pool tokens land in the
 * holder's associated accounts; wrapped XNT is unwrapped straight into the wallet.
 * Returns `ixs: null` when there is nothing to claim.
 */
export async function buildClaimRewards(
  conn: Connection, programId: PublicKey, xdex: PublicKey, holder: PublicKey, nftMint: PublicKey, opts: BuildOpts = {},
) {
  const lock = await getLock(conn, programId, nftMint);
  if (!lock) throw new Error("No open lock for that NFT.");
  const nftAccount = await holderNftAccount(conn, holder, nftMint, opts.force);
  const q = await quoteRewards(conn, programId, xdex, lock, opts.slippageBps ?? 100);
  // XDEX refuses a withdrawal that pays 0 of either token, so dust waits for more fees.
  if (!opts.force && (q.feeLp <= 0n || q.out[0] === 0n || q.out[1] === 0n)) return { ixs: null, quote: q };
  const pool: Pool = q.state.pool;

  const pre: TransactionInstruction[] = [];
  const post: TransactionInstruction[] = [];
  const dest: PublicKey[] = [];
  for (const i of [0, 1]) {
    const [mint, program] = [pool.mints[i], pool.programs[i]];
    if (mint.equals(NATIVE_MINT)) {
      const temp = await PublicKey.createWithSeed(holder, WXNT_TEMP_SEED, program);
      if (await conn.getAccountInfo(temp, "confirmed")) throw new Error(`Temporary account ${temp.toBase58()} exists from an earlier attempt; close it first.`);
      pre.push(
        SystemProgram.createAccountWithSeed({
          fromPubkey: holder, newAccountPubkey: temp, basePubkey: holder, seed: WXNT_TEMP_SEED,
          lamports: await conn.getMinimumBalanceForRentExemption(165), space: 165, programId: program,
        }),
        createInitializeAccount3Instruction(temp, NATIVE_MINT, holder, program),
      );
      post.push(createCloseAccountInstruction(temp, holder, holder, [], program));
      dest.push(temp);
    } else {
      const ata = getAssociatedTokenAddressSync(mint, holder, false, program);
      pre.push(createAssociatedTokenAccountIdempotentInstruction(holder, ata, holder, mint, program));
      dest.push(ata);
    }
  }
  const data = Buffer.alloc(24);
  CLAIM_IX.copy(data, 0);
  data.writeBigUInt64LE(q.min[0], 8);
  data.writeBigUInt64LE(q.min[1], 16);
  const ixs = [
    ...pre,
    new TransactionInstruction({
      programId, data,
      keys: [
        meta(holder, true, true), meta(lock.address, false, true), meta(nftAccount, false, false),
        meta(lpVaultPda(programId, lock.address), false, true), meta(lock.pool, false, true), meta(poolAuthority(xdex), false, false),
        meta(dest[0], false, true), meta(dest[1], false, true),
        meta(pool.vaults[0], false, true), meta(pool.vaults[1], false, true),
        meta(TOKEN_PROGRAM_ID, false, false), meta(TOKEN_2022_PROGRAM_ID, false, false),
        meta(pool.mints[0], false, false), meta(pool.mints[1], false, false),
        meta(pool.lpMint, false, true), meta(MEMO_PROGRAM_ID, false, false), meta(xdex, false, false),
      ],
    }),
    ...post,
  ];
  return { ixs, quote: q };
}

/** After the lock ends: all LP to the NFT holder, NFT burned, every account's rent refunded. */
export async function buildUnlock(conn: Connection, programId: PublicKey, holder: PublicKey, nftMint: PublicKey, opts: BuildOpts = {}) {
  const lock = await getLock(conn, programId, nftMint);
  if (!lock) throw new Error("No open lock for that NFT (already unlocked?).");
  if (!opts.force && lock.unlockAt > Date.now() / 1000) throw new Error(`Still locked until ${new Date(lock.unlockAt * 1000).toISOString()}.`);
  const nftAccount = await holderNftAccount(conn, holder, nftMint, opts.force);
  const holderLp = getAssociatedTokenAddressSync(lock.lpMint, holder, false, TOKEN_PROGRAM_ID);
  const lp = await vaultLp(conn, programId, lock.address);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(holder, holderLp, holder, lock.lpMint, TOKEN_PROGRAM_ID),
    new TransactionInstruction({
      programId, data: Buffer.from(UNLOCK_IX),
      keys: [
        meta(holder, true, true), meta(lock.address, false, true), meta(nftMint, false, true), meta(nftAccount, false, true),
        meta(lpVaultPda(programId, lock.address), false, true), meta(holderLp, false, true),
        meta(metadataPda(nftMint), false, true), meta(masterEditionPda(nftMint), false, true),
        meta(TOKEN_PROGRAM_ID, false, false), meta(METADATA_PROGRAM_ID, false, false),
      ],
    }),
  ];
  return { ixs, summary: { lock: lock.address, lp, holderLp } };
}
