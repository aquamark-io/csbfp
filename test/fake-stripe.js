/**
 * A small stand-in for the parts of the Stripe API the app uses, for tests only. Shapes follow the current API
 * (subscription periods on items, invoice -> parent.subscription_details). Webhook signing uses the real library.
 */
const Stripe = require('stripe');

function createFakeStripe() {
  let n = 0;
  const id = p => `${p}_test_${(++n).toString().padStart(6, '0')}`;
  const now = () => Math.floor(Date.now() / 1000);
  const YEAR = 365 * 86400;
  const s = { customers: {}, sessions: {}, subscriptions: {}, invoices: {}, products: [], prices: [], endpoints: [], portals: {} };

  function makeInvoice(sub, { reason, paid, start, end }) {
    const inv = {
      id: id('in'), object: 'invoice', customer: sub.customer, billing_reason: reason, status: paid ? 'paid' : 'open',
      amount_paid: paid ? 14900 : 0, amount_due: 14900, currency: 'usd', attempt_count: paid ? 1 : 1, created: now(),
      parent: { type: 'subscription_details', subscription_details: { subscription: sub.id } },
      lines: { data: [{ period: { start, end } }] },
      status_transitions: { paid_at: paid ? now() : null },
      hosted_invoice_url: `https://invoice.stripe.com/i/${n}`,
    };
    s.invoices[inv.id] = inv;
    return inv;
  }
  const expandSub = (sub, expand = []) => ({ ...sub, latest_invoice: expand.some(e => e.endsWith('latest_invoice')) ? s.invoices[sub.latest_invoice] : sub.latest_invoice });

  const api = {
    state: s,
    customers: { create: async p => { const c = { id: id('cus'), ...p }; s.customers[c.id] = c; return c; } },
    checkout: {
      sessions: {
        create: async p => {
          const sess = { id: id('cs'), object: 'checkout.session', mode: p.mode, customer: p.customer, client_reference_id: p.client_reference_id,
            metadata: p.metadata, _subMeta: (p.subscription_data || {}).metadata, _trialEnd: (p.subscription_data || {}).trial_end || null,
            line_items: p.line_items, subscription: null, url: `https://checkout.stripe.com/c/pay/${n}`, payment_status: 'unpaid' };
          s.sessions[sess.id] = sess;
          return sess;
        },
        retrieve: async (sid, opts = {}) => {
          const sess = s.sessions[sid];
          const expand = opts.expand || [];
          return { ...sess, subscription: sess.subscription && expand.includes('subscription') ? expandSub(s.subscriptions[sess.subscription], expand) : sess.subscription };
        },
      },
    },
    subscriptions: {
      retrieve: async (sid, opts = {}) => expandSub(s.subscriptions[sid], opts.expand || []),
      update: async (sid, p) => {
        const sub = s.subscriptions[sid];
        const { trial_end: trialEnd, proration_behavior: _pb, ...rest } = p;
        Object.assign(sub, rest);
        if (trialEnd) { sub.status = 'trialing'; sub.trial_end = trialEnd; sub.items.data[0].current_period_end = trialEnd; }
        return { ...sub };
      },
      cancel: async sid => { Object.assign(s.subscriptions[sid], { status: 'canceled', canceled_at: now(), ended_at: now() }); return { ...s.subscriptions[sid] }; },
    },
    invoices: { retrieve: async iid => ({ ...s.invoices[iid] }) },
    billingPortal: {
      sessions: { create: async () => ({ url: `https://billing.stripe.com/p/session/${n}` }) },
      configurations: {
        create: async p => { const c = { id: id('bpc'), ...p }; s.portals[c.id] = c; return c; },
        update: async (cid, p) => Object.assign(s.portals[cid], p),
      },
    },
    accounts: { retrieve: async () => ({ id: 'acct_test', business_profile: { name: 'Broker Registry' } }) },
    products: {
      list: async () => ({ data: s.products }),
      create: async p => { const x = { id: id('prod'), active: true, ...p }; s.products.push(x); return x; },
      update: async (pid, p) => Object.assign(s.products.find(x => x.id === pid), p),
    },
    prices: {
      list: async q => ({ data: s.prices.filter(x => x.product === q.product) }),
      create: async p => { const x = { id: id('price'), active: true, ...p }; s.prices.push(x); return x; },
    },
    webhookEndpoints: {
      list: async () => ({ data: s.endpoints }),
      create: async p => { const x = { id: id('we'), secret: `whsec_${n}testsecret`, ...p }; s.endpoints.push(x); return x; },
      update: async (eid, p) => Object.assign(s.endpoints.find(x => x.id === eid), p),
      del: async eid => { s.endpoints = s.endpoints.filter(x => x.id !== eid); return { deleted: true }; },
    },
    webhooks: Stripe('sk_test_fake').webhooks,

    // ---- test controls: what Stripe would do ----
    completePayment(sessionId) {
      const sess = s.sessions[sessionId];
      sess.payment_status = 'paid';
      sess.status = 'complete';
      return sess;
    },
    completeCheckout(sessionId) {
      const sess = s.sessions[sessionId];
      if (sess._trialEnd) {
        const start = now();
        const sub = { id: id('sub'), object: 'subscription', customer: sess.customer, status: 'trialing', metadata: sess._subMeta, trial_end: sess._trialEnd,
          cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
          items: { data: [{ current_period_start: start, current_period_end: sess._trialEnd }] } };
        s.subscriptions[sub.id] = sub;
        const inv = makeInvoice(sub, { reason: 'subscription_create', paid: true, start, end: sess._trialEnd });
        Object.assign(inv, { amount_paid: 0, amount_due: 0 });
        sub.latest_invoice = inv.id;
        sess.subscription = sub.id;
        sess.payment_status = 'no_payment_required';
        return sub;
      }
      const start = now();
      const sub = { id: id('sub'), object: 'subscription', customer: sess.customer, status: 'active', metadata: sess._subMeta,
        cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
        items: { data: [{ current_period_start: start, current_period_end: start + YEAR }] } };
      s.subscriptions[sub.id] = sub;
      sub.latest_invoice = makeInvoice(sub, { reason: 'subscription_create', paid: true, start, end: start + YEAR }).id;
      sess.subscription = sub.id;
      sess.payment_status = 'paid';
      return sub;
    },
    renew(subId, { paid }) {
      const sub = s.subscriptions[subId];
      const item = sub.items.data[0];
      const start = item.current_period_end;
      const inv = makeInvoice(sub, { reason: 'subscription_cycle', paid, start, end: start + YEAR });
      sub.latest_invoice = inv.id;
      if (paid) { item.current_period_start = start; item.current_period_end = start + YEAR; sub.status = 'active'; } else { sub.status = 'past_due'; }
      return inv;
    },
    payInvoice(invId) {
      const inv = s.invoices[invId];
      Object.assign(inv, { status: 'paid', amount_paid: 14900, status_transitions: { paid_at: now() } });
      const sub = s.subscriptions[inv.parent.subscription_details.subscription];
      const item = sub.items.data[0];
      item.current_period_start = inv.lines.data[0].period.start;
      item.current_period_end = inv.lines.data[0].period.end;
      sub.status = 'active';
      return inv;
    },
    endSubscription(subId) {
      Object.assign(s.subscriptions[subId], { status: 'canceled', ended_at: now(), canceled_at: now() });
      return s.subscriptions[subId];
    },
  };
  return api;
}

module.exports = { createFakeStripe };
