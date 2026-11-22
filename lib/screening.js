/**
 * One-time background screening at initial certification. PREPARED, NOT INTEGRATED.
 *
 * - Controlled by BACKGROUND_SCREENING_ENABLED (server-side; default false). Applicants cannot skip it.
 * - Providers plug in through the adapter interface below. Only the 'none' placeholder exists: no provider
 *   endpoints, SDK calls, webhooks or fields are assumed. A Checkr adapter is added only after the provider
 *   agreement, using Checkr's actual documentation (candidate authorization flow, signed webhooks, idempotency).
 * - We keep workflow status and minimal metadata only. Never store SSNs, reports or full addresses here.
 * - A provider result is never a final decision: an authorized reviewer records every approve / not-approve.
 *
 * Internal workflow statuses (separate from the public credential status):
 *   not_started, awaiting_authorization, in_progress, review_required, approved, not_approved, disputed
 */
const config = require('./config');
const { db, must } = require('./supabase');

const STATUSES = ['not_started', 'awaiting_authorization', 'in_progress', 'review_required', 'approved', 'not_approved', 'disputed'];
const { LABELS } = require('./screening-labels');

/**
 * Provider adapter interface. Every method must be idempotent.
 *   start(screening)          -> { status, externalRef?, authorizationUrl? }  begin candidate authorization
 *   verifyWebhook(req)        -> event | null                                 signature-checked provider event
 *   statusFromEvent(event)    -> { screeningRef, status, sourceRef }          map a provider event to our status
 */
const PROVIDERS = {
  // Phase 1: one Checkr open invitation link per state, set in Admin > Background Checks. The applicant opens the
  // link from their dashboard; Checkr collects authorization and identifying details and emails us when the report
  // is complete. A reviewer then finds the report by the applicant's name and email and records the result here.
  // Open links can't carry a reference, so there are no automatic results (phase 2: Checkr API + webhooks).
  checkr: {
    integrated: false,
    label: 'Checkr (open invitation links, results recorded by a reviewer)',
    async start() { return { status: 'awaiting_authorization' }; },
    verifyWebhook() { return null; },
    statusFromEvent() { return null; },
  },
  none: {
    integrated: false,
    // Nothing is sent anywhere: the applicant waits until an administrator records progress by hand.
    async start() { return { status: 'awaiting_authorization' }; },
    verifyWebhook() { return null; },
    statusFromEvent() { return null; },
  },
};

function provider() {
  const p = PROVIDERS[config.screening.provider];
  if (!p) throw new Error(`Screening provider "${config.screening.provider}" is not available`);
  return p;
}

const enabled = () => Boolean(config.screening.enabled);

async function forRegistration(registrationId) {
  return must(await db().from('csbfp_screenings').select('*').eq('registration_id', registrationId).maybeSingle(), 'Screening');
}

async function addEvent(screening, from, to, { note = null, actorType = 'system', actorId = null, sourceRef = null } = {}) {
  const { error } = await db().from('csbfp_screening_events')
    .insert({ screening_id: screening.id, from_status: from, to_status: to, note, actor_type: actorType, actor_id: actorId, source_ref: sourceRef });
  if (error && error.code !== '23505') throw new Error(`Screening event: ${error.message}`);
  return !error;
}

// Create the one screening record for a registration (once) and hand it to the provider.
async function begin(registration) {
  const existing = await forRegistration(registration.id);
  if (existing) return existing;
  const row = {
    registrant_id: registration.registrant_id, registration_id: registration.id,
    provider: config.screening.provider, requirement_version: config.screening.policyVersion,
    status: 'not_started', idempotency_key: `screening:${registration.id}`, requested_at: new Date().toISOString(),
  };
  const { data, error } = await db().from('csbfp_screenings').insert(row).select('*').single();
  if (error && error.code === '23505') return forRegistration(registration.id);
  if (error) throw new Error(`Create screening: ${error.message}`);
  await addEvent(data, null, 'not_started', { note: `Requirement version ${row.requirement_version}` });
  const started = await provider().start(data);
  return setStatus(data, started.status, { note: 'Sent to provider', externalRef: started.externalRef });
}

/** Change workflow status and log it. Admin decisions also record reviewer and reason. */
async function setStatus(screening, to, { note = null, actorType = 'system', actorId = null, sourceRef = null, externalRef } = {}) {
  if (!STATUSES.includes(to)) throw new Error(`Unknown screening status ${to}`);
  if (screening.status === to) return screening;
  if (sourceRef && !(await addEvent(screening, screening.status, to, { note, actorType, actorId, sourceRef }))) return screening; // already applied
  const update = { status: to };
  if (externalRef) update.external_ref = externalRef;
  if (['approved', 'not_approved'].includes(to)) {
    if (actorType !== 'admin') throw new Error('Only an authorized reviewer can record a screening decision');
    Object.assign(update, { decision: to, decision_reason: note, reviewer_id: actorId, decided_at: new Date().toISOString(), completed_at: new Date().toISOString() });
  }
  must(await db().from('csbfp_screenings').update(update).eq('id', screening.id), 'Screening status');
  if (!sourceRef) await addEvent(screening, screening.status, to, { note, actorType, actorId });
  return { ...screening, ...update };
}

async function events(screeningId) {
  return must(await db().from('csbfp_screening_events').select('*').eq('screening_id', screeningId).order('created_at', { ascending: false }), 'Screening events');
}

// ---------- Checkr open invitation links, one per state ----------

const LINKS_KEY = 'checkr_invitation_links';

async function invitationLinks() {
  const row = must(await db().from('csbfp_settings').select('value').eq('key', LINKS_KEY).maybeSingle(), 'Invitation links');
  return (row && row.value && typeof row.value === 'object') ? row.value : {};
}

async function saveInvitationLinks(links, adminId) {
  const existing = must(await db().from('csbfp_settings').select('key').eq('key', LINKS_KEY).maybeSingle(), 'Invitation links');
  if (existing) must(await db().from('csbfp_settings').update({ value: links, updated_by: adminId, updated_at: new Date().toISOString() }).eq('key', LINKS_KEY), 'Save links');
  else must(await db().from('csbfp_settings').insert({ key: LINKS_KEY, value: links, updated_by: adminId }), 'Save links');
}

// The applicant opened their state's link: record the state and the first time, so a reviewer can match the report.
async function recordLinkOpened(screening, state) {
  if (screening.link_opened_at) return screening;
  const update = { state, link_opened_at: new Date().toISOString() };
  must(await db().from('csbfp_screenings').update(update).eq('id', screening.id).is('link_opened_at', null), 'Link opened');
  await addEvent(screening, screening.status, screening.status, { note: `Applicant opened the Checkr invitation link (${state})` });
  return { ...screening, ...update };
}

module.exports = { STATUSES, LABELS, PROVIDERS, provider, enabled, begin, setStatus, forRegistration, events,
  invitationLinks, saveInvitationLinks, recordLinkOpened };
