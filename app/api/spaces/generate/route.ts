import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { generatePrivateCode } from "@/src/lib/server-code";
import { enforceRateLimit, isUniqueViolation, jsonError, jsonNoStore, readJsonBody } from "@/src/lib/http";
import { getSupabase } from "@/src/lib/supabase";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (!(await enforceRateLimit(request, "generate", 5, 60))) {
      return jsonError("Too many private numbers requested. Try again shortly.", 429);
    }
    const body = await readJsonBody(request, 2048);
    if (!body.ok) return jsonError(body.tooLarge ? "Request is too large." : "Request is invalid.", body.tooLarge ? 413 : 400);
    const parsed = z.object({ idempotencyKey: z.string().uuid() }).safeParse(body.value);
    if (!parsed.success) return jsonError("Request is invalid.", 400);

    const supabase = getSupabase();
    const requestHash = createHash("sha256").update(parsed.data.idempotencyKey).digest("hex");
    const { error: requestError } = await supabase
      .from("private_generation_requests")
      .insert({ request_hash: requestHash });
    if (isUniqueViolation(requestError)) {
      return jsonError("This request was already processed. Generate a fresh request to continue.", 409);
    }
    if (requestError) return jsonError("A private space could not be created. Please try again.", 503);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generatePrivateCode();
      const managementCredential = randomBytes(32).toString("base64url");
      const managementHash = createHash("sha256").update(managementCredential).digest("hex");
      const { data: space, error } = await supabase.from("spaces").insert({
        code,
        visibility: "private",
        management_key_hash: managementHash,
      }).select("id").single();

      if (isUniqueViolation(error)) continue;
      if (error || !space) {
        await supabase.from("private_generation_requests").delete().eq("request_hash", requestHash);
        return jsonError("A private space could not be created. Please try again.", 503);
      }

      const { error: linkError } = await supabase
        .from("private_generation_requests")
        .update({ space_id: space.id })
        .eq("request_hash", requestHash);
      if (linkError) {
        await supabase.from("spaces").delete().eq("id", space.id);
        await supabase.from("private_generation_requests").delete().eq("request_hash", requestHash);
        return jsonError("A private space could not be created. Please try again.", 503);
      }

      return jsonNoStore({ code, managementCredential }, 201);
    }

    await supabase.from("private_generation_requests").delete().eq("request_hash", requestHash);
    return jsonError("A unique private number could not be reserved. Please try again.", 503);
  } catch {
    return jsonError("The service is temporarily unavailable. Please try again.", 503);
  }
}
