/**
 * Minimal XDEX (Raydium CP-swap fork) client: read a pool, and (for tests and tooling)
 * create a pool and swap. Layout, discriminators and account orders match
 * x1-reflection-token/src/xdex.ts, which is verified against real X1 mainnet and testnet
 * transactions.
 */
import { sha256 } from "@noble/hashes/sha2";
import {
  AccountInfo, Connection, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, TransactionInstruction,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";

export const XDEX_PROGRAM: Record<Network, PublicKey> = {
  mainnet: new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN"),
  testnet: new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf"),
};
export type Network = "mainnet" | "testnet";

const disc = (s: string) => Buffer.from(sha256(new TextEncoder().encode(s))).subarray(0, 8);
const POOL_DISC = disc("account:PoolState");
const CONFIG_DISC = disc("account:AmmConfig");
const SWAP_BASE_INPUT = disc("global:swap_base_input");
const INITIALIZE = disc("global:initialize");
const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

export interface Pool {
  address: PublicKey;
  ammConfig: PublicKey;
  vaults: [PublicKey, PublicKey];
  mints: [PublicKey, PublicKey];
  programs: [PublicKey, PublicKey];
  observation: PublicKey;
  lpMint: PublicKey;
  lpSupply: bigint;
  lpDecimals: number;
  mintDecimals: [number, number];
  withdrawPaused: boolean;
  /** Unix seconds from which the pool accepts swaps. */
  openTime: number;
  protocolFees: [bigint, bigint];
  fundFees: [bigint, bigint];
}

export function decodePool(address: PublicKey, info: AccountInfo<Buffer> | null, xdex: PublicKey): Pool {
  if (!info || !info.owner.equals(xdex)) throw new Error(`${address.toBase58()} is not an XDEX pool on this network`);
  const d = info.data;
  if (d.length !== 637 || !d.subarray(0, 8).equals(POOL_DISC)) throw new Error("Unsupported XDEX pool layout");
  const key = (i: number) => new PublicKey(d.subarray(8 + i * 32, 40 + i * 32));
  const u64 = (o: number) => d.readBigUInt64LE(o);
  return {
    address, ammConfig: key(0), vaults: [key(2), key(3)], lpMint: key(4), mints: [key(5), key(6)],
    programs: [key(7), key(8)], observation: key(9),
    withdrawPaused: (d[329] & 2) !== 0, lpDecimals: d[330], mintDecimals: [d[331], d[332]], lpSupply: u64(333),
    protocolFees: [u64(341), u64(349)], fundFees: [u64(357), u64(365)], openTime: Number(u64(373)),
  };
}

export interface PoolState { pool: Pool; reserves: [bigint, bigint]; tradeFeeRate: bigint }

/** Pool plus its reserves net of protocol and fund fees (how XDEX itself prices LP). */
export async function readPool(conn: Connection, xdex: PublicKey, address: PublicKey): Promise<PoolState> {
  const pool = decodePool(address, await conn.getAccountInfo(address, "confirmed"), xdex);
  const [v0, v1, cfg] = await conn.getMultipleAccountsInfo([pool.vaults[0], pool.vaults[1], pool.ammConfig], "confirmed");
  if (!cfg || !cfg.data.subarray(0, 8).equals(CONFIG_DISC)) throw new Error("Invalid XDEX fee config");
  const reserves = [0, 1].map((i) => {
    const acc = unpackAccount(pool.vaults[i], i === 0 ? v0 : v1, pool.programs[i]);
    return acc.amount - pool.protocolFees[i] - pool.fundFees[i];
  }) as [bigint, bigint];
  return { pool, reserves, tradeFeeRate: cfg.data.readBigUInt64LE(12) };
}

export const poolAuthority = (xdex: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault_and_lp_mint_auth_seed")], xdex)[0];

/** Per-network constants for creating XDEX pools (from x1-reflection-token, verified on chain). */
export const XDEX_CREATE: Record<Network, { ammConfig: PublicKey; createPoolFee: PublicKey }> = {
  mainnet: { ammConfig: new PublicKey("2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c"), createPoolFee: new PublicKey("SKc6b6zAv2kkB9EtitjppbzPVR48bCMfRtE5B8KDuF1") },
  testnet: { ammConfig: new PublicKey("3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY"), createPoolFee: new PublicKey("DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS") },
};

/** Addresses XDEX derives for the pool of mints `a` and `b` under `ammConfig`. */
export function poolAddresses(xdex: PublicKey, ammConfig: PublicKey, a: PublicKey, b: PublicKey) {
  const [mint0, mint1] = Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, xdex)[0];
  const pool = pda(Buffer.from("pool"), ammConfig.toBuffer(), mint0.toBuffer(), mint1.toBuffer());
  return {
    pool, mint0, mint1,
    lpMint: pda(Buffer.from("pool_lp_mint"), pool.toBuffer()),
    vault0: pda(Buffer.from("pool_vault"), pool.toBuffer(), mint0.toBuffer()),
    vault1: pda(Buffer.from("pool_vault"), pool.toBuffer(), mint1.toBuffer()),
    observation: pda(Buffer.from("observation"), pool.toBuffer()),
  };
}

/**
 * Create a pool of `mintA`/`mintB` (SPL Token or Token-2022, from `creator`'s associated
 * accounts) seeded with `amountA`/`amountB`. XDEX mints the LP tokens to the creator.
 */
export function buildCreatePool(
  network: Network, creator: PublicKey,
  a: { mint: PublicKey; program: PublicKey; amount: bigint }, b: { mint: PublicKey; program: PublicKey; amount: bigint },
) {
  const xdex = XDEX_PROGRAM[network];
  const net = XDEX_CREATE[network];
  const p = poolAddresses(xdex, net.ammConfig, a.mint, b.mint);
  const [s0, s1] = p.mint0.equals(a.mint) ? [a, b] : [b, a];
  const ata = (s: typeof a) => getAssociatedTokenAddressSync(s.mint, creator, false, s.program);
  const data = Buffer.alloc(32);
  INITIALIZE.copy(data, 0);
  data.writeBigUInt64LE(s0.amount, 8);
  data.writeBigUInt64LE(s1.amount, 16);
  data.writeBigUInt64LE(0n, 24); // open immediately
  const ix = new TransactionInstruction({
    programId: xdex, data,
    keys: [
      m(creator, true, true), m(net.ammConfig, false, false), m(poolAuthority(xdex), false, false),
      m(p.pool, false, true), m(p.mint0, false, false), m(p.mint1, false, false), m(p.lpMint, false, true),
      m(ata(s0), false, true), m(ata(s1), false, true),
      m(getAssociatedTokenAddressSync(p.lpMint, creator, false, TOKEN_PROGRAM_ID), false, true),
      m(p.vault0, false, true), m(p.vault1, false, true), m(net.createPoolFee, false, true),
      m(p.observation, false, true), m(TOKEN_PROGRAM_ID, false, false), m(s0.program, false, false), m(s1.program, false, false),
      m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), m(SystemProgram.programId, false, false), m(SYSVAR_RENT_PUBKEY, false, false),
    ],
  });
  return { ix, ...p };
}

/** XDEX swap_base_input: sell `amountIn` of `pool.mints[side]` from `source` into `dest`. */
export function swapIx(xdex: PublicKey, owner: PublicKey, pool: Pool, side: 0 | 1, source: PublicKey, dest: PublicKey, amountIn: bigint, minimumOut: bigint) {
  const data = Buffer.alloc(24);
  SWAP_BASE_INPUT.copy(data, 0);
  data.writeBigUInt64LE(amountIn, 8);
  data.writeBigUInt64LE(minimumOut, 16);
  const o = 1 - side;
  return new TransactionInstruction({
    programId: xdex, data,
    keys: [
      m(owner, true, true), m(poolAuthority(xdex), false, false), m(pool.ammConfig, false, false), m(pool.address, false, true),
      m(source, false, true), m(dest, false, true), m(pool.vaults[side], false, true), m(pool.vaults[o], false, true),
      m(pool.programs[side], false, false), m(pool.programs[o], false, false), m(pool.mints[side], false, false),
      m(pool.mints[o], false, false), m(pool.observation, false, true),
    ],
  });
}

/** The XDEX pool whose LP mint is `lpMint` (the LP mint is a PDA of its pool), or null. */
export async function poolByLpMint(conn: Connection, xdex: PublicKey, lpMint: PublicKey): Promise<Pool | null> {
  const raw = await conn.getProgramAccounts(xdex, {
    commitment: "confirmed",
    filters: [{ dataSize: 637 }, { memcmp: { offset: 8 + 4 * 32, bytes: lpMint.toBase58() } }],
  });
  for (const { pubkey, account } of raw) {
    try {
      const pool = decodePool(pubkey, account, xdex);
      if (pool.lpMint.equals(lpMint)) return pool;
    } catch { /* not a pool */ }
  }
  return null;
}
