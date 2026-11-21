/**
 * Versioned legal documents (br_legal_documents) and acceptance records (br_legal_acceptances).
 * The latest published version of each document is what registrants see and accept.
 */
const { db, must } = require('./supabase');

// The Program Terms combine the former Terms of Service, Registration Agreement, Automatic Renewal Terms and
// Disclaimer (their version 1 placeholders stay in the database for the record but are no longer used).
const KEYS = {
  terms: 'Program Terms',
  privacy: 'Privacy Policy',
  acknowledgments: 'Registrant Acknowledgments',
  conduct_standards: 'Professional Standards Acknowledgment',
};
const RETIRED = { registration_agreement: 'terms', automatic_renewal: 'terms#6-fees-and-automatic-renewal', disclaimer: 'terms' };

// Public URLs use hyphens: /legal/registration-agreement
const slugToKey = slug => {
  const key = String(slug || '').replace(/-/g, '_');
  return Object.hasOwn(KEYS, key) ? key : null;
};
const keyToSlug = key => key.replace(/_/g, '-');

let cache = { at: 0, docs: null };
async function currentDocs() {
  if (cache.docs && Date.now() - cache.at < 60 * 1000) return cache.docs;
  const rows = must(await db().from('br_legal_documents')
    .select('key, version, title, body_md, effective_at, published_at')
    .eq('status', 'published').order('version', { ascending: false }), 'Legal documents');
  const docs = {};
  for (const r of rows) if (!docs[r.key]) docs[r.key] = r;
  cache = { at: Date.now(), docs };
  return docs;
}

async function currentDoc(key) {
  return (await currentDocs())[key] || null;
}

async function recordAcceptance({ registrantId, keys, context, ref = null, ip = null, userAgent = null }) {
  const docs = await currentDocs();
  const rows = keys.map(key => {
    if (!docs[key]) throw new Error(`No published ${key} document`);
    return { registrant_id: registrantId, document_key: key, document_version: docs[key].version, context, ref, ip,
      user_agent: userAgent ? String(userAgent).slice(0, 300) : null };
  });
  must(await db().from('br_legal_acceptances').insert(rows), 'Record acceptance');
}

// Acknowledgment-style documents are a Markdown list; each "- " line becomes one required checkbox.
const { render: renderMd, listItems } = require('./markdown');
const statements = doc => (doc ? listItems(doc.body_md) : []);

module.exports = { KEYS, RETIRED, slugToKey, keyToSlug, currentDocs, currentDoc, recordAcceptance, statements, renderMd,
  clearCache: () => { cache = { at: 0, docs: null }; } };
