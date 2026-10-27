import { z } from "zod";
import { spaceCodeSchema } from "@/src/lib/validation";
import { enforceRateLimit, getSpace, jsonError, jsonNoStore, readJsonBody } from "@/src/lib/http";
import { getSupabase } from "@/src/lib/supabase";

export const runtime = "nodejs";

const reportSchema = z.object({
  code: spaceCodeSchema,
  fileId: z.string().uuid(),
  reason: z.enum(["illegal", "abuse", "copyright", "other"]),
});

export async function POST(request: Request) {
  try {
    if (!(await enforceRateLimit(request, "report", 5, 60))) {
      return jsonError("Too many reports. Try again shortly.", 429);
    }
    const body = await readJsonBody(request, 4096);
    if (!body.ok) return jsonError(body.tooLarge ? "Report details are too large." : "Report details are invalid.", body.tooLarge ? 413 : 400);
    const parsed = reportSchema.safeParse(body.value);
    if (!parsed.success) return jsonError("Report details are invalid.", 400);
    const { code, fileId, reason } = parsed.data;
    const space = await getSpace(code);
    if (!space) return jsonError("This space is unavailable.", 404);
    const supabase = getSupabase();
    const { data: file } = await supabase
      .from("files")
      .select("id")
      .eq("id", fileId)
      .eq("space_id", space.id)
      .eq("status", "ready")
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (!file) return jsonError("This file is unavailable.", 404);
    const { error } = await supabase.from("reports").insert({
      space_id: space.id,
      file_id: fileId,
      reason,
    });
    if (error) return jsonError("The report could not be submitted. Try again.", 503);
    return jsonNoStore({ reported: true }, 201);
  } catch {
    return jsonError("The service is temporarily unavailable. Please try again.", 503);
  }
}
