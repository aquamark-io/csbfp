/**
 * Employer certification credits. Lightweight by design: no employer sign-in or portal.
 *
 *   - An employer requests an Employer ID (company, contact, email). It goes live immediately.
 *   - Anyone with the ID and the email on file can buy credits (Stripe Checkout, one-time payment) and check the balance.
 *   - 1 credit = one first-year certification fee. Non-refundable, no expiry, no volume discount.
 *   - An applicant chooses "My employer is paying" at the payment step and enters the ID; one credit is used.
 *     Employer-paid certifications run one year with no automatic renewal; the 30-day reminder asks the person
 *     to put a card on file. Nothing about the employee is shared with the employer.
 */
const crypto = require('crypto');
const config = require('./config');
const { db, must } = require('./supabase');
const { stripe } = require('./stripe');
const { sendQuietly } = require('./email');

const APP = 'csbfp';
const KIND = 'employer_credits';
const MAX_QTY = 500;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

const normalizeNumber = s => {
  const raw = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.startsWith('ER') ? raw.slice(2) : raw;
  return /^[A-Z0-9]{6}$/.test(body) ? `ER-${body}` : null;
};
const balanceOf = e => e.credits_purchased + e.credits_adjusted - e.credits_used;

function newNumber() {
  const bytes = crypto.randomBytes(6);
  return `ER-${[...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('')}`;
}

async function create({ companyName, contactName, email }) {
  for (let i = 0; i < 10; i++) {
    const { data, error } = await db().from('csbfp_employers')
      .insert({ employer_number: newNumber(), company_name: companyName, contact_name: contactName || null, email }).select('*').single();
    if (!error) {
      await sendQuietly({ dedupeKey: `employer_created:${data.id}`, templateKey: 'employer_welcome', to: email,
        vars: { first_name: contactName || 'there', company: companyName, employer_number: data.employer_number, amount: config.program.annualFee } });
      return data;
    }
    if (error.code !== '23505') throw new Error(`Create employer: ${error.message}`);
  }
  throw new Error('Could not create a unique Employer ID');
}

// Look up by ID and the email on file (light check: this is how employers "sign in").
async function find(number, email) {
  const n = normalizeNumber(number);
  if (!n) return null;
  const e = must(await db().from('csbfp_employers').select('*').eq('employer_number', n).eq('active', true).maybeSingle(), 'Employer');
  if (!e) return null;
  if (email != null && e.email !== String(email).trim().toLowerCase()) return null;
  return e;
}

async function createCheckout(employer, quantity) {
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer_email: employer.email,
    line_items: [{ quantity, price_data: { currency: 'usd', unit_amount: config.program.annualFeeCents,
      product_data: { name: 'CSBFP certification credit', description: 'Pays one first-year CSBFP certification fee. Non-refundable; does not expire.' } } }],
    metadata: { app: APP, kind: KIND, employer_id: employer.id, quantity: String(quantity) },
    payment_intent_data: { description: `CSBFP certification credits (${employer.employer_number})`, metadata: { app: APP, kind: KIND, employer_id: employer.id } },
    success_url: `${config.siteUrl}/employers/purchase/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.siteUrl}/employers?canceled=1#buy`,
  });
  must(await db().from('csbfp_employer_purchases').insert({ employer_id: employer.id, stripe_session_id: session.id, quantity,
    amount_cents: quantity * config.program.annualFeeCents }), 'Record purchase');
  return session;
}

/** Add credits for a paid Checkout Session (webhook or return page). Safe to run more than once. */
async function fulfill(sessionOrId) {
  const session = typeof sessionOrId === 'string' ? await stripe().checkout.sessions.retrieve(sessionOrId) : sessionOrId;
  if (!session || (session.metadata || {}).kind !== KIND || session.payment_status !== 'paid') return { added: false };
  const { data: added, error } = await db().rpc('csbfp_add_employer_credits', { p_session_id: session.id });
  if (error) throw new Error(`Add credits: ${error.message}`);
  const purchase = must(await db().from('csbfp_employer_purchases').select('*').eq('stripe_session_id', session.id).single(), 'Purchase');
  const employer = must(await db().from('csbfp_employers').select('*').eq('id', purchase.employer_id).single(), 'Employer');
  if (added) {
    await sendQuietly({ dedupeKey: `employer_credits:${session.id}`, templateKey: 'employer_credits_added', to: employer.email,
      vars: { first_name: employer.contact_name || 'there', company: employer.company_name, employer_number: employer.employer_number,
        quantity: String(purchase.quantity), balance: String(balanceOf(employer)) } });
  }
  return { added: Boolean(added), employer, purchase };
}

/** Use one credit for a registration. Returns { ok, employer } or { ok: false, reason: 'not_found' | 'no_credits' }. */
async function useCredit(number, registrationId) {
  const n = normalizeNumber(number);
  if (!n) return { ok: false, reason: 'not_found' };
  const { data, error } = await db().rpc('csbfp_use_employer_credit', { p_employer_number: n, p_registration_id: registrationId });
  if (error) {
    if (/EMPLOYER_NOT_FOUND/.test(error.message)) return { ok: false, reason: 'not_found' };
    if (/NO_CREDITS/.test(error.message)) return { ok: false, reason: 'no_credits' };
    throw new Error(`Use credit: ${error.message}`);
  }
  const employer = must(await db().from('csbfp_employers').select('*').eq('id', data).single(), 'Employer');
  return { ok: true, employer };
}

/** Admin correction (+/-), logged as an adjustment row. */
async function adjust(employer, amount, note, adminId) {
  must(await db().from('csbfp_employers').update({ credits_adjusted: employer.credits_adjusted + amount }).eq('id', employer.id), 'Adjust credits');
  must(await db().from('csbfp_employer_credit_uses').insert({ employer_id: employer.id, kind: 'adjustment', amount, note, actor_id: adminId }), 'Adjustment log');
}

/** Replace a misused ID: the old one stops working; the balance moves to a new ID for the same employer. */
async function reissue(employer) {
  for (let i = 0; i < 10; i++) {
    const { data, error } = await db().from('csbfp_employers').insert({
      employer_number: newNumber(), company_name: employer.company_name, contact_name: employer.contact_name, email: employer.email,
      credits_adjusted: balanceOf(employer),
    }).select('*').single();
    if (error && error.code === '23505') continue;
    if (error) throw new Error(`Reissue: ${error.message}`);
    must(await db().from('csbfp_employers').update({ active: false, replaced_by: data.id, credits_adjusted: employer.credits_adjusted - balanceOf(employer) })
      .eq('id', employer.id), 'Retire old ID');
    await sendQuietly({ dedupeKey: `employer_reissued:${data.id}`, templateKey: 'employer_welcome', to: data.email,
      vars: { first_name: data.contact_name || 'there', company: data.company_name, employer_number: data.employer_number, amount: config.program.annualFee } });
    return data;
  }
  throw new Error('Could not create a unique Employer ID');
}

module.exports = { KIND, MAX_QTY, normalizeNumber, balanceOf, create, find, createCheckout, fulfill, useCredit, adjust, reissue };
