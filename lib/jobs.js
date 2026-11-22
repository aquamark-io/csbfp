/**
 * The daily job. Checked every 15 minutes; runs once per Pacific-time day after 6 AM (csbfp_job_runs has a unique
 * (job, run_date), so it runs once even with several server instances). Every task is idempotent: emails are
 * deduplicated and status changes are no-ops when already applied, so running it again is harmless.
 *
 *   1. Expire registrations whose paid period ended and that won't renew (automatic renewal canceled / ended).
 *      If automatic renewal is on and the renewal looks overdue, re-check the subscription with Stripe instead.
 *   2. Renewal reminder 30 days before each automatic renewal.
 *   3. Payment-method reminder 3 days after a failed renewal that is still unpaid.
 *   4. Housekeeping: expired sign-in codes, lookup logs older than 90 days.
 */
const { db, must } = require('./supabase');
const billing = require('./billing');
const { stripe, blockedReason } = require('./stripe');
const { fmtDate, sendOnce } = require('./email');
const config = require('./config');

const DAY = 864e5;

function pacific(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

async function expireDue(now) {
  const due = must(await db().from('csbfp_registrations').select('*').eq('status', 'active').lte('expires_at', now.toISOString()), 'Due registrations');
  const out = { expired: 0, rechecked: 0, errors: 0 };
  for (const reg of due) {
    try {
      const live = await billing.liveSubscriptionOf(reg.registrant_id);
      if (!live || live.cancel_at_period_end) {
        await billing.expire(reg, live ? 'Registration period ended; automatic renewal was canceled' : 'Registration period ended without renewal', 'daily-job');
        out.expired += 1;
      } else if (Date.parse(reg.expires_at) < now.getTime() - 2 * DAY && !blockedReason()) {
        // Renewal should have happened by now; ask Stripe directly in case a webhook was missed.
        const sub = await stripe().subscriptions.retrieve(live.stripe_subscription_id, { expand: ['latest_invoice'] });
        await billing.syncSubscriptionAndActivate(sub, 'daily-job');
        const fresh = must(await db().from('csbfp_registrations').select('*').eq('id', reg.id).single(), 'Registration');
        const inv = sub.latest_invoice;
        if (fresh.status === 'active' && Date.parse(fresh.expires_at) <= now.getTime()) {
          if (['canceled', 'incomplete_expired'].includes(sub.status)) await billing.expire(fresh, 'Registration period ended without renewal', 'daily-job');
          else if (inv && typeof inv === 'object' && inv.status === 'open') {
            const { error } = await db().rpc('csbfp_set_registration_status', { p_registration_id: fresh.id, p_to_status: 'inactive', p_reason: 'Renewal payment failed', p_actor_type: 'system', p_actor_id: null, p_source_ref: 'daily-job' });
            if (error) throw new Error(error.message);
            await billing.notify(fresh, 'renewal_failed', `renewal_failed:${inv.id}`);
          }
        }
        out.rechecked += 1;
      }
    } catch (err) {
      out.errors += 1;
      console.error(`Daily job: registration ${reg.id}:`, err.message);
    }
  }
  return out;
}

async function renewalReminders(now) {
  const soon = must(await db().from('csbfp_registrations').select('*').eq('status', 'active')
    .gt('expires_at', now.toISOString()).lte('expires_at', new Date(now.getTime() + 30 * DAY).toISOString()), 'Upcoming renewals');
  let sent = 0;
  for (const reg of soon) {
    const live = await billing.liveSubscriptionOf(reg.registrant_id);
    if (!live || live.cancel_at_period_end) continue; // nothing will be charged
    await billing.notify(reg, 'renewal_reminder', `renewal_reminder:${reg.id}:${reg.expires_at}`, { renewal_date: fmtDate(reg.expires_at) });
    sent += 1;
  }
  return { checked: soon.length, reminded: sent };
}

// Employer-paid certifications don't renew automatically: 30 days before the paid year ends, ask for a card.
async function employerPaidReminders(now) {
  const soon = must(await db().from('csbfp_registrations').select('*').eq('status', 'active').not('paid_by_employer_id', 'is', null)
    .gt('expires_at', now.toISOString()).lte('expires_at', new Date(now.getTime() + 30 * DAY).toISOString()), 'Employer-paid renewals');
  let sent = 0;
  for (const reg of soon) {
    if (await billing.liveSubscriptionOf(reg.registrant_id)) continue; // card already on file
    await billing.notify(reg, 'renewal_add_card', `renewal_add_card:${reg.id}:${reg.expires_at}`, { end_date: fmtDate(reg.expires_at) });
    sent += 1;
  }
  return { reminded: sent };
}

async function paymentMethodReminders(now) {
  const failed = must(await db().from('csbfp_payments').select('*').eq('status', 'failed').eq('billing_reason', 'renewal')
    .lte('created_at', new Date(now.getTime() - 3 * DAY).toISOString()), 'Failed renewals');
  let sent = 0;
  for (const p of failed) {
    const reg = must(await db().from('csbfp_registrations').select('*').eq('id', p.registration_id).single(), 'Registration');
    if (reg.status !== 'inactive') continue;
    await billing.notify(reg, 'payment_method_reminder', `payment_method_reminder:${p.stripe_invoice_id}`);
    sent += 1;
  }
  return { reminded: sent };
}

// One reminder, 3 days after payment, to applicants who still haven't opened their Checkr link.
async function backgroundCheckReminders(now) {
  const cutoff = new Date(now.getTime() - 3 * DAY).toISOString();
  const rows = must(await db().from('csbfp_screenings').select('id, registrant_id, registration_id, created_at, link_opened_at')
    .eq('status', 'awaiting_authorization').is('link_opened_at', null).lte('created_at', cutoff), 'Background check reminders');
  let sent = 0;
  for (const sc of rows) {
    const reg = must(await db().from('csbfp_registrations').select('id, status').eq('id', sc.registration_id).maybeSingle(), 'Registration');
    if (!reg || reg.status !== 'pending_screening') continue;
    const r = must(await db().from('csbfp_registrants').select('id, email, legal_first_name, account_status').eq('id', sc.registrant_id).maybeSingle(), 'Registrant');
    if (!r || !r.email || r.account_status !== 'active') continue;
    if (await sendOnce({ dedupeKey: `background_check_reminder:${sc.id}`, registrantId: r.id, templateKey: 'background_check_reminder', to: r.email,
      vars: { first_name: r.legal_first_name || 'there', email: r.email } }) !== 'duplicate') sent++;
  }
  return { sent };
}

async function housekeeping(now) {
  const dayAgo = new Date(now.getTime() - DAY).toISOString();
  await db().from('csbfp_login_codes').delete().lt('expires_at', dayAgo);
  await db().from('csbfp_admin_login_codes').delete().lt('expires_at', dayAgo);
  await db().from('csbfp_verify_lookups').delete().lt('created_at', new Date(now.getTime() - 90 * DAY).toISOString());
  await db().from('csbfp_postmark_events').delete().lt('received_at', new Date(now.getTime() - 90 * DAY).toISOString());
  // Privacy Policy: security records such as IP addresses are deleted or de-identified within 90 days.
  await db().from('csbfp_events').update({ ip: null }).lt('created_at', new Date(now.getTime() - 90 * DAY).toISOString()).not('ip', 'is', null);
  return { ok: true };
}

// One summary email to each admin per day: the last 24 hours, plus what needs attention.
async function adminSummary(now) {
  if (!config.adminEmails.length) return { sent: 0 };
  const since = new Date(now.getTime() - 864e5).toISOString();
  const count = async (q, label) => { const { count: n, error } = await q; if (error) throw new Error(`${label}: ${error.message}`); return n || 0; };
  const head = { count: 'exact', head: true };
  const [newAccounts, accounts, active, inactive, duplicates, support, paid, review] = await Promise.all([
    count(db().from('csbfp_registrants').select('id', head).gte('created_at', since), 'New accounts'),
    count(db().from('csbfp_registrants').select('id', head), 'Accounts'),
    count(db().from('csbfp_registrations').select('id', head).eq('status', 'active'), 'Active'),
    count(db().from('csbfp_registrations').select('id', head).eq('status', 'inactive'), 'Inactive'),
    count(db().from('csbfp_duplicate_flags').select('id', head).eq('status', 'open'), 'Duplicates'),
    count(db().from('csbfp_support_requests').select('id', head).in('status', ['open', 'in_progress']), 'Support'),
    db().from('csbfp_payments').select('amount_cents, billing_reason').eq('status', 'paid').gte('paid_at', since),
    count(db().from('csbfp_registrations').select('id', head).in('status', ['pending_screening', 'under_review']), 'Review'),
  ]);
  const pays = must(paid, 'Payments');
  const cents = pays.reduce((t, p) => t + (p.amount_cents || 0), 0);
  const vars = {
    date: now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' }),
    new_accounts: String(newAccounts), new_paid: String(pays.filter(p => p.billing_reason === 'initial').length),
    renewals: String(pays.filter(p => p.billing_reason !== 'initial').length),
    revenue: `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    review: String(review), inactive: String(inactive), duplicates: String(duplicates), support: String(support), active: String(active), accounts: String(accounts),
  };
  let sent = 0;
  for (const to of config.adminEmails) {
    if (await sendOnce({ dedupeKey: `admin_daily:${pacific(now).date}:${to}`, templateKey: 'admin_daily_summary', to, vars }) !== 'duplicate') sent++;
  }
  return { sent, ...vars };
}

async function runTasks(now = new Date()) {
  const result = {};
  for (const [name, fn] of [['expire', expireDue], ['renewal_reminders', renewalReminders], ['employer_paid_reminders', employerPaidReminders], ['payment_method_reminders', paymentMethodReminders], ['background_check_reminders', backgroundCheckReminders], ['housekeeping', housekeeping], ['admin_summary', adminSummary]]) {
    try { result[name] = await fn(now); } catch (err) { result[name] = { error: err.message }; console.error(`Daily job ${name} failed:`, err.message); }
  }
  return result;
}

// Run once per Pacific day, after 6 AM.
async function runIfDue(now = new Date()) {
  const { date, hour } = pacific(now);
  if (hour < 6) return null;
  const { data: run, error } = await db().from('csbfp_job_runs').insert({ job: 'daily', run_date: date }).select('id').single();
  if (error) {
    if (error.code === '23505') return null; // already ran today
    throw new Error(`Job run: ${error.message}`);
  }
  const result = await runTasks(now);
  await db().from('csbfp_job_runs').update({ finished_at: new Date().toISOString(), result }).eq('id', run.id);
  return result;
}

function startDailyJob() {
  const tick = () => runIfDue().catch(err => console.error('Daily job failed:', err.message));
  setTimeout(tick, 30 * 1000);
  setInterval(tick, 15 * 60 * 1000).unref();
}

module.exports = { runTasks, runIfDue, startDailyJob, pacific };
