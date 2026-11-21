/**
 * Admin: training content, assessment questions and settings, results.
 *
 *   GET      /admin/training                              curriculum versions
 *   GET/POST /admin/training/v/:vid                       overview + completion text, settings, module list
 *   POST     /admin/training/v/:vid/copy                  start a new draft version from this one
 *   POST     /admin/training/v/:vid/publish               make this the required version
 *   POST     /admin/training/v/:vid/modules               add a module
 *   GET/POST /admin/training/v/:vid/modules/:mid          edit a module
 *   POST     /admin/training/v/:vid/modules/:mid/move     reorder (up / down)
 *   POST     /admin/training/v/:vid/modules/:mid/delete   draft versions only
 *   GET      /admin/training/v/:vid/questions             question bank
 *   GET/POST /admin/training/v/:vid/questions/:qid        edit (or "new")
 *   GET      /admin/training/results                      recent assessment attempts
 *   POST     /admin/registrants/:id/reset-attempts        reset the attempt limit (reason required)
 *
 * Edits to the current version apply immediately (fine for corrections). To require retraining, copy the version,
 * edit the draft, and publish it. Past attempts keep a snapshot of what was shown, so edits never change them.
 */
const express = require('express');
const { db, must } = require('../lib/supabase');
const { logAdmin } = require('../lib/audit');
const { logEvent } = require('../lib/events');
const { render: renderMd } = require('../lib/markdown');
const training = require('../lib/training');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();
router.use(requireAdmin);

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
const text = (v, max) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
const line = (v, max) => text(v, max).replace(/\s+/g, ' ');
const int = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const msgOf = req => ({ msg: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : null,
  err: typeof req.query.err === 'string' ? req.query.err.slice(0, 200) : null });
const go = (res, path, msg, isErr) => res.redirect(303, `${path}?${isErr ? 'err' : 'msg'}=${encodeURIComponent(msg)}`);
const slug = s => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'module';

async function loadVersion(req) {
  if (!isUuid(req.params.vid)) return null;
  return must(await db().from('br_curriculum_versions').select('*').eq('id', req.params.vid).maybeSingle(), 'Version');
}

// ---------- versions ----------

router.get('/training', async (req, res, next) => {
  try {
    const versions = must(await db().from('br_curriculum_versions').select('*').order('created_at', { ascending: false }), 'Versions');
    const counts = await Promise.all(versions.map(async v => {
      const [m, q] = await Promise.all([
        db().from('br_modules').select('id', { count: 'exact', head: true }).eq('curriculum_version_id', v.id),
        db().from('br_questions').select('id', { count: 'exact', head: true }).eq('curriculum_version_id', v.id).eq('active', true),
      ]);
      return { modules: m.count || 0, questions: q.count || 0 };
    }));
    res.render('admin/training', { pageTitle: 'Training', versions: versions.map((v, i) => ({ ...v, ...counts[i] })), ...msgOf(req) });
  } catch (err) { next(err); }
});

router.get('/training/v/:vid', async (req, res, next) => {
  try {
    const v = await loadVersion(req);
    if (!v) return next();
    const [modules, settings, qcount] = await Promise.all([
      training.modulesOf(v.id), training.settingsOf(v.id),
      db().from('br_questions').select('id', { count: 'exact', head: true }).eq('curriculum_version_id', v.id).eq('active', true),
    ]);
    res.render('admin/training-version', { pageTitle: `Training ${v.label}`, v, modules, settings, questionCount: qcount.count || 0, ...msgOf(req) });
  } catch (err) { next(err); }
});

router.post('/training/v/:vid', async (req, res, next) => {
  try {
    const v = await loadVersion(req);
    if (!v) return next();
    const path = `/admin/training/v/${v.id}`;
    if (req.body.section === 'text') {
      const update = { overview_md: text(req.body.overview_md, 20000), completion_md: text(req.body.completion_md, 5000) };
      const label = line(req.body.label, 60);
      if (label) update.label = label;
      const { error } = await db().from('br_curriculum_versions').update(update).eq('id', v.id);
      if (error) return go(res, path, error.code === '23505' ? 'Another version already has that name.' : 'Could not save.', true);
      await logAdmin({ adminId: req.admin.id, action: 'training_text_updated', targetType: 'curriculum', targetId: v.id, detail: { label: update.label || v.label }, ip: req.ip });
      return go(res, path, 'Saved.');
    }
    if (req.body.section === 'settings') {
      const s = {
        question_count: int(req.body.question_count, 1, 200), pass_percent: int(req.body.pass_percent, 1, 100),
        cooldown_minutes: int(req.body.cooldown_minutes, 0, 10080),
        max_attempts_total: req.body.max_attempts_total === '' ? null : int(req.body.max_attempts_total, 1, 1000),
      };
      if (Object.entries(s).some(([k, x]) => x === null && !(k === 'max_attempts_total' && req.body.max_attempts_total === ''))) {
        return go(res, path, 'Check the settings: whole numbers only (questions 1-200, pass 1-100%).', true);
      }
      const existing = must(await db().from('br_assessment_settings').select('curriculum_version_id').eq('curriculum_version_id', v.id).maybeSingle(), 'Settings');
      if (existing) must(await db().from('br_assessment_settings').update(s).eq('curriculum_version_id', v.id), 'Save settings');
      else must(await db().from('br_assessment_settings').insert({ ...s, curriculum_version_id: v.id }), 'Save settings');
      await logAdmin({ adminId: req.admin.id, action: 'assessment_settings_updated', targetType: 'curriculum', targetId: v.id, detail: { label: v.label, ...s }, ip: req.ip });
      return go(res, path, 'Assessment settings saved.');
    }
    return next();
  } catch (err) { next(err); }
});

router.post('/training/v/:vid/copy', async (req, res, next) => {
  try {
    const v = await loadVersion(req);
    if (!v) return next();
    const label = line(req.body.label, 60);
    if (!label) return go(res, `/admin/training/v/${v.id}`, 'Enter a name for the new version.', true);
    const { data: nv, error } = await db().from('br_curriculum_versions')
      .insert({ label, status: 'draft', is_required: false, overview_md: v.overview_md, completion_md: v.completion_md }).select('*').single();
    if (error) return go(res, `/admin/training/v/${v.id}`, error.code === '23505' ? 'That name is already used.' : 'Could not create it.', true);
    const [mods, settings, questions] = await Promise.all([training.modulesOf(v.id), training.settingsOf(v.id), training.questionsOf(v.id, { activeOnly: false })]);
    if (mods.length) {
      must(await db().from('br_modules').insert(mods.map(m => ({ curriculum_version_id: nv.id, stable_key: m.stable_key, position: m.position,
        title: m.title, body_md: m.body_md, video_url: m.video_url, estimated_minutes: m.estimated_minutes, summary: m.summary }))), 'Copy modules');
    }
    must(await db().from('br_assessment_settings').insert({ curriculum_version_id: nv.id, question_count: settings.question_count,
      pass_percent: settings.pass_percent, cooldown_minutes: settings.cooldown_minutes, max_attempts_total: settings.max_attempts_total }), 'Copy settings');
    for (const q of questions) {
      const nq = must(await db().from('br_questions').insert({ curriculum_version_id: nv.id, module_stable_key: q.module_stable_key,
        position: q.position, prompt: q.prompt, explanation: q.explanation, active: q.active }).select('id').single(), 'Copy question');
      if (q.options.length) {
        must(await db().from('br_question_options').insert(q.options.map(o => ({ question_id: nq.id, text: o.text, is_correct: o.is_correct, position: o.position }))), 'Copy options');
      }
    }
    await logAdmin({ adminId: req.admin.id, action: 'training_version_created', targetType: 'curriculum', targetId: nv.id, detail: { label, from: v.label }, ip: req.ip });
    return go(res, `/admin/training/v/${nv.id}`, `Draft "${label}" created. Registrants won't see it until you publish it.`);
  } catch (err) { next(err); }
});

router.post('/training/v/:vid/publish', async (req, res, next) => {
  try {
    const v = await loadVersion(req);
    if (!v) return next();
    if (v.is_required) return go(res, `/admin/training/v/${v.id}`, 'This is already the current version.', true);
    if (req.body.confirm !== 'yes') return go(res, `/admin/training/v/${v.id}`, 'Tick the confirmation box to publish.', true);
    const mods = await training.modulesOf(v.id);
    const qs = await training.questionsOf(v.id);
    const settings = await training.settingsOf(v.id);
    if (!mods.length || qs.length < settings.question_count || qs.some(q => q.options.filter(o => o.is_correct).length !== 1)) {
      return go(res, `/admin/training/v/${v.id}`, `Can't publish yet: it needs at least one module and ${settings.question_count} active questions, each with exactly one correct answer.`, true);
    }
    const current = must(await db().from('br_curriculum_versions').select('id, label').eq('is_required', true).maybeSingle(), 'Current');
    if (current) must(await db().from('br_curriculum_versions').update({ is_required: false, status: 'retired' }).eq('id', current.id), 'Retire current');
    must(await db().from('br_curriculum_versions').update({ is_required: true, status: 'published', published_at: new Date().toISOString() }).eq('id', v.id), 'Publish');
    await logAdmin({ adminId: req.admin.id, action: 'training_version_published', targetType: 'curriculum', targetId: v.id,
      detail: { label: v.label, replaced: current ? current.label : null }, ip: req.ip });
    return go(res, `/admin/training/v/${v.id}`, `"${v.label}" is now the required training.`);
  } catch (err) { next(err); }
});

// ---------- modules ----------

router.post('/training/v/:vid/modules', async (req, res, next) => {
  try {
    const v = await loadVersion(req);
    if (!v) return next();
    const title = line(req.body.title, 120);
    if (!title) return go(res, `/admin/training/v/${v.id}`, 'Enter a module title.', true);
    const mods = await training.modulesOf(v.id);
    let key = slug(title);
    while (mods.some(m => m.stable_key === key)) key = `${key}-2`;
    const m = must(await db().from('br_modules').insert({ curriculum_version_id: v.id, stable_key: key, title,
      position: Math.max(0, ...mods.map(x => x.position)) + 1, body_md: '' }).select('id').single(), 'Add module');
    await logAdmin({ adminId: req.admin.id, action: 'module_added', targetType: 'curriculum', targetId: v.id, detail: { label: title }, ip: req.ip });
    return go(res, `/admin/training/v/${v.id}/modules/${m.id}`, 'Module added. Write its content below.');
  } catch (err) { next(err); }
});

async function loadModule(req, v) {
  if (!isUuid(req.params.mid)) return null;
  return must(await db().from('br_modules').select('*').eq('id', req.params.mid).eq('curriculum_version_id', v.id).maybeSingle(), 'Module');
}

router.get('/training/v/:vid/modules/:mid', async (req, res, next) => {
  try {
    const v = await loadVersion(req);
    const m = v && await loadModule(req, v);
    if (!m) return next();
    res.render('admin/training-module', { pageTitle: m.title, v, m, preview: renderMd(m.body_md), ...msgOf(req) });
  } catch (err) { next(err); }
});

router.post('/training/v/:vid/modules/:mid', async (req, res, next) => {
  try {
    const v = await loadVersion(req);
    const m = v && await loadModule(req, v);
    if (!m) return next();
    const path = `/admin/training/v/${v.id}/modules/${m.id}`;
    const title = line(req.body.title, 120);
    if (!title) return go(res, path, 'The title is required.', true);
    const video = line(req.body.video_url, 300);
    if (video && !/^https:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\//i.test(video)) return go(res, path, 'Videos must be YouTube or Vimeo links.', true);
    const update = { title, body_md: text(req.body.body_md, 60000), video_url: video || null,
      summary: line(req.body.summary, 160) || null };
    must(await db().from('br_modules').update(update).eq('id', m.id), 'Save module');
    await logAdmin({ adminId: req.admin.id, action: 'module_updated', targetType: 'curriculum', targetId: v.id, detail: { label: title }, ip: req.ip });
    return go(res, path, 'Module saved.');
  } catch (err) { next(err); }
});

router.post('/training/v/:vid/modules/:mid/move', async (req, res, next) => {
  try {
    const v = await loadVersion(req);
    const m = v && await loadModule(req, v);
    if (!m) return next();
    const mods = await training.modulesOf(v.id);
    const i = mods.findIndex(x => x.id === m.id);
    const j = req.body.dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= mods.length) return res.redirect(303, `/admin/training/v/${v.id}`);
    const other = mods[j];
    // Swap via a temporary position (positions are unique within a version).
    must(await db().from('br_modules').update({ position: -1 }).eq('id', m.id), 'Move');
    must(await db().from('br_modules').update({ position: m.position }).eq('id', other.id), 'Move');
    must(await db().from('br_modules').update({ position: other.position }).eq('id', m.id), 'Move');
    await logAdmin({ adminId: req.admin.id, action: 'module_reordered', targetType: 'curriculum', targetId: v.id, detail: { label: m.title }, ip: req.ip });
    return res.redirect(303, `/admin/training/v/${v.id}`);
  } catch (err) { next(err); }
});

router.post('/training/v/:vid/modules/:mid/delete', async (req, res, next) => {
  try {
    const v = await loadVersion(req);
    const m = v && await loadModule(req, v);
    if (!m) return next();
    if (v.status !== 'draft') return go(res, `/admin/training/v/${v.id}`, 'Modules can only be removed from a draft version.', true);
    must(await db().from('br_modules').delete().eq('id', m.id), 'Delete module');
    await logAdmin({ adminId: req.admin.id, action: 'module_deleted', targetType: 'curriculum', targetId: v.id, detail: { label: m.title }, ip: req.ip });
    return go(res, `/admin/training/v/${v.id}`, 'Module removed.');
  } catch (err) { next(err); }
});

// ---------- questions ----------

router.get('/training/v/:vid/questions', async (req, res, next) => {
  try {
    const v = await loadVersion(req);
    if (!v) return next();
    const [questions, modules] = await Promise.all([training.questionsOf(v.id, { activeOnly: false }), training.modulesOf(v.id)]);
    res.render('admin/training-questions', { pageTitle: 'Questions', v, questions, modules, ...msgOf(req) });
  } catch (err) { next(err); }
});

async function loadQuestion(req, v) {
  if (req.params.qid === 'new') return null;
  if (!isUuid(req.params.qid)) return undefined;
  const q = must(await db().from('br_questions').select('*').eq('id', req.params.qid).eq('curriculum_version_id', v.id).maybeSingle(), 'Question');
  if (!q) return undefined;
  q.options = must(await db().from('br_question_options').select('*').eq('question_id', q.id).order('position'), 'Options');
  return q;
}

router.get('/training/v/:vid/questions/:qid', async (req, res, next) => {
  try {
    const v = await loadVersion(req);
    if (!v) return next();
    const q = await loadQuestion(req, v);
    if (q === undefined) return next();
    const modules = await training.modulesOf(v.id);
    res.render('admin/training-question', { pageTitle: q ? 'Edit Question' : 'New Question', v, q, modules, ...msgOf(req) });
  } catch (err) { next(err); }
});

router.post('/training/v/:vid/questions/:qid', async (req, res, next) => {
  try {
    const v = await loadVersion(req);
    if (!v) return next();
    const q = await loadQuestion(req, v);
    if (q === undefined) return next();
    const back = `/admin/training/v/${v.id}/questions/${q ? q.id : 'new'}`;

    const prompt = line(req.body.prompt, 1000);
    const options = [0, 1, 2, 3, 4, 5].map(i => ({ i, text: line(req.body[`option_${i}`], 500) })).filter(o => o.text);
    const correctIdx = parseInt(req.body.correct, 10);
    if (!prompt) return go(res, back, 'The question is required.', true);
    if (options.length < 2) return go(res, back, 'Enter at least two answer choices.', true);
    if (!options.some(o => o.i === correctIdx)) return go(res, back, 'Mark which answer is correct (it must have text).', true);

    const fields = {
      prompt, explanation: line(req.body.explanation, 2000) || null, active: req.body.active === 'yes',
      module_stable_key: line(req.body.module_stable_key, 60) || null,
      position: int(req.body.position, 0, 10000) ?? 0,
    };
    let id;
    if (q) {
      must(await db().from('br_questions').update(fields).eq('id', q.id), 'Save question');
      must(await db().from('br_question_options').delete().eq('question_id', q.id), 'Replace options');
      id = q.id;
    } else {
      if (!req.body.position) {
        const all = must(await db().from('br_questions').select('position').eq('curriculum_version_id', v.id), 'Positions');
        fields.position = Math.max(0, ...all.map(x => x.position)) + 1;
      }
      id = must(await db().from('br_questions').insert({ ...fields, curriculum_version_id: v.id }).select('id').single(), 'Add question').id;
    }
    must(await db().from('br_question_options').insert(options.map((o, k) => ({ question_id: id, text: o.text, is_correct: o.i === correctIdx, position: k + 1 }))), 'Save options');
    await logAdmin({ adminId: req.admin.id, action: q ? 'question_updated' : 'question_added', targetType: 'curriculum', targetId: v.id,
      detail: { label: prompt.slice(0, 80) }, ip: req.ip });
    return go(res, `/admin/training/v/${v.id}/questions/${id}`, 'Question saved.');
  } catch (err) { next(err); }
});

// ---------- results ----------

router.get('/training/results', async (req, res, next) => {
  try {
    const attempts = must(await db().from('br_assessment_attempts').select('id, registrant_id, curriculum_version_id, started_at, submitted_at, correct_count, question_count, score_percent, passed')
      .order('started_at', { ascending: false }).limit(200), 'Attempts');
    const ids = [...new Set(attempts.map(a => a.registrant_id))];
    const vids = [...new Set(attempts.map(a => a.curriculum_version_id))];
    const [people, versions] = await Promise.all([
      ids.length ? db().from('br_registrants').select('id, legal_first_name, middle_name, legal_last_name, email').in('id', ids) : { data: [] },
      vids.length ? db().from('br_curriculum_versions').select('id, label').in('id', vids) : { data: [] },
    ]);
    const by = new Map(must(people, 'People').map(p => [p.id, p]));
    const vby = new Map(must(versions, 'Versions').map(x => [x.id, x.label]));
    res.render('admin/training-results', { pageTitle: 'Assessment Results', attempts: attempts.map(a => ({ ...a, person: by.get(a.registrant_id), version: vby.get(a.curriculum_version_id) })) });
  } catch (err) { next(err); }
});

router.post('/registrants/:id/reset-attempts', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return next();
    const reason = line(req.body.reason, 500);
    const path = `/admin/registrants/${req.params.id}`;
    if (!reason) return go(res, path, 'A reason is required.', true);
    must(await db().from('br_assessment_resets').insert({ registrant_id: req.params.id, admin_id: req.admin.id, reason }), 'Reset attempts');
    await logAdmin({ adminId: req.admin.id, action: 'assessment_attempts_reset', targetType: 'registrant', targetId: req.params.id, reason, ip: req.ip });
    await logEvent({ registrantId: req.params.id, event: 'assessment_attempts_reset', actor: 'admin' });
    return go(res, path, 'Attempt limit reset. They can take the assessment again.');
  } catch (err) { next(err); }
});

module.exports = router;
