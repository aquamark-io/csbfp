/**
 * Stripe client and configuration.
 *
 * STRIPE_SECRET_KEY lives only in Render. The price, billing-portal configuration and webhook are created by the
 * admin "Set up Stripe" action and their ids (plus the webhook signing secret, encrypted) are kept in br_settings.
 *
 * Safety: while PRE_LAUNCH is on, a live key (sk_live_ / rk_live_) is refused, so no real charges can happen.
 */
const Stripe = require('stripe');
const config = require('./config');
const { db, must } = require('./supabase');
const { encrypt, decrypt } = require('./crypto');

let client = null;
const key = () => (process.env.STRIPE_SECRET_KEY || '').trim();
const isLiveKey = () => /^(sk|rk)_live_/.test(key());

function blockedReason() {
  if (!key()) return 'STRIPE_SECRET_KEY is not set.';
  if (isLiveKey() && config.preLaunch) return 'A live Stripe key is set while the site is in preview. Payments are disabled until launch.';
  return null;
}

function stripe() {
  const blocked = blockedReason();
  if (blocked) throw new Error(blocked);
  if (!client) client = Stripe(key(), { maxNetworkRetries: 2, appInfo: { name: 'broker-registry' } });
  return client;
}
stripe.set = c => { client = c; }; // tests

// ---------- settings stored in br_settings ----------

async function getSetting(k) {
  const row = must(await db().from('br_settings').select('value').eq('key', k).maybeSingle(), 'Setting');
  return row ? row.value : null;
}

async function setSetting(k, value, adminId = null) {
  const existing = must(await db().from('br_settings').select('key').eq('key', k).maybeSingle(), 'Setting');
  if (existing) must(await db().from('br_settings').update({ value, updated_by: adminId, updated_at: new Date().toISOString() }).eq('key', k), 'Save setting');
  else must(await db().from('br_settings').insert({ key: k, value, updated_by: adminId }), 'Save setting');
}

const mode = () => (isLiveKey() ? 'live' : 'test');
// Each mode keeps its own ids, so switching to the live key at launch needs a fresh setup, not a cleanup.
const k = name => `stripe_${mode()}_${name}`;

async function stripeConfig() {
  const [priceId, portalId, webhookSecretEnc] = await Promise.all([getSetting(k('price_id')), getSetting(k('portal_configuration_id')), getSetting(k('webhook_secret'))]);
  let webhookSecret = null;
  try { webhookSecret = webhookSecretEnc ? decrypt(webhookSecretEnc) : null; } catch { webhookSecret = null; }
  return { priceId, portalId, webhookSecret, ready: Boolean(priceId && portalId && webhookSecret) };
}

async function saveWebhookSecret(secret, adminId) { await setSetting(k('webhook_secret'), encrypt(secret), adminId); }

const paymentsReady = async () => !blockedReason() && (await stripeConfig()).ready;

module.exports = { stripe, blockedReason, isLiveKey, mode, k, getSetting, setSetting, stripeConfig, saveWebhookSecret, paymentsReady };
