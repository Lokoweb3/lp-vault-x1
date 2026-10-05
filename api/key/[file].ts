// Vercel function: live vault key image + metadata at /api/key/<nft>.png|json (see server/key-route.ts).
import { keyResponse } from "../../server/key-route.js";

export async function GET(req: Request) {
  return keyResponse(req);
}
