import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { generatePrivateCode } from "@/src/lib/code";
import { enforceRateLimit, isUniqueViolation, jsonError, jsonNoStore } from "@/src/lib/http";
import { getSupabase } from "@/src/lib/supabase";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (!(await enforceRateLimit(request, "generate", 5, 60))) {
      return jsonError("Too many private numbers requested. Try again shortly.", 429);
    }

    const supabase = getSupabase();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generatePrivateCode();
      const managementCredential = randomBytes(32).toString("base64url");
      const managementHash = createHash("sha256").update(managementCredential).digest("hex");
      const { error } = await supabase.from("spaces").insert({
        code,
        visibility: "private",
        management_key_hash: managementHash,
      });

      if (isUniqueViolation(error)) continue;
      if (error) return jsonError("A private space could not be created. Please try again.", 503);

      return jsonNoStore({ code, managementCredential }, 201);
    }

    return jsonError("A unique private number could not be reserved. Please try again.", 503);
  } catch {
    return jsonError("The service is temporarily unavailable. Please try again.", 503);
  }
}
