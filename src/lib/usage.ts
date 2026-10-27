import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function dailyUploadUsage(database: SupabaseClient, ipHash: string) {
  const { data, error } = await database.rpc("get_daily_upload_usage", { p_ip_hash: ipHash });
  if (error || !data || data.limitBytes !== 500_000_000 ||
    !Number.isSafeInteger(data.uploadedBytes) || data.uploadedBytes < 0 ||
    !Number.isSafeInteger(data.reservedBytes) || data.reservedBytes < 0 ||
    typeof data.resetAt !== "string" || !Number.isFinite(Date.parse(data.resetAt))) {
    throw new Error("Daily usage unavailable.");
  }
  return {
    uploadedBytes: data.uploadedBytes as number, reservedBytes: data.reservedBytes as number,
    limitBytes: 500_000_000, resetAt: data.resetAt as string,
  };
}
