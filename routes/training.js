/**
 * Training and assessment for signed-in registrants.
 *
 *   GET  /portal/training                     overview and module list
 *   GET  /portal/training/complete            completion message
 *   GET  /portal/training/:key                one module (modules open in order)
 *   POST /portal/training/:key/complete       "I've completed this module"
 *   GET  /portal/assessment                   rules, conduct acknowledgment, start
 *   POST /portal/assessment/start
 *   GET  /portal/assessment/attempt           the open attempt's questions
 *   POST /portal/assessment/submit
 *   GET  /portal/assessment/result/:id
 *
 * Each attempt stores a snapshot of exactly what was shown (questions, choices, answers), so later edits never
 * change past results. Correct answers and explanations are shown only after passing.
 */
const express = require('express');
const config = require('../lib/config');
const { db, must } = require('../lib/supabase');
const { logEvent } = require('../lib/events');
const { sendQuietly, registrantVars } = require('../lib/email');
const legal = require('../lib/legal');
const training = require('../lib/training');
const { render: renderMd, renderSlides } = require('../lib/markdown');
const { requireRegistrant } = require('../middleware/auth');

const router = express.Router();
router.use(['/training', '/assessment'], requireRegistrant);

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');

// YouTube / Vimeo links -> privacy-friendly embed URLs. Anything else isn't embedded.
function embedUrl(url) {
  if (!url) return null;
  let m = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{11})/.exec(url);
  if (m) return `https://www.youtube-nocookie.com/embed/${m[1]}`;
  m = /vimeo\.com\/(?:video\/)?(\d+)/.exec(url);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;
  return null;
}

// ---------- training ----------

router.get('/training', async (req, res, next) => {
  try {
    const state = await training.stateFor(req.registrant.id);
    res.render('portal/training', { pageTitle: 'Training', state, overviewHtml: state.curriculum ? renderMd(state.curriculum.overview_md) : '' });
  } catch (err) { next(err); }
});

router.get('/training/complete', async (req, res, next) => {
  try {
    const state = await training.stateFor(req.registrant.id);
    if (!state.allComplete) return res.redirect('/portal/training');
    res.render('portal/training-complete', { pageTitle: 'Training Complete', state, html: renderMd(state.curriculum.completion_md) });
  } catch (err) { next(err); }
});

async function findModule(req) {
  const state = await training.stateFor(req.registrant.id);
  const idx = state.modules.findIndex(m => m.stable_key === req.params.key);
  return { state, idx, mod: idx >= 0 ? state.modules[idx] : null };
}

router.get('/training/:key', async (req, res, next) => {
  try {
    const { state, idx, mod } = await findModule(req);
    if (!mod) return next();
    if (!mod.unlocked) return res.redirect('/portal/training');
    if (!mod.started) {
      const { error } = await db().from('csbfp_training_progress').insert({ registrant_id: req.registrant.id, module_id: mod.id });
      if (error && error.code !== '23505') throw new Error(`Start module: ${error.message}`);
    }
    res.render('portal/module', { pageTitle: mod.title, state, mod, idx, html: renderSlides(mod.body_md), video: embedUrl(mod.video_url),
      prev: state.modules[idx - 1] || null, next: state.modules[idx + 1] || null });
  } catch (err) { next(err); }
});

router.post('/training/:key/complete', async (req, res, next) => {
  try {
    const { state, idx, mod } = await findModule(req);
    if (!mod) return next();
    if (!mod.unlocked) return res.redirect(303, '/portal/training');
    if (!mod.completed) {
      const now = new Date().toISOString();
      const { error } = await db().from('csbfp_training_progress').insert({ registrant_id: req.registrant.id, module_id: mod.id, started_at: now, completed_at: now });
      if (error) {
        if (error.code !== '23505') throw new Error(`Complete module: ${error.message}`);
        must(await db().from('csbfp_training_progress').update({ completed_at: now })
          .eq('registrant_id', req.registrant.id).eq('module_id', mod.id).is('completed_at', null), 'Complete module');
      }
      await logEvent({ registrantId: req.registrant.id, event: 'module_completed', actor: 'registrant', detail: { module: mod.stable_key, curriculum: state.curriculum.label }, ip: req.ip });
    }
    const nextMod = state.modules[idx + 1];
    if (nextMod) return res.redirect(303, `/portal/training/${nextMod.stable_key}`);

    // That was the last one.
    const fresh = await training.stateFor(req.registrant.id);
    if (fresh.allComplete) {
      await logEvent({ registrantId: req.registrant.id, event: 'training_completed', actor: 'registrant', detail: { curriculum: fresh.curriculum.label }, ip: req.ip });
      sendQuietly({ dedupeKey: `training_completed:${req.registrant.id}:${fresh.curriculum.id}`, registrantId: req.registrant.id,
        templateKey: 'training_completed', to: req.registrant.email, vars: registrantVars(req.registrant) });
    }
    return res.redirect(303, '/portal/training/complete');
  } catch (err) { next(err); }
});

// ---------- assessment ----------

async function conductDoc() { return legal.currentDoc('conduct_standards'); }

async function hasConductAck(registrantId, doc) {
  if (!doc) return true;
  const row = must(await db().from('csbfp_legal_acceptances').select('id').eq('registrant_id', registrantId)
    .eq('document_key', 'conduct_standards').eq('document_version', doc.version).limit(1).maybeSingle(), 'Conduct acknowledgment');
  return Boolean(row);
}

// Why the registrant can't start an attempt right now, or null if they can.
function blockedReason(state) {
  const a = state.assessment;
  if (!state.curriculum) return 'The assessment is not available yet.';
  if (!state.allComplete) return 'Please complete all of the training modules first.';
  if (a.passed) return 'You have already passed the assessment.';
  if (a.attemptsLeft === 0) return `You have used all of your attempts. Please contact ${config.program.supportEmail} to arrange another attempt.`;
  if (a.nextAllowedAt) return `You can take the assessment again after ${new Date(a.nextAllowedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })} Pacific time.`;
  return null;
}

router.get('/assessment', async (req, res, next) => {
  try {
    const state = await training.stateFor(req.registrant.id);
    if (state.assessment && state.assessment.open && !state.assessment.passed) return res.redirect('/portal/assessment/attempt');
    const doc = await conductDoc();
    res.render('portal/assessment', { pageTitle: 'Assessment', state, blocked: blockedReason(state), doc,
      statements: legal.statements(doc), acked: await hasConductAck(req.registrant.id, doc), error: null, checked: [] });
  } catch (err) { next(err); }
});

router.post('/assessment/start', async (req, res, next) => {
  try {
    const state = await training.stateFor(req.registrant.id);
    if (state.assessment && state.assessment.open) return res.redirect(303, '/portal/assessment/attempt');
    const blocked = blockedReason(state);
    if (blocked) return res.redirect(303, '/portal/assessment');

    const doc = await conductDoc();
    if (!(await hasConductAck(req.registrant.id, doc))) {
      const statements = legal.statements(doc);
      const checked = statements.map((_, i) => req.body[`ack_${i}`] === 'yes');
      if (checked.includes(false)) {
        return res.status(422).render('portal/assessment', { pageTitle: 'Assessment', state, blocked: null, doc, statements, acked: false, checked,
          error: 'Please confirm each statement to begin.' });
      }
      await legal.recordAcceptance({ registrantId: req.registrant.id, keys: ['conduct_standards'], context: 'assessment', ip: req.ip, userAgent: req.get('user-agent') });
    }

    const questions = (await training.questionsOf(state.curriculum.id)).slice(0, state.settings.question_count);
    if (!questions.length) return res.redirect(303, '/portal/assessment');
    // Snapshot: exactly what is shown, in order, with the key kept server-side.
    const snapshot = questions.map(q => ({
      id: q.id, prompt: q.prompt, explanation: q.explanation || '',
      options: q.options.map(o => ({ id: o.id, text: o.text })),
      correct: (q.options.find(o => o.is_correct) || {}).id || null,
    }));
    must(await db().from('csbfp_assessment_attempts').insert({
      registrant_id: req.registrant.id, curriculum_version_id: state.curriculum.id,
      questions_snapshot: snapshot, question_count: snapshot.length, pass_percent_applied: state.settings.pass_percent,
    }), 'Start attempt');
    await logEvent({ registrantId: req.registrant.id, event: 'assessment_started', actor: 'registrant', ip: req.ip });
    return res.redirect(303, '/portal/assessment/attempt');
  } catch (err) { next(err); }
});

async function openAttempt(registrantId) {
  return must(await db().from('csbfp_assessment_attempts').select('*').eq('registrant_id', registrantId)
    .is('submitted_at', null).order('started_at', { ascending: false }).limit(1).maybeSingle(), 'Open attempt');
}

// Questions without the answer key, for the page.
const forDisplay = snapshot => snapshot.map(q => ({ id: q.id, prompt: q.prompt, options: q.options }));

router.get('/assessment/attempt', async (req, res, next) => {
  try {
    const attempt = await openAttempt(req.registrant.id);
    if (!attempt) return res.redirect('/portal/assessment');
    res.render('portal/attempt', { pageTitle: 'Assessment', questions: forDisplay(attempt.questions_snapshot), answers: {}, error: null,
      passPercent: attempt.pass_percent_applied });
  } catch (err) { next(err); }
});

router.post('/assessment/submit', async (req, res, next) => {
  try {
    const attempt = await openAttempt(req.registrant.id);
    if (!attempt) return res.redirect(303, '/portal/assessment');
    const snap = attempt.questions_snapshot;
    const answers = {};
    for (const q of snap) {
      const given = req.body[`q_${q.id}`];
      if (typeof given === 'string' && q.options.some(o => o.id === given)) answers[q.id] = given;
    }
    const missing = snap.filter(q => !answers[q.id]).length;
    if (missing) {
      return res.status(422).render('portal/attempt', { pageTitle: 'Assessment', questions: forDisplay(snap), answers, passPercent: attempt.pass_percent_applied,
        error: `Please answer every question (${missing} ${missing === 1 ? 'is' : 'are'} unanswered).` });
    }
    const correct = snap.filter(q => answers[q.id] === q.correct).length;
    const score = Math.round((correct / snap.length) * 10000) / 100;
    const passed = correct * 100 >= attempt.pass_percent_applied * snap.length;
    const done = must(await db().from('csbfp_assessment_attempts').update({
      answers, correct_count: correct, score_percent: score, passed, submitted_at: new Date().toISOString(),
    }).eq('id', attempt.id).is('submitted_at', null).select('*').maybeSingle(), 'Submit attempt');
    if (!done) return res.redirect(303, '/portal/assessment');

    await logEvent({ registrantId: req.registrant.id, event: passed ? 'assessment_passed' : 'assessment_failed', actor: 'registrant',
      detail: { correct, of: snap.length }, ip: req.ip });
    const state = await training.stateFor(req.registrant.id);
    const left = state.assessment.attemptsLeft;
    const cool = state.settings.cooldown_minutes;
    const retry = left === 0
      ? `You have used all of your attempts. Please contact ${config.program.supportEmail} to arrange another attempt.`
      : `You can take the assessment again${cool ? ` after ${cool} minutes` : ''}.${left != null ? ` You have ${left} ${left === 1 ? 'attempt' : 'attempts'} left.` : ''} Reviewing the training modules first may help.`;
    sendQuietly({ dedupeKey: `assessment_result:${done.id}`, registrantId: req.registrant.id, templateKey: passed ? 'assessment_passed' : 'assessment_failed',
      to: req.registrant.email,
      vars: { ...registrantVars(req.registrant), correct: done.correct_count, total: done.question_count, pass_percent: done.pass_percent_applied, retry } });
    return res.redirect(303, `/portal/assessment/result/${done.id}`);
  } catch (err) { next(err); }
});

router.get('/assessment/result/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return next();
    const attempt = must(await db().from('csbfp_assessment_attempts').select('*').eq('id', req.params.id)
      .eq('registrant_id', req.registrant.id).maybeSingle(), 'Attempt');
    if (!attempt || !attempt.submitted_at) return next();
    const state = await training.stateFor(req.registrant.id);
    res.render('portal/result', { pageTitle: 'Assessment Result', attempt, state, blocked: blockedReason(state) });
  } catch (err) { next(err); }
});

module.exports = router;
