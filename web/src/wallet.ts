/**
 * Browser wallets (ported from x1-reflection-token's src/web/wallet.js): Wallet Standard
 * wallets (X1 Wallet, Backpack, ...) and older injected ones. Connects, remembers the
 * wallet by name and reconnects silently next time (wallets only allow that for sites the
 * viewer already approved), and signs raw transaction bytes. Keys never leave the wallet.
 */
import { Transaction } from "@solana/web3.js";

interface StandardAccount { address: string; chains?: readonly string[] }
interface StandardWallet {
  name: string;
  icon?: string;
  accounts?: readonly StandardAccount[];
  features: Record<string, any>;
}
interface LegacyProvider {
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: { toString(): string } } | void>;
  disconnect?(): Promise<void>;
  publicKey?: { toString(): string };
  signTransaction(tx: Transaction): Promise<Transaction>;
}
export interface WalletChoice { name: string; icon?: string; standard?: StandardWallet; legacy?: LegacyProvider }

const KEY = "lp-lock-nft-wallet";
const remember = (name: string | null) => { try { name ? localStorage.setItem(KEY, name) : localStorage.removeItem(KEY); } catch { /* storage off */ } };
const remembered = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

const standard: StandardWallet[] = [];
export const wallet = {
  address: null as string | null,
  name: null as string | null,
  active: null as StandardWallet | null,
  account: null as StandardAccount | null,
  legacy: null as LegacyProvider | null,
};
const listeners = new Set<() => void>();
export const onWalletChange = (f: () => void) => { listeners.add(f); };
const emit = () => listeners.forEach((f) => f());

function register(...ws: StandardWallet[]) {
  for (const w of ws) {
    if (w?.features?.["standard:connect"] && w.features["solana:signTransaction"] && !standard.includes(w)) standard.push(w);
  }
  queueMicrotask(autoConnect);
  emit();
  return () => {};
}
window.addEventListener("wallet-standard:register-wallet", (e: any) => { try { e.detail({ register }); } catch { /* bad wallet */ } });
try { window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register } })); } catch { /* old browser */ }

export function walletChoices(): WalletChoice[] {
  const w = window as any;
  const seen = new Set<unknown>();
  const legacy = ([["Backpack", w.backpack], ["Phantom", w.phantom?.solana], ["Solflare", w.solflare], ["Browser wallet", w.solana]] as [string, LegacyProvider][])
    .filter(([, p]) => p && typeof p.connect === "function" && typeof p.signTransaction === "function" && !seen.has(p) && seen.add(p))
    .filter(([name]) => !standard.some((s) => s.name === name));
  return [...standard.map((s) => ({ name: s.name, icon: s.icon, standard: s })), ...legacy.map(([name, p]) => ({ name, legacy: p }))];
}

export async function connect(choice: WalletChoice, { silent = false } = {}) {
  if (choice.standard) {
    const r = await choice.standard.features["standard:connect"].connect(silent ? { silent: true } : undefined);
    const account = r?.accounts?.[0] ?? choice.standard.accounts?.[0];
    if (!account) throw new Error("The wallet didn't share an account.");
    Object.assign(wallet, { active: choice.standard, account, legacy: null, address: account.address, name: choice.name });
  } else {
    const r = await choice.legacy!.connect(silent ? { onlyIfTrusted: true } : undefined);
    const pk = (r && r.publicKey) ?? choice.legacy!.publicKey;
    if (!pk) throw new Error("The wallet didn't share an account.");
    Object.assign(wallet, { active: null, account: null, legacy: choice.legacy, address: pk.toString(), name: choice.name });
  }
  remember(choice.name);
  emit();
}

let tried = false;
async function autoConnect() {
  const name = remembered();
  if (!name || wallet.address || tried) return;
  const c = walletChoices().find((x) => x.name === name);
  if (!c) return; // not announced yet; register() calls back when it is
  tried = true;
  try { await connect(c, { silent: true }); } catch { /* not pre-approved: wait for a click */ }
}
setTimeout(autoConnect, 50);
setTimeout(autoConnect, 800); // injected (non-standard) wallets can appear late

export async function disconnect() {
  try { await wallet.active?.features["standard:disconnect"]?.disconnect(); await wallet.legacy?.disconnect?.(); } catch { /* ignore */ }
  Object.assign(wallet, { active: null, account: null, legacy: null, address: null, name: null });
  remember(null);
  emit();
}

/** Sign a transaction (already partially signed by any extra keys); returns the signed bytes. */
export async function signTransaction(tx: Transaction): Promise<Uint8Array> {
  if (wallet.active && wallet.account) {
    const input: Record<string, unknown> = { account: wallet.account, transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }) };
    if (wallet.account.chains?.length) input.chain = wallet.account.chains[0];
    const [out] = await wallet.active.features["solana:signTransaction"].signTransaction(input);
    return out.signedTransaction;
  }
  if (!wallet.legacy) throw new Error("Connect a wallet first.");
  const signed = await wallet.legacy.signTransaction(tx);
  return signed.serialize({ requireAllSignatures: true });
}
