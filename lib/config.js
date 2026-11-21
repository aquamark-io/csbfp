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
  emailFrom: process.env.EMAIL_FROM || 'Broker Registry <no-reply@broker-registry.org>',
  emailReplyTo: process.env.EMAIL_REPLY_TO || 'support@broker-registry.org',
};

const PORTAL_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'JWT_SECRET', 'FIELD_ENCRYPTION_KEY', 'FIELD_HASH_KEY'];
if (config.production) PORTAL_VARS.push('POSTMARK_SERVER_TOKEN');

config.missingPortalVars = () => PORTAL_VARS.filter(n => !process.env[n] || (n === 'JWT_SECRET' && process.env[n].length < 32));
config.portalReady = () => config.missingPortalVars().length === 0;
config.previewAllowed = email => !config.preLaunch || config.previewEmails.includes(String(email || '').toLowerCase());

module.exports = config;
