// Vercel function: vault key art stored on X1 VAULT at /api/x1vault/<file>.<ext> (see server/x1vault.ts).
import { vaultArtResponse } from "../../server/x1vault.js";

export async function GET(req: Request) {
  return vaultArtResponse(req);
}
