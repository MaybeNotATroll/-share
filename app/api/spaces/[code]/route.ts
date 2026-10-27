import { spaceCodeSchema } from "@/src/lib/validation";
import { enforceRateLimit, jsonError, jsonNoStore, resolveSpace } from "@/src/lib/http";

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

    const { space, rateLimited } = await resolveSpace(request, code);
    if (rateLimited) return jsonError("Too many new spaces requested. Try again later.", 429);
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
