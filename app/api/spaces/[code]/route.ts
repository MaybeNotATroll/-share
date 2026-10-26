import { spaceCodeSchema, getVisibility } from "@/src/lib/code";
import { enforceRateLimit, getSpace, jsonError, jsonNoStore } from "@/src/lib/http";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await context.params;
    if (!spaceCodeSchema.safeParse(code).success) return jsonError("Enter a valid code.", 400);
    if (!(await enforceRateLimit(request, "open", 120, 60))) {
      return jsonError("Too many requests. Try again shortly.", 429);
    }

    const space = await getSpace(code, getVisibility(code) === "public");
    if (!space) return jsonError("This space is unavailable.", 404);
    return jsonNoStore({
      space: {
        code: space.code,
        visibility: space.visibility,
        createdAt: space.created_at,
      },
    });
  } catch {
    return jsonError("The service is temporarily unavailable. Please try again.", 503);
  }
}
