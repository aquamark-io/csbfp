/**
 * Default wording for every Broker Registry email. Admins can override the subject and body of any template in
 * /admin/emails (stored in br_email_templates); the layout, footer and buttons stay in code.
 *
 * Body format: Markdown (see lib/markdown.js). The first line "# ..." is the heading. {{name}} placeholders are
 * filled in when sending (values are escaped). A line containing only {{code}} shows a large one-time code.
 *
 * Never put a date of birth in any template.
 */
const T = {
  // ---------- account ----------
  email_verification: {
    name: 'Verify email (sign-up code)', group: 'Account', trigger: 'First sign-in code after creating an account.',
    subject: 'Verify your email for Broker Registry',
    body: `# Verify your email\n\nHi {{first_name}},\n\nEnter this code to verify your email address and finish creating your account:\n\n{{code}}\n\nThe code expires in 10 minutes and can be used once. If you did not request it, you can ignore this email.`,
    sample: { code: '482913' },
  },
  sign_in_code: {
    name: 'Sign-in code', group: 'Account', trigger: 'Each time a registrant signs in.',
    subject: 'Your Broker Registry sign-in code',
    body: `# Sign-in code\n\nHi {{first_name}},\n\nEnter this code to sign in:\n\n{{code}}\n\nThe code expires in 10 minutes and can be used once. If you did not request it, you can ignore this email.`,
    sample: { code: '482913' },
  },
  welcome: {
    name: 'Welcome / registration started', group: 'Account', trigger: 'After the email address is verified.',
    subject: 'Your Broker Registry account is ready',
    body: `# Your account is ready\n\nHi {{first_name}},\n\nYour email address is verified and your Broker Registry account has been created.\n\nTo complete your registration, sign in and finish each step on your dashboard: your registration information, the acknowledgments, the training modules and the assessment, and then the annual registration fee.`,
    button: { label: 'Go to your dashboard', path: '/portal/dashboard' },
  },
  email_change_code: {
    name: 'Email change: confirm new address', group: 'Account', trigger: 'Sent to the new address when a registrant changes their email.',
    subject: 'Confirm your new email for Broker Registry',
    body: `# Confirm your new email address\n\nHi {{first_name}},\n\nEnter this code to confirm this as the new email address for your Broker Registry account:\n\n{{code}}\n\nThe code expires in 10 minutes. If you did not request this change, you can ignore this email.`,
    sample: { code: '482913' },
  },
  email_changed: {
    name: 'Email address changed', group: 'Account', trigger: 'Sent to the old address after an email change.',
    subject: 'Your Broker Registry email address was changed',
    body: `# Email address changed\n\nHi {{first_name}},\n\nThe email address on your Broker Registry account was changed to **{{new_email}}**. Sign-in codes and notices now go to the new address.\n\nIf you did not make this change, contact support@broker-registry.org right away.`,
    sample: { new_email: 'new.address@example.com' },
  },
  no_account: {
    name: 'Sign-in attempt, no account', group: 'Account', trigger: 'Someone tries to sign in with an email that has no account (at most once an hour).',
    subject: 'Broker Registry sign-in request',
    body: `# No account found\n\nSomeone asked to sign in to Broker Registry with this email address, but there is no account for it.\n\nIf this was you, you can create an account instead. If it was not you, you can ignore this email.`,
    button: { label: 'Create an account', path: '/portal/signup' },
  },

  // ---------- training ----------
  training_completed: {
    name: 'Training completed', group: 'Training', trigger: 'After the last training module.',
    subject: 'Broker Registry training completed',
    body: `# Training completed\n\nHi {{first_name}},\n\nYou have completed all of the Broker Registry training modules.\n\nThe next step is the assessment. You can take it from your dashboard whenever you are ready.`,
    button: { label: 'Go to the assessment', path: '/portal/assessment' },
  },
  assessment_passed: {
    name: 'Assessment passed', group: 'Training', trigger: 'After a passing attempt.',
    subject: 'You passed the Broker Registry assessment',
    body: `# Assessment passed\n\nHi {{first_name}},\n\nYou passed the Broker Registry assessment with {{correct}} of {{total}} correct.\n\nThe next step is the annual registration fee, which activates your registration and issues your registration number.`,
    button: { label: 'Go to your dashboard', path: '/portal/dashboard' },
    sample: { correct: '19', total: '20' },
  },
  assessment_failed: {
    name: 'Assessment not passed', group: 'Training', trigger: 'After a failing attempt.',
    subject: 'Your Broker Registry assessment result',
    body: `# Assessment not passed\n\nHi {{first_name}},\n\nYou answered {{correct}} of {{total}} correctly. A score of {{pass_percent}}% is needed to pass.\n\n{{retry}}`,
    button: { label: 'Review the training', path: '/portal/training' },
    sample: { correct: '14', total: '20', pass_percent: '80', retry: 'You can take the assessment again after 60 minutes. You have 9 attempts left. Reviewing the training modules first may help.' },
  },

  // ---------- registration ----------
  registration_activated: {
    name: 'Registration activated (with number)', group: 'Registration', trigger: 'When the first payment (or a rejoin payment) activates a registration.',
    subject: 'Your Broker Registry registration is active: {{number}}',
    body: `# Your registration is active\n\nHi {{first_name}},\n\nYour payment was received and your registration is now active.\n\n- Registration number: **{{number}}**\n- Valid through: **{{valid_through}}**\n\nYour registration renews automatically each year at {{amount}} unless you cancel automatic renewal. We will remind you 30 days before each renewal. You can view receipts, update your payment method or cancel automatic renewal from your account at any time.\n\nAnyone can confirm your registration at broker-registry.org/verify using your registration number. Registration is not a government license and does not replace any license or registration required by law.`,
    button: { label: 'View your registration confirmation', path: '/portal/confirmation' },
    sample: { number: 'BR-48213907', valid_through: 'November 18, 2027', amount: '$99' },
  },
  registration_info_updated: {
    name: 'Registration information updated', group: 'Registration', trigger: 'When an active registrant changes their information (at most once a day).',
    subject: 'Your Broker Registry information was updated',
    body: `# Information updated\n\nHi {{first_name}},\n\nThe information on your Broker Registry registration was updated today. You can review it any time from your account.\n\nIf you did not make this change, contact support@broker-registry.org.`,
    button: { label: 'Review your information', path: '/portal/dashboard' },
  },

  // ---------- renewal ----------
  renewal_reminder: {
    name: 'Renewal reminder (30 days)', group: 'Renewal', trigger: 'Daily job, 30 days before an automatic renewal.',
    subject: 'Your Broker Registry registration renews on {{renewal_date}}',
    body: `# Upcoming automatic renewal\n\nHi {{first_name}},\n\nYour Broker Registry registration ({{number}}) renews automatically on **{{renewal_date}}**. On that date, **{{amount}}** will be charged automatically to the payment method on file.\n\n- To update your payment method, sign in and go to Billing.\n- To cancel automatic renewal, sign in, go to Billing and choose "Cancel automatic renewal". Your registration stays active through {{renewal_date}}.\n\nPlease also take a moment to review your employment and contact information so your registration stays accurate.`,
    button: { label: 'Go to Billing', path: '/portal/billing' },
    sample: { number: 'BR-48213907', renewal_date: 'November 18, 2027', amount: '$99' },
  },
  renewal_succeeded: {
    name: 'Renewal payment successful (receipt)', group: 'Renewal', trigger: 'When an automatic renewal is paid.',
    subject: 'Broker Registry renewal receipt',
    body: `# Renewal successful\n\nHi {{first_name}},\n\nYour annual registration fee of {{amount}} was paid and your registration ({{number}}) is active through **{{valid_through}}**.\n\nYour receipt: {{receipt_url}}`,
    button: { label: 'Go to Billing', path: '/portal/billing' },
    sample: { number: 'BR-48213907', valid_through: 'November 18, 2028', amount: '$99', receipt_url: 'https://invoice.stripe.com/i/example' },
  },
  renewal_failed: {
    name: 'Renewal payment failed', group: 'Renewal', trigger: 'When an automatic renewal payment fails. The registration becomes Inactive.',
    subject: 'Action needed: your Broker Registry renewal payment failed',
    body: `# Renewal payment failed\n\nHi {{first_name}},\n\nWe couldn't charge your payment method for your annual registration fee of {{amount}}, so your registration ({{number}}) is now **Inactive**.\n\nTo reactivate it, sign in, go to Billing, and pay now or update your payment method. Your registration becomes active again as soon as the payment goes through.`,
    button: { label: 'Pay now', path: '/portal/billing' },
    sample: { number: 'BR-48213907', amount: '$99' },
  },
  payment_method_reminder: {
    name: 'Payment method reminder', group: 'Renewal', trigger: 'Daily job, 3 days after a failed renewal that is still unpaid.',
    subject: 'Reminder: your Broker Registry registration is inactive',
    body: `# Your registration is still inactive\n\nHi {{first_name}},\n\nYour renewal payment of {{amount}} is still unpaid, so your registration ({{number}}) remains **Inactive**.\n\nSign in, go to Billing, and pay now or update your payment method to reactivate it.`,
    button: { label: 'Pay now', path: '/portal/billing' },
    sample: { number: 'BR-48213907', amount: '$99' },
  },
  auto_renewal_canceled: {
    name: 'Automatic renewal canceled', group: 'Renewal', trigger: 'When a registrant cancels automatic renewal.',
    subject: 'Automatic renewal canceled for your Broker Registry registration',
    body: `# Automatic renewal canceled\n\nHi {{first_name}},\n\nAutomatic renewal is canceled for your registration ({{number}}). You will not be charged again.\n\nYour registration stays active through **{{end_date}}** and then expires. You can turn automatic renewal back on from Billing any time before then, or renew later and keep the same registration number.`,
    button: { label: 'Go to Billing', path: '/portal/billing' },
    sample: { number: 'BR-48213907', end_date: 'November 18, 2027' },
  },
  registration_expired: {
    name: 'Registration expired', group: 'Renewal', trigger: 'Daily job, when a registration reaches its date without renewal.',
    subject: 'Your Broker Registry registration has expired',
    body: `# Registration expired\n\nHi {{first_name}},\n\nYour Broker Registry registration ({{number}}) expired on **{{expired_on}}** and now shows as Expired on public verification.\n\nYou can renew at any time from your account and keep the same registration number.`,
    button: { label: 'Renew your registration', path: '/portal/checkout' },
    sample: { number: 'BR-48213907', expired_on: 'November 18, 2027' },
  },

  // ---------- support and privacy ----------
  support_request_received: {
    name: 'Support request received', group: 'Support', trigger: 'After someone submits the contact form or requests data deletion.',
    subject: 'We received your message (Broker Registry)',
    body: `# We received your message\n\nHi {{first_name}},\n\nThanks for contacting Broker Registry. We received your request about **{{topic}}** and will reply by email, usually within one business day.\n\nYour reference: {{reference}}`,
    sample: { topic: 'account access', reference: 'SR-7F3A21' },
  },
  identity_review_required: {
    name: 'Account recovery / identity review', group: 'Support', trigger: 'Sent by an administrator from a registrant\'s page.',
    subject: 'Action needed: confirming your Broker Registry account details',
    body: `# We need to confirm a few details\n\nHi {{first_name}},\n\nBefore we can continue with your Broker Registry registration or request, we need to confirm some account details.\n\n{{note}}\n\nPlease reply to this email or contact support@broker-registry.org. We will never ask for your Social Security number or your full card number.`,
    sample: { note: 'Please confirm your legal name and the ZIP code you registered with.' },
  },
  data_deleted: {
    name: 'Data deletion completed', group: 'Support', trigger: 'Sent just before an administrator deletes a registrant\'s data.',
    subject: 'Your Broker Registry data has been deleted',
    body: `# Your data has been deleted\n\nHi {{first_name}},\n\nAs you requested, we have deleted the personal information in your Broker Registry account. Your registration can no longer be verified and your account has been closed.\n\nWe keep only a minimal record without your name: your retired registration number (so it is never reissued), payment records required for accounting, and the date you agreed to the automatic renewal terms.`,
  },
  program_update: {
    name: 'Program update (announcement)', group: 'Support', trigger: 'Written and sent by an administrator to registrants (Admin > Announce).',
    subject: '{{subject}}',
    body: `# {{subject}}\n\nHi {{first_name}},\n\n{{message}}`,
    sample: { subject: 'Updated training for 2027', message: 'We have updated the Broker Registry training. You will be asked to complete the new modules before your next renewal.' },
  },

  // ---------- admin ----------
  admin_support_alert: {
    name: 'New support request (to admins)', group: 'Admin', trigger: 'Sent to ADMIN_EMAILS when a support or deletion request arrives.',
    subject: 'New Broker Registry support request: {{topic}}',
    body: `# New support request\n\nA new request about **{{topic}}** was received ({{reference}}). Open the admin area to read and answer it.`,
    button: { label: 'Open support requests', path: '/admin/support' },
    sample: { topic: 'billing', reference: 'SR-7F3A21' },
  },
  admin_daily_summary: {
    name: 'Daily summary (to admins)', group: 'Admin', trigger: 'Sent to ADMIN_EMAILS each morning by the daily job.',
    subject: 'Broker Registry daily summary: {{date}}',
    body: `# Daily summary\n\n{{date}}, covering the last 24 hours.\n\n**Activity**\n\n- New accounts: {{new_accounts}}\n- New paid registrations: {{new_paid}}\n- Renewals paid: {{renewals}}\n- Revenue: {{revenue}}\n\n**Needs attention**\n\n- Inactive (renewal payment failed): {{inactive}}\n- Possible duplicates to review: {{duplicates}}\n- Open support requests: {{support}}\n\n**Totals**\n\n- Active registrations: {{active}}\n- Accounts: {{accounts}}`,
    button: { label: 'Open admin', path: '/admin/registrants' },
    sample: { date: 'Thursday, November 19, 2026', new_accounts: '42', new_paid: '31', renewals: '0', revenue: '$3,069.00', inactive: '0', duplicates: '1', support: '2', active: '31', accounts: '42' },
  },
  admin_sign_in_code: {
    name: 'Admin sign-in code', group: 'Admin', trigger: 'Admin sign-in.',
    subject: 'Your Broker Registry admin sign-in code',
    body: `# Admin sign-in code\n\nEnter this code to sign in to the Broker Registry administrator area:\n\n{{code}}\n\nThe code expires in 10 minutes and can be used once. If you did not try to sign in, someone may be trying to access the admin area with your email address.`,
    sample: { code: '482913' },
  },
};

module.exports = T;
