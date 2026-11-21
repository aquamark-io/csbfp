// Server-side only. The service-role key bypasses RLS and must never reach the browser.
const { createClient } = require('@supabase/supabase-js');

let client = null;
function db() {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

// Tests swap in a stand-in client.
db.set = c => { client = c; };

// Throws on a Supabase error so callers can't forget to check.
function must({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

module.exports = { db, must };
