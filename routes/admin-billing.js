/**
 * Admin: Stripe setup and payments.
 *
 *   GET  /admin/stripe          connection status (test / live, account name, what's configured)
 *   POST /admin/stripe/setup    create or update the product, annual price (ANNUAL_FEE_CENTS), billing portal settings and webhook
 *   GET  /admin/payments        recent payments, failed payments, upcoming renewals
 */
const express = require('express');
const config = require('../lib/config');
const { db, must } = require('../lib/supabase');
const S = require('../lib/stripe');
const { logAdmin } = require('../lib/audit');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();
router.use(requireAdmin);

const APP = 'csbfp';
const PRODUCT_NAME = 'CSBFP Annual Certification';
const AMOUNT = config.program.annualFeeCents;
const EVENTS = ['checkout.session.completed', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted'];

router.get('/stripe', async (req, res, next) => {
  try {
    const blocked = S.blockedReason();
    let account = null;
    let accountError = null;
    if (!blocked) {
      try { account = await S.stripe().accounts.retrieve(); } catch (err) { accountError = err.message; }
    }
    const cfg = blocked ? {} : await S.stripeConfig();
    res.render('admin/stripe', { pageTitle: 'Stripe', blocked, mode: S.mode(), account, accountError, cfg,
      webhookUrl: `${config.siteUrl}/webhooks/stripe`,
      msg: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 300) : null,
      err: typeof req.query.err === 'string' ? req.query.err.slice(0, 300) : null });
  } catch (err) { next(err); }
});

router.post('/stripe/setup', async (req, res, next) => {
  const back = (m, isErr) => res.redirect(303, `/admin/stripe?${isErr ? 'err' : 'msg'}=${encodeURIComponent(m)}`);
  try {
    if (S.blockedReason()) return back(S.blockedReason(), true);
    const stripe = S.stripe();
    const done = [];

    // Product
    const products = await stripe.products.list({ limit: 100 });
    let product = products.data.find(p => (p.metadata || {}).app === APP);
    if (!product) {
      product = await stripe.products.create({ name: PRODUCT_NAME, description: 'Annual individual certification. Renews automatically each year unless canceled.',
        statement_descriptor: config.program.statementDescriptor, metadata: { app: APP } });
      done.push('product created');
    } else if (!product.active || product.statement_descriptor !== config.program.statementDescriptor) {
      product = await stripe.products.update(product.id, { active: true, statement_descriptor: config.program.statementDescriptor });
    }

    // Annual price
    const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
    let price = prices.data.find(p => p.unit_amount === AMOUNT && p.currency === 'usd' && p.recurring && p.recurring.interval === 'year' && (p.recurring.interval_count || 1) === 1);
    if (!price) {
      price = await stripe.prices.create({ product: product.id, unit_amount: AMOUNT, currency: 'usd', recurring: { interval: 'year' }, nickname: `${config.program.annualFee} per year`, metadata: { app: APP } });
      done.push('price created');
    }
    await S.setSetting(S.k('price_id'), price.id, req.admin.id);

    // Billing portal: update card and see receipts; cancel at period end. No plan changes, no email edits.
    const portalParams = {
      business_profile: { headline: 'CSBFP: manage your annual certification', privacy_policy_url: `${config.siteUrl}/legal/privacy`, terms_of_service_url: `${config.siteUrl}/legal/terms` },
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
        customer_update: { enabled: false },
        subscription_update: { enabled: false },
      },
      default_return_url: `${config.siteUrl}/portal/billing`,
      metadata: { app: APP },
    };
    const portalId = await S.getSetting(S.k('portal_configuration_id'));
    if (portalId) {
      await stripe.billingPortal.configurations.update(portalId, portalParams);
    } else {
      const portal = await stripe.billingPortal.configurations.create(portalParams);
      await S.setSetting(S.k('portal_configuration_id'), portal.id, req.admin.id);
      done.push('billing portal configured');
    }

    // Webhook. The signing secret is only shown when an endpoint is created, so we create one if we don't have it.
    const url = `${config.siteUrl}/webhooks/stripe`;
    const cfg = await S.stripeConfig();
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    const ours = endpoints.data.filter(e => (e.metadata || {}).app === APP || e.url === url);
    const savedId = await S.getSetting(S.k('webhook_endpoint_id'));
    const keep = cfg.webhookSecret && ours.find(e => e.id === savedId);
    for (const e of ours) if (!keep || e.id !== keep.id) await stripe.webhookEndpoints.del(e.id);
    if (keep) {
      await stripe.webhookEndpoints.update(keep.id, { url, enabled_events: EVENTS, disabled: false });
    } else {
      const ep = await stripe.webhookEndpoints.create({ url, enabled_events: EVENTS, description: 'CSBFP', metadata: { app: APP } });
      await S.saveWebhookSecret(ep.secret, req.admin.id);
      await S.setSetting(S.k('webhook_endpoint_id'), ep.id, req.admin.id);
      done.push('webhook created');
    }

    await logAdmin({ adminId: req.admin.id, action: 'stripe_setup', detail: { mode: S.mode(), price: price.id, steps: done }, ip: req.ip });
    return back(`Stripe is set up (${S.mode()} mode). ${done.length ? `Done: ${done.join(', ')}.` : 'Everything was already in place.'}`);
  } catch (err) {
    console.error('Stripe setup failed:', err.message);
    return back(`Stripe setup failed: ${err.message}`, true);
  }
});

router.get('/payments', async (req, res, next) => {
  try {
    const soon = new Date(Date.now() + 45 * 864e5).toISOString();
    const [payments, upcoming] = await Promise.all([
      db().from('csbfp_payments').select('*').order('created_at', { ascending: false }).limit(200),
      db().from('csbfp_subscriptions').select('*').in('stripe_status', ['active', 'past_due']).lte('current_period_end', soon).order('current_period_end'),
    ]);
    const rows = must(payments, 'Payments');
    const ups = must(upcoming, 'Upcoming');
    const ids = [...new Set([...rows, ...ups].map(x => x.registrant_id))];
    const people = ids.length ? must(await db().from('csbfp_registrants').select('id, legal_first_name, middle_name, legal_last_name, email').in('id', ids), 'People') : [];
    const by = new Map(people.map(p => [p.id, p]));
    res.render('admin/payments', { pageTitle: 'Payments', payments: rows.map(x => ({ ...x, person: by.get(x.registrant_id) })),
      upcoming: ups.map(x => ({ ...x, person: by.get(x.registrant_id) })), mode: S.mode() });
  } catch (err) { next(err); }
});

// Public lookups: totals and the busiest networks (keyed IP hashes only), to spot scraping.
router.get('/lookups', async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const rows = must(await db().from('csbfp_verify_lookups').select('ip_hash, found, created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(5000), 'Lookups');
    const byNet = new Map();
    for (const r of rows) {
      const x = byNet.get(r.ip_hash) || { hash: r.ip_hash, total: 0, notFound: 0, last: r.created_at };
      x.total += 1; if (!r.found) x.notFound += 1;
      byNet.set(r.ip_hash, x);
    }
    const top = [...byNet.values()].sort((a, b) => b.total - a.total).slice(0, 20);
    res.render('admin/lookups', { pageTitle: 'Verify Lookups', total: rows.length, found: rows.filter(r => r.found).length, networks: byNet.size, top });
  } catch (err) { next(err); }
});

module.exports = router;
