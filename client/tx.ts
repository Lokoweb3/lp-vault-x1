/**
 * Transaction assembly shared by the CLI and the web app. X1 charges for the compute units
 * a transaction *requests* (used or not), so every transaction is simulated first and its
 * limit set to what it uses plus headroom (same rule as x1-reflection-token's src/tx.ts).
 */
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const LIMIT_HEADROOM = 1.2;
const LIMIT_EXTRA = 3_000;
const MAX_UNITS = 1_400_000;
const isLimit = (ix: TransactionInstruction) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2;

/** Replace (or add) the compute-unit limit with what `ixs` actually use, plus headroom. */
export async function fitComputeLimit(conn: Connection, ixs: TransactionInstruction[], payer: PublicKey) {
  const body = ixs.filter((ix) => !isLimit(ix));
  try {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const probe = [ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_UNITS }), ...body];
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: probe }).compileToV0Message());
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    if (sim.value.err || !sim.value.unitsConsumed) return ixs; // the real simulation reports why
    const units = Math.min(MAX_UNITS, Math.ceil(sim.value.unitsConsumed * LIMIT_HEADROOM) + LIMIT_EXTRA);
    return [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...body];
  } catch {
    return ixs;
  }
}

/** Simulation failure with the program's own error lines, readable by a person. */
export class SimulationError extends Error {
  constructor(public err: unknown, public logs: string[]) {
    const lines = logs.filter((l) => /Error Message|failed|insufficient|Error:/i.test(l)).slice(-2).join(" | ");
    super(`Simulation failed${lines ? `: ${lines.replace(/^Program log: /, "")}` : `: ${JSON.stringify(err)}`}`);
  }
}

/**
 * A ready-to-sign legacy transaction for `payer`: compute limit fitted, extra keypairs (a
 * new NFT mint) already signed, and simulated so problems surface before a wallet prompt.
 */
export async function prepareTx(conn: Connection, payer: PublicKey, ixs: TransactionInstruction[], extra: Keypair[] = []) {
  const fitted = await fitComputeLimit(conn, ixs, payer);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(...fitted);
  if (extra.length) tx.partialSign(...extra);
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) throw new SimulationError(sim.value.err, sim.value.logs ?? []);
  return { tx, lastValidBlockHeight, unitsConsumed: sim.value.unitsConsumed ?? 0 };
}

/** Send signed bytes and wait for confirmation (by polling, which works on every RPC). */
export async function sendAndConfirmRaw(conn: Connection, raw: Uint8Array, lastValidBlockHeight: number) {
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed" });
  for (;;) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const s = value[0];
    if (s?.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return sig;
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error(`Transaction ${sig} expired before confirming; try again.`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
