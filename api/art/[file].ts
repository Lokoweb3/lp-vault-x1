// Vercel function: serves pinned NFT art + metadata at /api/art/<cid>.<ext> (see server/art.ts).
import { artResponse } from "../../server/art.js";

export async function GET(req: Request) {
  return artResponse(req);
}
