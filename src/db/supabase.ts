import { createClient } from "@supabase/supabase-js";
import { config } from "../config";

// Service-role client: bypasses RLS, so this file must only ever be imported
// on the backend, never shipped to the frontend bundle.
export const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false },
});
