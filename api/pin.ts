// Vercel function: pins lock NFT art + metadata to IPFS with the server's Pinata key.
import { pinResponse, pinata } from "../server/pin.js";

export async function POST(req: Request) {
  return pinResponse(req, pinata());
}
