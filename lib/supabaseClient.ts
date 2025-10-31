import { createClient } from "@supabase/supabase-js";

export const supabase =
  (globalThis as any).supabase ??
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

// keep a singleton in dev to avoid multiple clients
if (process.env.NODE_ENV !== "production") {
  (globalThis as any).supabase = supabase;
}
