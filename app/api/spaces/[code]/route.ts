import { spaceCodeSchema } from "@/src/lib/validation";
import { enforceRateLimit, getSpace, jsonError, jsonNoStore, serviceError } from "@/src/lib/http";

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

    // Every valid number has its own private space. A database row is only created
    // when the first file is posted, so opening an unused number does not reserve it.
    const space = await getSpace(code, true);
    if (space?.blocked_at) return jsonError("This space is unavailable.", 404);
    return jsonNoStore({ space: { code, createdAt: space?.created_at ?? null } });
  } catch (error) {
    return serviceError(error);
  }
}
