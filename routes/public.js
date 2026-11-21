/**
 * Public pages: home, about, registration information, verify, legal documents.
 * Page copy lives in the views (views/*.ejs) and is draft until reviewed.
 */
const express = require('express');
const config = require('../lib/config');
const legal = require('../lib/legal');

const router = express.Router();

router.get('/', (req, res) => res.render('home', { pageTitle: null }));
router.get('/about', (req, res) => res.render('about', { pageTitle: 'About' }));
router.get('/faq', (req, res) => res.render('faq', { pageTitle: 'FAQ' }));
router.get('/registration', (req, res) => res.redirect(301, '/faq'));

const PUBLIC_DOCS = ['terms', 'privacy'];

router.get('/legal', (req, res) => res.render('legal-index', {
  pageTitle: 'Legal', docs: PUBLIC_DOCS.map(k => ({ slug: legal.keyToSlug(k), title: legal.KEYS[k] })),
}));

router.get('/legal/:slug', async (req, res, next) => {
  // Older document addresses now point to the matching part of the Program Terms.
  const retired = legal.RETIRED[String(req.params.slug).replace(/-/g, '_')];
  if (retired) return res.redirect(301, `/legal/${retired}`);
  const key = legal.slugToKey(req.params.slug);
  if (!key || !PUBLIC_DOCS.includes(key)) return next();
  let doc = null;
  try {
    if (config.portalReady()) doc = await legal.currentDoc(key);
  } catch (err) {
    console.error('Legal document load failed:', err.message);
  }
  res.render('legal', { pageTitle: legal.KEYS[key], title: legal.KEYS[key], doc, html: doc ? legal.renderMd(doc.body_md) : null });
});

module.exports = router;
