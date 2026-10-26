import { createClient } from "@supabase/supabase-js";

export function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("The storage service is not configured.");

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export const STORAGE_BUCKET = "share-files";
