/**
 * Live vault key images: a 500x500 PNG drawn on request from on-chain data (LP in the vault,
 * pool reserves, maturity), so a vault key's picture follows its pool. The card is built as
 * SVG and rasterised with resvg, using the fonts bundled in assets/fonts (a serverless
 * function has no system fonts). PNG because every wallet shows it.
 *
 * Layouts: the default vault door, or a one-of-one design selected by POOL ADDRESS (never by
 * token name, which anyone can copy). Both show the same live fields: pair, LP amount, % of
 * pool, ≈ token amounts (4 decimals), maturity date and footer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { Resvg } from "@resvg/resvg-js";
import { Network, Pool, readPool } from "../client/xdex.js";
import { Lock, getLock, vaultLp } from "../client/lp-lock-nft.js";
import { tokenLabel } from "../client/tokens.js";

export const SIZE = 500;
/**
 * Asset files, each named literally relative to this module so Vercel's file tracer bundles
 * them with the function (a computed path would be missed and fail at runtime).
 */
const loadFonts = () => ({
  "IBMPlexSans-Bold.ttf": fs.readFileSync(new URL("../assets/fonts/IBMPlexSans-Bold.ttf", import.meta.url)),
  "IBMPlexSans-SemiBold.ttf": fs.readFileSync(new URL("../assets/fonts/IBMPlexSans-SemiBold.ttf", import.meta.url)),
  "IBMPlexMono-Medium.ttf": fs.readFileSync(new URL("../assets/fonts/IBMPlexMono-Medium.ttf", import.meta.url)),
  "IBMPlexMono-SemiBold.ttf": fs.readFileSync(new URL("../assets/fonts/IBMPlexMono-SemiBold.ttf", import.meta.url)),
});
const MASCOTS: Record<string, URL> = {
  "test-mascot-standin.png": new URL("../assets/test-mascot-standin.png", import.meta.url),
};

/** One-of-one layouts, keyed by XDEX pool address. */
export const ONE_OF_ONE: Record<string, { title: string; mascot: string; background: string }> = {
  // USDC.X/Test, mainnet. Stand-in mascot cut from the vault's uploaded art until the clean PNG arrives.
  "7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD": { title: "TEST", mascot: "test-mascot-standin.png", background: "#12161c" },
};

export interface CardData {
  pool: string;
  pair: string;
  lpAmount: string;
  sharePct: string;
  /** "≈ 1.2345 USDC.X + 6,789.0123 Test" */
  amounts: string;
  unlockAt: number;
  network: Network;
}

// ---------- data ----------

/** Fixed 4 decimals (truncated), thousands separators. */
export function fmt4(v: bigint, decimals: number) {
  const scaled = decimals >= 4 ? v / 10n ** BigInt(decimals - 4) : v * 10n ** BigInt(4 - decimals);
  if (scaled === 0n && v > 0n) return "<0.0001";
  const whole = scaled / 10_000n, frac = (scaled % 10_000n).toString().padStart(4, "0");
  return `${whole.toLocaleString("en-US")}.${frac}`;
}
function fmtLp(v: bigint, decimals: number) {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = BigInt(s.slice(0, s.length - decimals) || "0").toLocaleString("en-US");
  const frac = decimals ? s.slice(-decimals).slice(0, 4).replace(/0+$/, "") : "";
  if (whole === "0" && !frac && v > 0n) return "<0.0001";
  return frac ? `${whole}.${frac}` : whole;
}

async function describe(conn: Connection, pool: Pool, reserves: [bigint, bigint], lp: bigint, unlockAt: number, network: Network): Promise<CardData> {
  const [a, b] = await Promise.all(pool.mints.map((m) => tokenLabel(conn, m)));
  const parts = reserves.map((r) => (lp * r) / pool.lpSupply);
  const share = pool.lpSupply > 0n ? Number((lp * 1_000_000n) / pool.lpSupply) / 10_000 : 0;
  const sharePct = share === 0 && lp > 0n ? "<0.0001%" : `${share}%`;
  return {
    pool: pool.address.toBase58(), pair: `${a.symbol}/${b.symbol}`, lpAmount: fmtLp(lp, pool.lpDecimals), sharePct,
    amounts: `≈ ${fmt4(parts[0], pool.mintDecimals[0])} ${a.symbol} + ${fmt4(parts[1], pool.mintDecimals[1])} ${b.symbol}`,
    unlockAt, network,
  };
}

/** Live data for an open vault, or null if the key's vault doesn't exist (never made, or withdrawn). */
export async function vaultCardData(conn: Connection, programId: PublicKey, xdex: PublicKey, nftMint: PublicKey, network: Network) {
  const lock: Lock | null = await getLock(conn, programId, nftMint);
  if (!lock) return null;
  const [{ pool, reserves }, lp] = await Promise.all([readPool(conn, xdex, lock.pool), vaultLp(conn, programId, lock.address)]);
  return { lock, card: await describe(conn, pool, reserves, lp, lock.unlockAt, network) };
}

/** What a vault about to be opened will look like (the form's preview). */
export async function previewCardData(conn: Connection, xdex: PublicKey, poolAddr: PublicKey, lp: bigint, unlockAt: number, network: Network) {
  const { pool, reserves } = await readPool(conn, xdex, poolAddr);
  return describe(conn, pool, reserves, lp, unlockAt, network);
}

// ---------- drawing ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const SANS = "IBM Plex Sans";
const MONO = "IBM Plex Mono";
/** Font size that fits `text` in `width` (Plex Mono advances 0.6 em; Plex Sans bold about 0.62 em on average). */
const fitSize = (text: string, width: number, max: number, em = 0.6) => Math.min(max, Math.floor(width / (Math.max(1, [...text].length) * em)));
const date = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase();

function brassDefs() {
  return `<defs>
    <linearGradient id="brass" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${SIZE}" y2="${SIZE}"><stop offset="0" stop-color="#f6d891"/><stop offset=".5" stop-color="#c9973d"/><stop offset="1" stop-color="#7d5a1b"/></linearGradient>
    <radialGradient id="steel" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#46525f"/><stop offset=".6" stop-color="#1f2731"/><stop offset="1" stop-color="#11161c"/></radialGradient>
    <radialGradient id="glow" cx="45%" cy="35%" r="80%"><stop offset="0" stop-color="#1f2833"/><stop offset="1" stop-color="#07090c"/></radialGradient>
  </defs>`;
}

/** Vault door centred at (cx, cy) with radius r. */
function door(cx: number, cy: number, r: number) {
  const bolts = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    return `<circle cx="${(cx + Math.cos(a) * r * 0.86).toFixed(1)}" cy="${(cy + Math.sin(a) * r * 0.86).toFixed(1)}" r="${(r * 0.047).toFixed(1)}" fill="url(#brass)"/>`;
  }).join("");
  const dial = r * 0.48;
  const ticks = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2, r1 = dial * (i % 2 ? 0.85 : 0.76), r2 = dial * 0.93;
    return `<line x1="${(cx + Math.cos(a) * r1).toFixed(1)}" y1="${(cy + Math.sin(a) * r1).toFixed(1)}" x2="${(cx + Math.cos(a) * r2).toFixed(1)}" y2="${(cy + Math.sin(a) * r2).toFixed(1)}" stroke="url(#brass)" stroke-width="${(r * 0.02).toFixed(1)}" stroke-linecap="round"/>`;
  }).join("");
  const spokes = [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6].map((a) =>
    `<line x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(a) * dial * 0.67).toFixed(1)}" y2="${(cy + Math.sin(a) * dial * 0.67).toFixed(1)}" stroke="url(#brass)" stroke-width="${(r * 0.085).toFixed(1)}" stroke-linecap="round"/>`).join("");
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#steel)" stroke="url(#brass)" stroke-width="${(r * 0.065).toFixed(1)}"/>${bolts}
    <circle cx="${cx}" cy="${cy}" r="${(r * 0.67).toFixed(1)}" fill="none" stroke="#2c3642" stroke-width="${(r * 0.085).toFixed(1)}"/>
    <circle cx="${cx}" cy="${cy}" r="${dial.toFixed(1)}" fill="#141a22" stroke="url(#brass)" stroke-width="${(r * 0.032).toFixed(1)}"/>${ticks}${spokes}
    <circle cx="${cx}" cy="${cy}" r="${(r * 0.126).toFixed(1)}" fill="url(#brass)"/>`;
}

/** Shared live-data block: pair line, LP/share, amounts, maturity plate and footer, from y0 down. */
function dataBlock(c: CardData, y0: number, opts: { pairSize: number; showPair: boolean }) {
  const now = Date.now() / 1000;
  const lpLine = `${c.lpAmount} LP · ${c.sharePct} of pool`;
  const plate = `${now >= c.unlockAt ? "MATURED" : "MATURES"} ${date(c.unlockAt)}`;
  const plateSize = 14, plateW = [...plate].length * plateSize * 0.6 + 36;
  let y = y0, out = "";
  if (opts.showPair) {
    out += `<text x="250" y="${y}" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="${fitSize(c.pair, 440, opts.pairSize, 0.62)}" fill="#f2f5f8">${esc(c.pair)}</text>`;
    y += 30;
  }
  out += `<text x="250" y="${y}" text-anchor="middle" font-family="${MONO}" font-weight="500" font-size="${fitSize(lpLine, 450, 15)}" fill="#d9dfe6">${esc(lpLine)}</text>`;
  y += 22;
  out += `<text x="250" y="${y}" text-anchor="middle" font-family="${MONO}" font-weight="500" font-size="${fitSize(c.amounts, 460, 13)}" fill="#8d9bab">${esc(c.amounts)}</text>`;
  y += 18;
  out += `<rect x="${(250 - plateW / 2).toFixed(1)}" y="${y}" width="${plateW.toFixed(1)}" height="28" rx="14" fill="url(#brass)"/>
    <text x="250" y="${y + 19}" text-anchor="middle" font-family="${MONO}" font-weight="600" font-size="${plateSize}" fill="#1a1305">${esc(plate)}</text>`;
  out += `<text x="250" y="482" text-anchor="middle" font-family="${MONO}" font-weight="500" font-size="10" letter-spacing="3" fill="#5f6d7d">${esc(`VAULT KEY · XDEX LP · X1 ${c.network.toUpperCase()}`)}</text>`;
  return out;
}

function defaultSvg(c: CardData) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${brassDefs()}
    <rect width="${SIZE}" height="${SIZE}" fill="url(#glow)"/>
    ${door(250, 160, 118)}
    <text x="250" y="320" text-anchor="middle" font-family="${MONO}" font-weight="600" font-size="13" letter-spacing="7" fill="#d4a94f">VAULT KEY</text>
    ${dataBlock(c, 358, { pairSize: 38, showPair: true })}
  </svg>`;
}

function oneOfOneSvg(c: CardData, o: (typeof ONE_OF_ONE)[string]) {
  const mascot = fs.readFileSync(fileURLToPath(MASCOTS[o.mascot]));
  const href = `data:image/png;base64,${mascot.toString("base64")}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${brassDefs()}
    <rect width="${SIZE}" height="${SIZE}" fill="${o.background}"/>
    <image x="22" y="40" width="200" height="224" preserveAspectRatio="xMidYMid meet" href="${href}" xlink:href="${href}"/>
    ${door(360, 152, 108)}
    <text x="250" y="322" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="${fitSize(o.title, 420, 54, 0.66)}" letter-spacing="10" fill="url(#brass)">${esc(o.title)}</text>
    <text x="250" y="346" text-anchor="middle" font-family="${MONO}" font-weight="600" font-size="13" fill="#e8edf3">${esc(c.pair)}</text>
    ${dataBlock(c, 370, { pairSize: 0, showPair: false })}
  </svg>`;
}

export function cardSvg(c: CardData) {
  const o = ONE_OF_ONE[c.pool];
  return o ? oneOfOneSvg(c, o) : defaultSvg(c);
}

/**
 * resvg only loads fonts from file paths, so the bundled fonts are copied once into the
 * function's temp folder. Throws if any is missing: a card without text must never be served
 * (resvg would silently draw it blank, and it would be cached).
 */
let fontPaths: string[] | null = null;
function fonts() {
  if (fontPaths) return fontPaths;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-fonts-"));
  fontPaths = Object.entries(loadFonts()).map(([name, bytes]) => {
    if (!bytes.length) throw new Error(`Font ${name} is empty`);
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes);
    return p;
  });
  return fontPaths;
}

export function renderPng(svg: string) {
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: SIZE },
    font: { fontFiles: fonts(), loadSystemFonts: false, defaultFontFamily: SANS },
  });
  return r.render().asPng();
}
