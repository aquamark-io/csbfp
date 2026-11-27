/**
 * Training and assessment state for a registrant, against the required curriculum version.
 */
const { db, must } = require('./supabase');

async function requiredCurriculum() {
  return must(await db().from('csbfp_curriculum_versions').select('*')
    .eq('is_required', true).eq('status', 'published').maybeSingle(), 'Required curriculum');
}

async function modulesOf(curriculumId) {
  return must(await db().from('csbfp_modules').select('*').eq('curriculum_version_id', curriculumId).order('position'), 'Modules');
}

async function settingsOf(curriculumId) {
  return must(await db().from('csbfp_assessment_settings').select('*').eq('curriculum_version_id', curriculumId).maybeSingle(), 'Assessment settings')
    || { question_count: 20, pass_percent: 80, cooldown_minutes: 0, max_attempts_total: 5 };
}

async function questionsOf(curriculumId, { activeOnly = true } = {}) {
  let q = db().from('csbfp_questions').select('*').eq('curriculum_version_id', curriculumId);
  if (activeOnly) q = q.eq('active', true);
  const questions = must(await q.order('position'), 'Questions');
  if (!questions.length) return [];
  const options = must(await db().from('csbfp_question_options').select('*').in('question_id', questions.map(x => x.id)).order('position'), 'Options');
  return questions.map(x => ({ ...x, options: options.filter(o => o.question_id === x.id) }));
}

/**
 * Everything the dashboard, training and assessment pages need.
 * modules: [{ ...module, completed, unlocked }], allComplete, assessment: { passed, attemptsUsed, attemptsLeft, nextAllowedAt, lastAttempt, open }
 */
async function stateFor(registrantId) {
  const cur = await requiredCurriculum();
  if (!cur) return { curriculum: null, modules: [], allComplete: false, assessment: null };
  const [mods, progressRows, settings, attemptsRows, resetRow] = await Promise.all([
    modulesOf(cur.id),
    db().from('csbfp_training_progress').select('module_id, started_at, completed_at').eq('registrant_id', registrantId),
    settingsOf(cur.id),
    db().from('csbfp_assessment_attempts').select('id, started_at, submitted_at, score_percent, correct_count, question_count, passed, curriculum_version_id')
      .eq('registrant_id', registrantId).eq('curriculum_version_id', cur.id).order('started_at', { ascending: false }),
    db().from('csbfp_assessment_resets').select('created_at').eq('registrant_id', registrantId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  const progress = new Map(must(progressRows, 'Progress').map(p => [p.module_id, p]));
  let unlocked = true;
  const modules = mods.map(m => {
    const p = progress.get(m.id);
    const row = { ...m, completed: Boolean(p && p.completed_at), started: Boolean(p), unlocked };
    if (!row.completed) unlocked = false; // modules open in order
    return row;
  });
  const allComplete = modules.length > 0 && modules.every(m => m.completed);

  const attempts = must(attemptsRows, 'Attempts');
  const lastReset = must(resetRow, 'Reset') ? resetRow.data.created_at : null;
  const submitted = attempts.filter(a => a.submitted_at);
  const counted = submitted.filter(a => !lastReset || Date.parse(a.started_at) > Date.parse(lastReset));
  const passedAttempt = submitted.find(a => a.passed) || null;
  const lastAttempt = submitted[0] || null;
  const open = attempts.find(a => !a.submitted_at) || null;
  const max = settings.max_attempts_total;
  const attemptsLeft = max == null ? null : Math.max(0, max - counted.length);
  let nextAllowedAt = null;
  if (lastAttempt && !lastAttempt.passed && settings.cooldown_minutes) {
    const t = new Date(new Date(lastAttempt.submitted_at).getTime() + settings.cooldown_minutes * 60000);
    if (t > new Date()) nextAllowedAt = t.toISOString();
  }
  return {
    curriculum: cur, modules, allComplete, settings,
    assessment: { passed: Boolean(passedAttempt), passedAttempt, lastAttempt, open, attemptsUsed: counted.length, attemptsLeft, nextAllowedAt },
  };
}

module.exports = { requiredCurriculum, modulesOf, settingsOf, questionsOf, stateFor };
