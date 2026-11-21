require('dotenv').config({ quiet: true });
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');

const config = require('./lib/config');
const turnstile = require('./lib/turnstile');
const { readSession } = require('./lib/session');
const sameOrigin = require('./middleware/origin');
const { STATES } = require('./lib/validate');

const app = express();

// Render sits behind one proxy; needed for req.ip and (later) rate limiting.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  // Full referrer within the site only; other sites get nothing. (Helmet's default "no-referrer" makes
  // browsers send "Origin: null" on our own form posts.)
  referrerPolicy: { policy: 'same-origin' },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", ...(turnstile.enabled() ? ['https://challenges.cloudflare.com'] : [])],
      // Training videos (YouTube privacy-enhanced / Vimeo) and, if enabled, the Turnstile check.
      'frame-src': ["'self'", 'https://www.youtube-nocookie.com', 'https://player.vimeo.com', ...(turnstile.enabled() ? ['https://challenges.cloudflare.com'] : [])],
      'connect-src': ["'self'", ...(turnstile.enabled() ? ['https://challenges.cloudflare.com'] : [])],
      'style-src': ["'self'"],
      'font-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      // Checkout and the billing portal are Stripe-hosted pages reached by a form post + redirect.
      'form-action': ["'self'", 'https://checkout.stripe.com', 'https://billing.stripe.com', 'https://invoice.stripe.com'],
      'frame-ancestors': ["'none'"],
      // On the live site everything is https; locally (http) upgrading would break form posts.
      'upgrade-insecure-requests': config.production ? [] : null,
    },
  },
}));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

app.set('view engine', 'ejs');
Object.assign(app.locals, require('./lib/view-helpers'));
app.set('views', path.join(__dirname, 'views'));

// Changes on every deploy so browsers fetch fresh CSS/JS (Render sets RENDER_GIT_COMMIT).
const ASSET_VERSION = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 12);

app.use((req, res, next) => {
  res.locals.assetV = ASSET_VERSION;
  res.locals.currentPath = req.path;
  res.locals.preLaunch = config.preLaunch;
  res.locals.siteUrl = config.siteUrl;
  res.locals.program = config.program;
  res.locals.screeningEnabled = config.screening.enabled;
  res.locals.signedIn = Boolean(readSession(req));
  res.locals.query = req.query;
  res.locals.STATES = STATES;
  res.set('Cache-Control', 'no-store');
  if (config.preLaunch) res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Stripe calls this directly (signed), so it sits before the same-site form check.
app.use('/', require('./routes/webhooks'));
app.use(sameOrigin);
app.use('/', require('./routes/verify').router);
app.use('/', require('./routes/public'));
app.use('/', require('./routes/support'));

// The portal needs the database, email and secrets. Until they are all set, it says so instead of failing.
app.use('/portal', (req, res, next) => {
  if (config.portalReady()) return next();
  console.error('Portal unavailable; missing settings:', config.missingPortalVars().join(', '));
  return res.status(503).render('error', { pageTitle: 'Sign-in unavailable', message: 'Sign-in is temporarily unavailable. Please try again later.' });
});
app.use('/portal', require('./routes/portal'));
app.use('/portal', require('./routes/training'));
app.use('/portal', require('./routes/billing'));
app.use('/portal', require('./routes/account'));
app.use('/portal', require('./routes/profile'));
app.use('/admin', (req, res, next) => (config.portalReady() ? next()
  : res.status(503).render('error', { pageTitle: 'Admin unavailable', message: 'The admin area is temporarily unavailable.' })));
app.use('/admin', require('./routes/admin'));
app.use('/admin', require('./routes/admin-training'));
app.use('/admin', require('./routes/admin-billing'));
app.use('/admin', require('./routes/admin-emails'));
app.use('/admin', require('./routes/admin-support'));
app.use('/admin', require('./routes/admin-reports'));
app.use('/admin', require('./routes/admin-certification'));

app.use((req, res) => res.status(404).render('error', { pageTitle: 'Page not found', message: 'That page does not exist.' }));

app.use((err, req, res, next) => {
  // Never log request bodies: later they will contain personal information.
  console.error(`Error on ${req.method} ${req.path}:`, err.message);
  res.status(500).render('error', { pageTitle: 'Something went wrong', message: 'Something went wrong. Please try again.' });
});

if (config.portalReady()) require('./lib/crypto').checkKeys();
else console.warn('Portal settings missing:', config.missingPortalVars().join(', '));

// Daily job (renewal reminders, expiries, housekeeping). DISABLE_DAILY_JOB=true turns it off (tests).
if (config.portalReady() && process.env.DISABLE_DAILY_JOB !== 'true' && require.main === module) require('./lib/jobs').startDailyJob();

module.exports = app;
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`CSBFP running on port ${PORT}`));
}
