/**
 * A small in-memory stand-in for the parts of supabase-js the app uses, for tests only.
 * Supports: from().select/insert/update/delete with eq/neq/is/gt/gte/lt/in/order/limit/single/maybeSingle,
 * count/head, and the unique constraints the app relies on (returned as Postgres error 23505).
 * Database rules themselves (checks, triggers, RLS) are tested against real Postgres separately.
 */
const crypto = require('crypto');

const UNIQUE = {
  br_registrants: [['email']],
  br_registrations: [['registrant_id'], ['registration_number']],
  br_admin_users: [['email']],
  br_training_progress: [['registrant_id', 'module_id']],
  br_subscriptions: [['stripe_subscription_id']],
  br_payments: [['stripe_invoice_id']],
  br_stripe_events: [['id']],
  br_settings: [['key']],
  br_job_runs: [['job', 'run_date']],
  br_email_templates: [['key']],
  br_curriculum_versions: [['label']],
  br_job_titles: [['label']],
  br_financing_products: [['label']],
  br_email_messages: [['dedupe_key']],
  br_duplicate_flags: [['registrant_id', 'matched_registrant_id', 'match_reason']],
  br_registrant_products: [['registrant_id', 'product_id']],
  br_registrant_states: [['registrant_id', 'state']],
};

const DEFAULTS = {
  br_registrants: { account_status: 'active', is_test: false },
  br_registrations: { status: 'pending', admin_hold: false },
  br_login_codes: { attempts: 0, used_at: null, purpose: 'sign_in' },
  br_email_messages: { status: 'queued', attempts: 0 },
  br_duplicate_flags: { status: 'open' },
  br_employment_relationships: { is_current: true },
  br_admin_users: { active: true },
  br_support_requests: { status: 'open' },
  br_curriculum_versions: { status: 'draft', is_required: false, overview_md: '', completion_md: '' },
  br_questions: { active: true, position: 0 },
  br_modules: { body_md: '' },
  br_admin_login_codes: { attempts: 0, used_at: null },
  br_job_titles: { active: true, position: 0 },
  br_financing_products: { active: true, position: 0 },
};

// Tables whose ids are integers (identity columns) in the real schema.
const INT_IDS = new Set(['br_events', 'br_legal_acceptances', 'br_admin_audit_log', 'br_registration_status_history',
  'br_job_titles', 'br_financing_products', 'br_postmark_events', 'br_verify_lookups', 'br_job_runs', 'br_assessment_resets']);

function likeMatch(value, pattern) {
  if (value == null) return false;
  const re = new RegExp(`^${pattern.split('%').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(String(value));
}

function createFake(seed = {}) {
  const tables = {};
  let serial = 1;
  const t = name => (tables[name] ||= []);
  for (const [name, rows] of Object.entries(seed)) for (const r of rows) t(name).push({ ...r });

  const now = () => new Date().toISOString();
  const withDefaults = (table, row) => ({
    id: INT_IDS.has(table) ? Math.max(serial++, ...t(table).map(r => (typeof r.id === 'number' ? r.id + 1 : 0))) : crypto.randomUUID(),
    created_at: now(), updated_at: now(),
    // Timestamp columns the real schema fills with now().
    ...(['br_assessment_attempts', 'br_training_progress'].includes(table) ? { started_at: now() } : {}),
    ...(table === 'br_legal_acceptances' ? { accepted_at: now() } : {}),
    ...(table === 'br_stripe_events' || table === 'br_postmark_events' ? { received_at: now() } : {}),
    ...(DEFAULTS[table] || {}), ...row,
  });

  const violates = (table, row, ignore) => (UNIQUE[table] || []).some(cols =>
    cols.every(c => row[c] != null) && t(table).some(o => o !== ignore && cols.every(c => o[c] === row[c])));

  function query(table) {
    const q = { table, op: 'select', filters: [], orders: [], limitN: null, mode: 'many', count: null, head: false, payload: null, returning: false };
    const api = {
      select(cols, opts = {}) {
        if (q.op === 'select') { q.count = opts.count || null; q.head = Boolean(opts.head); } else q.returning = true;
        return api;
      },
      insert(rows) { q.op = 'insert'; q.payload = Array.isArray(rows) ? rows : [rows]; return api; },
      update(obj) { q.op = 'update'; q.payload = obj; return api; },
      delete() { q.op = 'delete'; return api; },
      eq(c, v) { q.filters.push(r => r[c] === v); return api; },
      neq(c, v) { q.filters.push(r => r[c] !== v); return api; },
      is(c, v) { q.filters.push(r => (r[c] ?? null) === v); return api; },
      gt(c, v) { q.filters.push(r => r[c] != null && r[c] > v); return api; },
      gte(c, v) { q.filters.push(r => r[c] != null && r[c] >= v); return api; },
      lt(c, v) { q.filters.push(r => r[c] != null && r[c] < v); return api; },
      lte(c, v) { q.filters.push(r => r[c] != null && r[c] <= v); return api; },
      not(c, op, v) {
        if (op === 'is') q.filters.push(r => (r[c] ?? null) !== v);
        else if (op === 'eq') q.filters.push(r => r[c] !== v);
        else throw new Error(`fake not(): unsupported ${op}`);
        return api;
      },
      range(from, to) { q.rangeFrom = from; q.rangeTo = to; return api; },
      in(c, vs) { q.filters.push(r => vs.includes(r[c])); return api; },
      ilike(c, pattern) { q.filters.push(r => likeMatch(r[c], pattern)); return api; },
      // or('col.ilike.%x%,col.eq.y'): any one condition must match. Multiple or() calls are ANDed.
      or(expr) {
        const conds = expr.split(',').map(part => {
          const [col, op, ...rest] = part.split('.');
          const val = rest.join('.');
          if (op === 'ilike') return r => likeMatch(r[col], val);
          if (op === 'eq') return r => String(r[col]) === val;
          throw new Error(`fake or(): unsupported ${op}`);
        });
        q.filters.push(r => conds.some(f => f(r)));
        return api;
      },
      order(c, { ascending = true } = {}) { q.orders.push([c, ascending]); return api; },
      limit(n) { q.limitN = n; return api; },
      single() { q.mode = 'single'; return api; },
      maybeSingle() { q.mode = 'maybe'; return api; },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
    };

    function shape(rows) {
      if (q.mode === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: `expected 1 row, got ${rows.length}` } };
      if (q.mode === 'maybe') return rows.length > 1 ? { data: null, error: { message: 'multiple rows' } } : { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    }

    function run() {
      const rows = t(table);
      const match = r => q.filters.every(f => f(r));
      if (q.op === 'insert') {
        const added = [];
        for (const raw of q.payload) {
          const row = withDefaults(table, raw);
          if (violates(table, row) || added.some(a => (UNIQUE[table] || []).some(cols => cols.every(c => a[c] === row[c] && row[c] != null)))) {
            return { data: null, error: { code: '23505', message: `duplicate key on ${table}` } };
          }
          added.push(row);
        }
        rows.push(...added);
        return q.returning ? shape(added.map(r => ({ ...r }))) : { data: null, error: null };
      }
      if (q.op === 'update') {
        const hit = rows.filter(match);
        for (const r of hit) {
          const next = { ...r, ...q.payload, updated_at: now() };
          if (violates(table, next, r)) return { data: null, error: { code: '23505', message: `duplicate key on ${table}` } };
          Object.assign(r, next);
        }
        return q.returning ? shape(hit.map(r => ({ ...r }))) : { data: null, error: null };
      }
      if (q.op === 'delete') {
        tables[table] = rows.filter(r => !match(r));
        return { data: null, error: null };
      }
      let out = rows.filter(match).map(r => ({ ...r }));
      for (const [c, asc] of [...q.orders].reverse()) {
        out.sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (asc ? 1 : -1)));
      }
      const count = out.length;
      if (q.rangeFrom != null) out = out.slice(q.rangeFrom, q.rangeTo + 1);
      if (q.limitN != null) out = out.slice(0, q.limitN);
      if (q.head) return { data: null, count, error: null };
      return { ...shape(out), count: q.count ? count : null };
    }
    return api;
  }

  // The two database functions the app calls, mirroring the SQL versions.
  async function rpc(name, p) {
    const reg = t('br_registrations').find(r => r.id === p.p_registration_id);
    if (!reg) return { data: null, error: { message: 'Registration not found' } };
    if (name === 'br_assign_registration_number') {
      if (!reg.registration_number) {
        let n;
        do { n = `BR-${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`; } while (t('br_registrations').some(r => r.registration_number === n));
        reg.registration_number = n;
      }
      return { data: reg.registration_number, error: null };
    }
    if (name === 'br_set_registration_status') {
      if (reg.status === p.p_to_status) return { data: null, error: null };
      if (p.p_to_status !== 'pending' && !reg.registration_number) return { data: null, error: { message: 'number required' } };
      t('br_registration_status_history').push({ id: serial++, registration_id: reg.id, from_status: reg.status, to_status: p.p_to_status,
        reason: p.p_reason, actor_type: p.p_actor_type, actor_id: p.p_actor_id, source_ref: p.p_source_ref, created_at: now() });
      reg.status = p.p_to_status;
      return { data: null, error: null };
    }
    return { data: null, error: { message: `rpc ${name} not supported in fake` } };
  }

  return { from: query, tables, rpc };
}

module.exports = { createFake };
