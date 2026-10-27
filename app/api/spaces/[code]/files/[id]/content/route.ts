import { z } from "zod";
import { spaceCodeSchema } from "@/src/lib/validation";
import { managedContent } from "@/src/lib/managed-content";
import { readObjectStream } from "@/src/lib/storage";
import { getSupabase } from "@/src/lib/supabase";
import { enforceRateLimit, jsonError, serviceError } from "@/src/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string; id: string }> },
) {
  try {
    const { code, id } = await context.params;
    if (!spaceCodeSchema.safeParse(code).success || !z.string().uuid().safeParse(id).success) {
      return jsonError("This file is unavailable.", 404);
    }
    if (!(await enforceRateLimit(request, "content", 240, 60))) return jsonError("Too many requests.", 429);
    return await managedContent(request, code, id, getSupabase(), readObjectStream);
  } catch (error) {
    return serviceError(error);
  }
}
