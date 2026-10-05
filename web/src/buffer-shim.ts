// esbuild injects this wherever code uses the Node `Buffer` global (web3.js, spl-token, our client).
export { Buffer } from "buffer";
