/**
 * LP Lock NFT web app. Everything runs in the browser against the X1 RPC; the wallet signs.
 * Server calls: /api/key (the live vault key image, also the preview here) and, only for a
 * custom uploaded image, /api/pin (Pinata key stays server-side).
 */
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { Network, Pool, XDEX_PROGRAM, poolAuthority, poolByLpMint, readPool } from "../../client/xdex.js";
import {
  Lock, buildClaimRewards, buildLockLp, buildUnlock, getLock, listLocks, locksHeldBy, nftHolder, quoteRewards,
} from "../../client/lp-lock-nft.js";
import { nftMetadata, tokenLabel } from "../../client/tokens.js";
import { SimulationError, prepareTx, sendAndConfirmRaw } from "../../client/tx.js";
import { connect, disconnect, onWalletChange, signTransaction, wallet, walletChoices } from "./wallet.js";

declare const __PROGRAM_IDS__: Record<Network, string>;

const RPC: Record<Network, string> = { mainnet: "https://rpc.mainnet.x1.xyz", testnet: "https://rpc.testnet.x1.xyz" };
const EXPLORER: Record<Network, string> = { mainnet: "https://explorer.mainnet.x1.xyz", testnet: "https://explorer.testnet.x1.xyz" };
const MAX_IMAGE_BYTES = 500_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

let network: Network = params.get("network") === "testnet" ? "testnet" : "mainnet";
let conn: Connection, programId: PublicKey, xdex: PublicKey;
function setNetwork(n: Network) {
  network = n;
  // A custom RPC only on a local dev server: a link can't point real users at a fake chain.
  conn = new Connection((isLocal && params.get("rpc")) || RPC[n], "confirmed");
  programId = new PublicKey(__PROGRAM_IDS__[n]);
  xdex = XDEX_PROGRAM[n];
  $<HTMLSelectElement>("network").value = n;
  const link = $<HTMLAnchorElement>("programLink");
  link.textContent = programId.toBase58();
  link.href = `${EXPLORER[n]}/address/${programId.toBase58()}`;
}

// ---------- formatting ----------
function fmt(v: bigint, decimals: number, maxFrac = 6) {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  let frac = decimals ? s.slice(-decimals).slice(0, maxFrac).replace(/0+$/, "") : "";
  if (!frac && v !== 0n && whole === "0") frac = "0".repeat(Math.max(0, maxFrac - 1)) + "1"; // "<" tiny
  return `${neg ? "-" : ""}${Number(whole).toLocaleString("en-US")}${frac ? "." + frac : ""}`;
}
function parseUnits(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}
const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
function countdown(t: number) {
  let s = Math.max(0, Math.floor(t - Date.now() / 1000));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s % 60}s`;
}
const short = (k: PublicKey | string) => { const s = k.toString(); return `${s.slice(0, 4)}…${s.slice(-4)}`; };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === "class" ? (e.className = v) : e.setAttribute(k, v);
  e.append(...kids);
  return e;
};
const link = (href: string, text: string) => el("a", { href, target: "_blank", rel: "noopener" }, text);

function errorText(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  if (/User rejected|rejected the request|denied/i.test(m)) return "You cancelled in the wallet.";
  if (e instanceof SimulationError && /insufficient|0x1\b/i.test(m)) return `${m}\n(Not enough XNT for fees and rent?)`;
  return m;
}
function setStatus(id: string, text: string, kind: "" | "ok" | "err" = "") {
  const s = $(id);
  s.textContent = text;
  s.className = `status ${kind}`;
}

// ---------- sending ----------
async function signAndSend(ixs: TransactionInstruction[], extra: Keypair[], onStep: (s: string) => void) {
  if (!wallet.address) throw new Error("Connect a wallet first.");
  onStep("Checking the transaction…");
  const { tx, lastValidBlockHeight } = await prepareTx(conn, new PublicKey(wallet.address), ixs, extra);
  onStep("Approve it in your wallet…");
  const signed = await signTransaction(tx);
  onStep("Sending…");
  return sendAndConfirmRaw(conn, signed, lastValidBlockHeight);
}

// ---------- wallet UI ----------
function renderConnect() {
  $("connect").textContent = wallet.address ? `${short(wallet.address)} ▾` : "Connect wallet";
}
$("connect").onclick = () => {
  const menu = $("walletMenu");
  if (!menu.hidden) { menu.hidden = true; return; }
  menu.replaceChildren();
  if (wallet.address) {
    menu.append(el("button", {}, "Disconnect"));
    (menu.lastChild as HTMLElement).onclick = () => { menu.hidden = true; void disconnect(); };
  } else {
    const choices = walletChoices();
    if (!choices.length) menu.append(el("div", { class: "muted small", style: "padding:.5rem" }, "No wallet found. Install X1 Wallet or Backpack."));
    for (const c of choices) {
      const b = el("button", {}, ...(c.icon ? [el("img", { src: c.icon, alt: "" })] : []), c.name);
      b.onclick = async () => {
        menu.hidden = true;
        try { await connect(c); } catch (e) { notice(errorText(e)); }
      };
      menu.append(b);
    }
  }
  menu.hidden = false;
};
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest("#walletMenu, #connect")) $("walletMenu").hidden = true;
});
function notice(text: string | null) {
  const n = $("notice");
  n.hidden = !text;
  n.textContent = text ?? "";
}

// ---------- your LP positions ----------
interface Position { pool: Pool; reserves: [bigint, bigint]; held: bigint; pair: string; symbols: [string, string] }
let positions: Position[] = [];

async function loadPositions() {
  const gate = $("lockGate"), form = $<HTMLFormElement>("lockForm");
  if (!wallet.address) { gate.textContent = "Connect a wallet to see your LP."; gate.hidden = false; form.hidden = true; return; }
  gate.textContent = "Counting the XDEX LP in your wallet…";
  gate.hidden = false;
  form.hidden = true;
  try {
    const owner = new PublicKey(wallet.address);
    const { value } = await conn.getTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, "confirmed");
    const held = new Map<string, bigint>();
    for (const a of value) {
      const acc = unpackAccount(a.pubkey, a.account, TOKEN_PROGRAM_ID);
      if (acc.amount > 0n) held.set(acc.mint.toBase58(), (held.get(acc.mint.toBase58()) ?? 0n) + acc.amount);
    }
    // XDEX LP mints are all minted by XDEX's one authority PDA: cheap filter before looking up pools.
    const mints = [...held.keys()].map((m) => new PublicKey(m));
    const auth = poolAuthority(xdex);
    const lpMints: PublicKey[] = [];
    for (let i = 0; i < mints.length; i += 100) {
      const infos = await conn.getMultipleAccountsInfo(mints.slice(i, i + 100), "confirmed");
      infos.forEach((info, j) => {
        if (!info) return;
        try { if (unpackMint(mints[i + j], info, TOKEN_PROGRAM_ID).mintAuthority?.equals(auth)) lpMints.push(mints[i + j]); } catch { /* not a mint */ }
      });
    }
    positions = [];
    for (const lpMint of lpMints) {
      const pool = await poolByLpMint(conn, xdex, lpMint);
      if (!pool) continue;
      const { reserves } = await readPool(conn, xdex, pool.address);
      const [a, b] = await Promise.all(pool.mints.map((m) => tokenLabel(conn, m)));
      positions.push({ pool: { ...pool }, reserves, held: held.get(lpMint.toBase58())!, pair: `${a.symbol}/${b.symbol}`, symbols: [a.symbol, b.symbol] });
    }
    if (!positions.length) { gate.textContent = `No XDEX LP tokens in this wallet on ${network}. Add liquidity on XDEX first.`; return; }
    const sel = $<HTMLSelectElement>("position");
    sel.replaceChildren(...positions.map((p, i) => el("option", { value: String(i) }, `${p.pair} · ${fmt(p.held, p.pool.lpDecimals)} LP`)));
    gate.hidden = true;
    form.hidden = false;
    onPositionChange();
  } catch (e) {
    gate.textContent = `Couldn't read your LP: ${errorText(e)}`;
  }
}

const current = () => positions[Number($<HTMLSelectElement>("position").value)] as Position | undefined;
const lpAmount = () => { const p = current(); return p ? parseUnits($<HTMLInputElement>("amount").value, p.pool.lpDecimals) : null; };
const lockDays = () => Number($<HTMLInputElement>("days").value);
const durationSeconds = () => Math.round(lockDays() * 86_400);

function onPositionChange() {
  const p = current();
  if (!p) return;
  $<HTMLInputElement>("amount").value = fmt(p.held, p.pool.lpDecimals, p.pool.lpDecimals).replace(/,/g, "");
  $<HTMLInputElement>("nftName").value = `${p.pair} LP Vault`.slice(0, 32);
  $("positionInfo").textContent = `Pool ${p.pool.address.toBase58()}`;
  refreshPreview();
}
$("position").onchange = onPositionChange;
$("pctChips").onclick = (e) => {
  const pct = (e.target as HTMLElement).dataset.pct, p = current();
  if (!pct || !p) return;
  $<HTMLInputElement>("amount").value = fmt((p.held * BigInt(pct)) / 100n, p.pool.lpDecimals, p.pool.lpDecimals).replace(/,/g, "");
  refreshPreview();
};
$("durationChips").onclick = (e) => {
  const d = (e.target as HTMLElement).dataset.days;
  if (!d) return;
  $<HTMLInputElement>("days").value = d;
  refreshPreview();
};
for (const id of ["amount", "days", "nftName", "nftSymbol"]) $(id).addEventListener("input", refreshPreview);
$("understand").addEventListener("change", refreshPreview);

let customImage: Uint8Array | null = null;
let validationShown = false;
function refreshPreview() {
  const p = current();
  const days = lockDays();
  for (const b of $("durationChips").querySelectorAll("button")) b.classList.toggle("on", Number(b.dataset.days) === days);
  const validDays = Number.isFinite(days) && days > 0 && days <= 3650;
  const unlockAt = Math.floor(Date.now() / 1000) + (validDays ? durationSeconds() : 0);
  $("unlockDate").textContent = validDays ? when(unlockAt) : "—";
  const amt = lpAmount();
  const okAmount = !!p && amt !== null && amt > 0n && amt <= p.held;
  showValue(p, okAmount ? amt! : null);
  if (p && okAmount && validDays && !customImage) schedulePreview(p.pool.address.toBase58(), amt!, unlockAt);
  const name = $<HTMLInputElement>("nftName").value.trim(), symbol = $<HTMLInputElement>("nftSymbol").value.trim();
  const problem = !p ? "" : !okAmount ? "Enter an amount up to what you hold." : !validDays ? "Pick a term up to 10 years." :
    !name || new TextEncoder().encode(name).length > 32 ? "The key name must be 1-32 characters." :
    !symbol || new TextEncoder().encode(symbol).length > 10 ? "The symbol must be 1-10 characters." : "";
  // Only touch the status line for validation; never wipe a lock's result message.
  if (!busy && (problem || validationShown)) setStatus("lockStatus", problem, problem ? "err" : "");
  validationShown = !busy && !!problem;
  $<HTMLButtonElement>("lockBtn").disabled = busy || !!problem || !p || !$<HTMLInputElement>("understand").checked;
}

/**
 * What the LP being locked is worth right now: its share of each pool reserve, the total in
 * XNT when one side is XNT (the other side valued at the pool's own price), and the pool share.
 */
function showValue(p: Position | undefined, amt: bigint | null) {
  const box = $("amountValue");
  if (!p || amt === null) { box.hidden = true; return; }
  const { pool, reserves, symbols } = p;
  const parts = reserves.map((r) => (amt * r) / pool.lpSupply) as [bigint, bigint];
  $("valueParts").textContent = parts.map((v, i) => `${fmt(v, pool.mintDecimals[i], 4)} ${symbols[i]}`).join(" + ");
  const x = pool.mints.findIndex((m) => m.equals(NATIVE_MINT));
  // Both halves of a constant-product position are worth the same at the pool price.
  $("valueTotal").textContent = x >= 0 ? `≈ ${fmt(parts[x] * 2n, pool.mintDecimals[x], 4)} XNT` : `≈ ${fmt(parts[0], pool.mintDecimals[0], 4)} ${symbols[0]} ×2`;
  const share = Number((amt * 1_000_000n) / pool.lpSupply) / 10_000;
  $("valueShare").textContent = `${share}% of the pool · ${fmt(amt, pool.lpDecimals)} of your ${fmt(p.held, pool.lpDecimals)} LP · at the current pool price`;
  box.hidden = false;
}

/**
 * The live card this vault's key will show, rendered by the server exactly as wallets will see
 * it (the same renderer as /api/key/<nft>.png). Debounced; the time is rounded to the minute so
 * small edits reuse the cached image.
 */
let previewTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePreview(pool: string, amt: bigint, unlockAt: number) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const q = new URLSearchParams({ pool, lp: amt.toString(), unlockAt: String(Math.floor(unlockAt / 60) * 60) });
    if (network === "testnet") q.set("network", "testnet");
    $<HTMLImageElement>("artPreview").src = `api/key/preview.png?${q}`;
  }, 400);
}

$<HTMLInputElement>("artFile").onchange = async () => {
  const f = $<HTMLInputElement>("artFile").files?.[0];
  if (!f) return;
  if (f.size > MAX_IMAGE_BYTES) { setStatus("lockStatus", "That image is over 500 KB.", "err"); return; }
  customImage = new Uint8Array(await f.arrayBuffer());
  const img = $<HTMLImageElement>("artImg");
  img.src = URL.createObjectURL(f);
  img.hidden = false;
  $("artPreview").hidden = true;
  $("artReset").hidden = false;
  $("artNote").textContent = "Your image, pinned to IPFS and fixed for good (it won't show live numbers).";
};
$("artReset").onclick = () => {
  customImage = null;
  $("artImg").hidden = true;
  $("artPreview").hidden = false;
  $("artReset").hidden = true;
  $("artNote").textContent = LIVE_NOTE;
  $<HTMLInputElement>("artFile").value = "";
  refreshPreview();
};

const LIVE_NOTE = "A live card: it always shows this vault's current LP, pool share, token amounts and maturity.";

let busy = false;
$<HTMLFormElement>("lockForm").onsubmit = async (e) => {
  e.preventDefault();
  const p = current(), amt = lpAmount();
  if (!p || !amt || !wallet.address) return;
  busy = true;
  $<HTMLButtonElement>("lockBtn").disabled = true;
  const step = (s: string) => setStatus("lockStatus", s);
  try {
    const nft = Keypair.generate();
    const name = $<HTMLInputElement>("nftName").value.trim(), symbol = $<HTMLInputElement>("nftSymbol").value.trim();
    // The live card by default: the NFT points at this site's /api/key/<nft>.json. A custom
    // image is pinned to IPFS instead and stays fixed.
    let uri = `${location.origin}/api/key/${nft.publicKey.toBase58()}.json${network === "testnet" ? "?network=testnet" : ""}`;
    if (customImage) {
      step("Pinning your vault key image to IPFS…");
      const image = customImage;
      if (image.length > MAX_IMAGE_BYTES) throw new Error(`The NFT image is ${Math.ceil(image.length / 1000)} KB; the limit is 500 KB.`);
      let b64 = "";
      for (let i = 0; i < image.length; i += 0x8000) b64 += String.fromCharCode(...image.subarray(i, i + 0x8000));
      const r = await fetch("api/pin", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          network, owner: wallet.address, pool: p.pool.address.toBase58(), nftMint: nft.publicKey.toBase58(),
          lpAmount: amt.toString(), durationSeconds: durationSeconds(), name, symbol, image: btoa(b64),
          siteUrl: location.origin + location.pathname,
        }),
      });
      const pinned = await r.json().catch(() => ({ error: `Upload failed (${r.status})` }));
      if (!r.ok) throw new Error(pinned.error ?? `Upload failed (${r.status})`);
      uri = pinned.uri;
    }
    if (new TextEncoder().encode(uri).length > 200) throw new Error("The metadata link is over Metaplex's 200-byte limit.");
    const b = await buildLockLp(conn, programId, xdex, new PublicKey(wallet.address), {
      pool: p.pool.address, amount: amt, durationSeconds: durationSeconds(), name, symbol, uri, nftMint: nft,
    });
    const sig = await signAndSend(b.ixs, b.signers, step);
    const s = $("lockStatus");
    s.className = "status ok";
    s.replaceChildren(`Vault sealed. Your vault key: `, link(`?network=${network}&nft=${nft.publicKey.toBase58()}`, short(nft.publicKey)), " · ",
      link(`${EXPLORER[network]}/tx/${sig}`, "transaction"));
    $<HTMLInputElement>("understand").checked = false;
    await Promise.all([loadPositions(), loadMine(), loadStats()]);
  } catch (err) {
    setStatus("lockStatus", errorText(err), "err");
  } finally {
    busy = false;
    refreshPreview();
  }
};

// ---------- locks ----------
async function lockCard(lock: Lock, viewer: string | null) {
  const q = await quoteRewards(conn, programId, xdex, lock);
  const { pool } = q.state;
  const [labels, holder, md] = await Promise.all([
    Promise.all(pool.mints.map((m) => tokenLabel(conn, m))), nftHolder(conn, lock.nftMint), nftMetadata(conn, lock.nftMint),
  ]);
  const pair = `${labels[0].symbol}/${labels[1].symbol}`;
  const now = Date.now() / 1000;
  const ended = lock.unlockAt <= now;
  const amounts = (v: [bigint, bigint]) => v.map((x, i) => `${fmt(x, pool.mintDecimals[i])} ${labels[i].symbol}`).join(" + ");
  const isHolder = !!viewer && !!holder && holder.owner.toBase58() === viewer;

  const img = el("div", { class: "ph" });
  const safeUrl = isLocal ? /^https?:\/\// : /^https:\/\//; // plain http only for a local test gateway
  if (md?.uri && safeUrl.test(md.uri)) {
    fetch(md.uri).then((r) => r.json()).then((j) => {
      if (typeof j?.image === "string" && safeUrl.test(j.image)) img.replaceWith(el("img", { src: j.image, alt: md.name }));
    }).catch(() => {});
  }
  const status = el("div", { class: "status" });
  const actions = el("div", { class: "actions" });
  const total = Math.max(1, lock.unlockAt - lock.lockedAt);
  const pct = Math.min(100, Math.max(0, ((now - lock.lockedAt) / total) * 100));
  const bar = el("div", { class: "term-bar" }, el("i", { style: `width:${pct.toFixed(1)}%` }));
  const card = el("div", { class: "lock" }, img, el("div", {},
    el("h3", {}, md?.name || `${pair} LP Vault`,
      el("span", { class: `badge ${ended ? "open" : "sealed"}` }, ended ? "Matured" : `Sealed · ${countdown(lock.unlockAt)}`)),
    bar,
    el("div", { class: "term-meta" }, el("span", {}, `Opened ${new Date(lock.lockedAt * 1000).toLocaleDateString()}`),
      el("span", { title: when(lock.unlockAt) }, `${ended ? "Matured" : "Matures"} ${new Date(lock.unlockAt * 1000).toLocaleDateString()}`)),
    el("dl", {},
      el("dt", {}, "Deposit"), el("dd", {}, `${fmt(q.lpInVault, pool.lpDecimals)} LP · ${Number((q.lpInVault * 1_000_000n) / pool.lpSupply) / 10_000}% of pool`),
      el("dt", {}, "Value now"), el("dd", {}, `≈ ${amounts(q.lockedValue)}`),
      el("dt", {}, "Fees ready"), el("dd", { class: "fees" }, amounts(q.out)),
      el("dt", {}, "Key holder"), el("dd", {}, holder ? link(`${EXPLORER[network]}/address/${holder.owner.toBase58()}`, isHolder ? "you" : short(holder.owner)) : "—"),
      el("dt", {}, "Vault key"), el("dd", {}, link(`${EXPLORER[network]}/address/${lock.nftMint.toBase58()}`, short(lock.nftMint))),
      el("dt", {}, "Pool"), el("dd", {}, link(`${EXPLORER[network]}/address/${lock.pool.toBase58()}`, `${pair} · ${short(lock.pool)}`)),
    ),
    actions, status,
  ));
  if (isHolder) {
    const claimable = q.feeLp > 0n && q.out[0] > 0n && q.out[1] > 0n;
    const claim = el("button", { class: "btn gold" }, "Claim rewards") as HTMLButtonElement;
    claim.disabled = !claimable;
    claim.title = claimable ? "Send the trading fees earned so far to your wallet" : "No trading fees to claim yet";
    claim.onclick = () => act(status, [claim], async (step) => {
      const b = await buildClaimRewards(conn, programId, xdex, new PublicKey(viewer!), lock.nftMint);
      if (!b.ixs) throw new Error("Nothing to claim yet.");
      return signAndSend(b.ixs, [], step);
    }, `Claimed ${amounts(q.out)}.`);
    const withdraw = el("button", { class: "btn" }, "Withdraw LP") as HTMLButtonElement;
    withdraw.disabled = !ended;
    withdraw.title = ended ? "Returns all the LP to you and burns the vault key" : `Available at maturity, ${when(lock.unlockAt)}`;
    withdraw.onclick = () => {
      if (!confirm("Withdraw: all the LP (and any unclaimed fees in it) comes back to your wallet, and this vault key NFT is burned. Continue?")) return;
      void act(status, [claim, withdraw], async (step) => {
        const b = await buildUnlock(conn, programId, new PublicKey(viewer!), lock.nftMint);
        return signAndSend(b.ixs, [], step);
      }, "Withdrawn: the LP is back in your wallet.");
    };
    actions.append(claim, withdraw);
  }
  return card;
}

async function act(status: HTMLElement, buttons: HTMLButtonElement[], run: (step: (s: string) => void) => Promise<string>, done: string) {
  buttons.forEach((b) => (b.disabled = true));
  const step = (s: string) => { status.className = "status"; status.textContent = s; };
  try {
    const sig = await run(step);
    status.className = "status ok";
    status.replaceChildren(`${done} `, link(`${EXPLORER[network]}/tx/${sig}`, "transaction"));
    setTimeout(() => void Promise.all([loadMine(), loadPositions(), loadView(), loadStats()]), 1500);
  } catch (e) {
    status.className = "status err";
    status.textContent = errorText(e);
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function loadMine() {
  const box = $("mine");
  if (!wallet.address) { box.replaceChildren(el("p", { class: "empty" }, "Connect a wallet to see the vault keys it holds.")); return; }
  if (!box.querySelector(".lock")) box.replaceChildren(el("p", { class: "empty" }, "Opening the vault room…"));
  try {
    const locks = await locksHeldBy(conn, programId, new PublicKey(wallet.address));
    if (!locks.length) { box.replaceChildren(el("p", { class: "empty" }, `This wallet holds no vault keys on ${network}. Open a vault to get one.`)); return; }
    box.replaceChildren(...await Promise.all(locks.map((l) => lockCard(l, wallet.address))));
  } catch (e) {
    box.replaceChildren(el("p", { class: "err" }, `Couldn't open your vaults: ${errorText(e)}`));
  }
}

async function loadView() {
  const mint = params.get("nft");
  const sec = $("viewSection");
  if (!mint) { sec.hidden = true; return; }
  sec.hidden = false;
  const body = $("viewBody");
  try {
    const lock = await getLock(conn, programId, new PublicKey(mint));
    body.replaceChildren(lock ? await lockCard(lock, wallet.address)
      : el("p", { class: "empty" }, `No open vault for key ${mint} on ${network}. It was never a vault key here, or the LP has been withdrawn.`));
  } catch (e) {
    body.replaceChildren(el("p", { class: "err" }, errorText(e)));
  }
}

$<HTMLFormElement>("lookup").onsubmit = (e) => {
  e.preventDefault();
  const v = $<HTMLInputElement>("lookupNft").value.trim();
  try { new PublicKey(v); } catch { alert("That isn't a valid address."); return; }
  params.set("nft", v);
  history.pushState(null, "", `?${params}`);
  void loadView();
  $("viewSection").scrollIntoView({ behavior: "smooth" });
};
$("refresh").onclick = () => void loadMine();
$<HTMLSelectElement>("network").onchange = () => {
  setNetwork($<HTMLSelectElement>("network").value as Network);
  params.set("network", network);
  history.replaceState(null, "", `?${params}`);
  void refreshAll();
};

/** Hero stats: open vaults and how many pools they cover (one program-account scan). */
async function loadStats() {
  try {
    const all = await listLocks(conn, programId);
    $("statVaults").textContent = all.length.toLocaleString();
    $("statPools").textContent = new Set(all.map((l) => l.pool.toBase58())).size.toLocaleString();
  } catch {
    $("statVaults").textContent = $("statPools").textContent = "—";
  }
}

async function refreshAll() {
  renderConnect();
  // Warn early if this site's program isn't deployed on the chosen network.
  conn.getAccountInfo(programId).then((info) => notice(info?.executable ? null
    : `The vault program isn't deployed on X1 ${network} yet (${programId.toBase58()}). You can look around, but deposits won't work.`)).catch(() => {});
  await Promise.all([loadPositions(), loadMine(), loadView(), loadStats()]);
}

// ---------- start ----------
setNetwork(network);
let lastAddress: string | null = null;
onWalletChange(() => {
  renderConnect();
  if (wallet.address !== lastAddress) { lastAddress = wallet.address; void refreshAll(); }
});
void refreshAll();
// Keep countdowns moving on unlock-day without hammering the RPC.
setInterval(() => { if (!busy && document.visibilityState === "visible") void Promise.all([loadMine(), loadView()]); }, 60_000);
