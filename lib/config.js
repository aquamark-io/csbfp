/**
 * Environment settings in one place. The public site works without any of the portal settings;
 * the portal shows "temporarily unavailable" until they are all present.
 */
const list = v => (v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const config = {
  production: process.env.NODE_ENV === 'production',
  siteUrl: (process.env.SITE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  preLaunch: process.env.PRE_LAUNCH !== 'false',
  // While pre-launch, only these emails may sign up or sign in. Defaults to the admin list.
  previewEmails: list(process.env.PREVIEW_EMAILS || process.env.ADMIN_EMAILS),
  adminEmails: list(process.env.ADMIN_EMAILS),
  emailFrom: process.env.EMAIL_FROM || 'CSBFP <no-reply@csbfp-certification.org>',
  emailReplyTo: process.env.EMAIL_REPLY_TO || 'support@csbfp-certification.org',
};

const int = (v, d) => (/^\d+$/.test(String(v || '').trim()) ? Number(v) : d);

// Program settings. Names, price and number prefix can be changed in Render without code changes.
config.program = {
  name: process.env.PROGRAM_NAME || 'Certified Small Business Finance Professional',
  short: process.env.PROGRAM_SHORT_NAME || 'CSBFP',
  domain: process.env.PROGRAM_DOMAIN || 'csbfp-certification.org',
  supportEmail: process.env.SUPPORT_EMAIL || 'support@csbfp-certification.org',
  operator: process.env.PROGRAM_OPERATOR || 'Duncan Consulting LLC',
  annualFeeCents: int(process.env.ANNUAL_FEE_CENTS, 14900),
  // Shown on card statements (Stripe allows up to 22 characters).
  statementDescriptor: (process.env.STATEMENT_DESCRIPTOR || 'CSBFP CERTIFICATION').slice(0, 22),
  numberPrefix: /^[A-Z]{2,10}$/.test(process.env.CERT_NUMBER_PREFIX || '') ? process.env.CERT_NUMBER_PREFIX : 'CSBFP',
  demoNumberPrefix: 'DEMO',
};
config.program.annualFee = `$${(config.program.annualFeeCents / 100).toFixed(config.program.annualFeeCents % 100 ? 2 : 0)}`;

// One-time background check at initial certification (Checkr; phase 1 uses per-state open invitation links).
// Off until the links are set in Admin > Background Checks.
// While off, anything issued is a DEMO credential, never shown publicly as a genuine certification.
config.screening = {
  enabled: process.env.BACKGROUND_SCREENING_ENABLED === 'true',
  provider: process.env.SCREENING_PROVIDER || 'checkr',
  policyVersion: process.env.SCREENING_POLICY_VERSION || 'draft-2026-11',
};

const PORTAL_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'JWT_SECRET', 'FIELD_ENCRYPTION_KEY', 'FIELD_HASH_KEY'];
if (config.production) PORTAL_VARS.push('POSTMARK_SERVER_TOKEN');

config.missingPortalVars = () => PORTAL_VARS.filter(n => !process.env[n] || (n === 'JWT_SECRET' && process.env[n].length < 32));
config.portalReady = () => config.missingPortalVars().length === 0;
config.previewAllowed = email => !config.preLaunch || config.previewEmails.includes(String(email || '').toLowerCase());

module.exports = config;
