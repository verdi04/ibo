import { createClient } from '@supabase/supabase-js';

let supabaseClient;

export function getSupabaseClient() {
  if (supabaseClient) {
    return supabaseClient;
  }

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  // RLS policies are restricted to service_role, so production must use it
  if (process.env.NODE_ENV === 'production' && !serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY must be configured in production because database access is server-only (RLS restricted to service_role).',
    );
  }

  const supabaseKey = serviceRoleKey || anonKey;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      'Supabase environment variables (NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY) are not configured.',
    );
  }

  supabaseClient = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return supabaseClient;
}

export const supabase = new Proxy(
  {},
  {
    get(_target, property) {
      const client = getSupabaseClient();
      const value = Reflect.get(client, property, client);

      return typeof value === 'function' ? value.bind(client) : value;
    },
  },
);
