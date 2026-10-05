// Bundles web/src/main.ts into web/public/app.js. Program ids come from the environment
// (LP_LOCK_PROGRAM_ID, or per network LP_LOCK_PROGRAM_ID_MAINNET / _TESTNET).
import * as esbuild from "esbuild";

const DEFAULT = "8N4E3ZHBiYRMia8Hs27J6f3b9QM8wiTYcMXukSq96Ejf";
const env = process.env;
const ids = {
  mainnet: env.LP_LOCK_PROGRAM_ID_MAINNET || env.LP_LOCK_PROGRAM_ID || DEFAULT,
  testnet: env.LP_LOCK_PROGRAM_ID_TESTNET || env.LP_LOCK_PROGRAM_ID || DEFAULT,
};
await esbuild.build({
  entryPoints: ["web/src/main.ts"],
  bundle: true,
  minify: !process.argv.includes("--dev"),
  sourcemap: process.argv.includes("--dev") ? "inline" : false,
  format: "iife",
  target: "es2020",
  platform: "browser",
  outfile: "web/public/app.js",
  inject: ["web/src/buffer-shim.ts"],
  define: { __PROGRAM_IDS__: JSON.stringify(ids), global: "globalThis", "process.env.NODE_DEBUG": "undefined" },
  logLevel: "warning",
});
console.log(`web/public/app.js built (mainnet ${ids.mainnet}, testnet ${ids.testnet})`);
