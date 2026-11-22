/**
 * Default wording for every CSBFP email. Admins can override the subject and body of any template in
 * /admin/emails (stored in csbfp_email_templates); the layout, footer and buttons stay in code.
 *
 * Body format: Markdown (see lib/markdown.js). The first line "# ..." is the heading. {{name}} placeholders are
 * filled in when sending (values are escaped). A line containing only {{code}} shows a large one-time code.
 *
 * Never put a date of birth, screening details or the reason for an adverse decision in any template.
 */
const { program } = require('./config');

const S = program.supportEmail;
const N = 'CSBFP-48213907';
const FEE = program.annualFee;

const T = {
  // ---------- account ----------
  email_verification: {
    name: 'Verify email (sign-up code)', group: 'Account', trigger: 'First sign-in code after creating an account.',
    subject: 'Verify your email for CSBFP',
    body: `# Verify your email\n\nHi {{first_name}},\n\nEnter this code to verify your email address and finish creating your account:\n\n{{code}}\n\nThe code expires in 10 minutes and can be used once. If you did not request it, you can ignore this email.`,
    sample: { code: '482913' },
  },
  sign_in_code: {
    name: 'Sign-in code', group: 'Account', trigger: 'Each time an applicant or certificant signs in.',
    subject: 'Your CSBFP sign-in code',
    body: `# Sign-in code\n\nHi {{first_name}},\n\nEnter this code to sign in:\n\n{{code}}\n\nThe code expires in 10 minutes and can be used once. If you did not request it, you can ignore this email.`,
    sample: { code: '482913' },
  },
  welcome: {
    name: 'Welcome / application started', group: 'Account', trigger: 'After the email address is verified.',
    subject: 'Your CSBFP account is ready',
    body: `# Your account is ready\n\nHi {{first_name}},\n\nYour email address is verified and your CSBFP account has been created.\n\nTo complete your certification, sign in and finish each step on your dashboard: your application information, the professional standards, the training modules and the assessment, and then the ${FEE} annual certification fee.`,
    button: { label: 'Go to your dashboard', path: '/portal/dashboard' },
  },
  email_change_code: {
    name: 'Email change: confirm new address', group: 'Account', trigger: 'Sent to the new address when someone changes their email.',
    subject: 'Confirm your new email for CSBFP',
    body: `# Confirm your new email address\n\nHi {{first_name}},\n\nEnter this code to confirm this as the new email address for your CSBFP account:\n\n{{code}}\n\nThe code expires in 10 minutes. If you did not request this change, you can ignore this email.`,
    sample: { code: '482913' },
  },
  email_changed: {
    name: 'Email address changed', group: 'Account', trigger: 'Sent to the old address after an email change.',
    subject: 'Your CSBFP email address was changed',
    body: `# Email address changed\n\nHi {{first_name}},\n\nThe email address on your CSBFP account was changed to **{{new_email}}**. Sign-in codes and notices now go to the new address.\n\nIf you did not make this change, contact ${S} right away.`,
    sample: { new_email: 'new.address@example.com' },
  },
  no_account: {
    name: 'Sign-in attempt, no account', group: 'Account', trigger: 'Someone tries to sign in with an email that has no account (at most once an hour).',
    subject: 'CSBFP sign-in request',
    body: `# No account found\n\nSomeone asked to sign in to CSBFP with this email address, but there is no account for it.\n\nIf this was you, you can create an account instead. If it was not you, you can ignore this email.`,
    button: { label: 'Get certified', path: '/portal/signup' },
  },

  // ---------- training ----------
  training_completed: {
    name: 'Training completed', group: 'Training', trigger: 'After the last training module.',
    subject: 'CSBFP training completed',
    body: `# Training completed\n\nHi {{first_name}},\n\nYou have completed all of the CSBFP training modules.\n\nThe next step is the assessment. You can take it from your dashboard whenever you are ready.`,
    button: { label: 'Go to the assessment', path: '/portal/assessment' },
  },
  assessment_passed: {
    name: 'Assessment passed', group: 'Training', trigger: 'After a passing attempt.',
    subject: 'You passed the CSBFP assessment',
    body: `# Assessment passed\n\nHi {{first_name}},\n\nYou passed the CSBFP assessment with {{correct}} of {{total}} correct.\n\nThe next step is the ${FEE} annual certification fee.`,
    button: { label: 'Go to your dashboard', path: '/portal/dashboard' },
    sample: { correct: '19', total: '20' },
  },
  assessment_failed: {
    name: 'Assessment not passed', group: 'Training', trigger: 'After a failing attempt.',
    subject: 'Your CSBFP assessment result',
    body: `# Assessment not passed\n\nHi {{first_name}},\n\nYou answered {{correct}} of {{total}} correctly. A score of {{pass_percent}}% is needed to pass.\n\n{{retry}}`,
    button: { label: 'Review the training', path: '/portal/training' },
    sample: { correct: '14', total: '20', pass_percent: '80', retry: 'You can take the assessment again after 60 minutes. You have 9 attempts left. Reviewing the training modules first may help.' },
  },

  // ---------- certification ----------
  application_received: {
    name: 'Fee paid: start background check', group: 'Certification', trigger: 'When the first payment is received and background checks are on.',
    subject: 'Next step: your CSBFP background check',
    body: `# Start your background check\n\nHi {{first_name}},\n\nYour payment was received. The last step is a one-time background check through Checkr.\n\nWhen Checkr asks for your details, use the same legal name and this email address ({{email}}) so we can match your results to your application. Results usually take 1–3 days, and your certification number is issued once they're reviewed.`,
    button: { label: 'Start your background check', path: '/portal/background-check' },
    sample: { email: 'pat.lee@example.com' },
  },
  background_check_reminder: {
    name: 'Background check reminder', group: 'Certification', trigger: 'Daily job, 3 days after payment if the Checkr link has not been opened (once).',
    subject: 'Reminder: complete your CSBFP background check',
    body: `# Your background check is waiting\n\nHi {{first_name}},\n\nYou're one step from certification. Please complete your one-time background check through Checkr.\n\nUse the same legal name and this email address ({{email}}) in Checkr so we can match your results.`,
    button: { label: 'Start your background check', path: '/portal/background-check' },
    sample: { email: 'pat.lee@example.com' },
  },
  certification_issued: {
    name: 'Certification issued (with number)', group: 'Certification', trigger: 'When a certification is approved and issued. While screening is off, the number is a DEMO number.',
    subject: 'Your CSBFP certification: {{number}}',
    body: `# Your certification is issued\n\nHi {{first_name}},\n\nYou are now a Certified Small Business Finance Professional.\n\n- Certification number: **{{number}}**\n- Valid through: **{{valid_through}}**\n\nYour certification renews automatically each year at {{amount}} unless you cancel automatic renewal. We will remind you 30 days before each renewal.\n\nAnyone can confirm your certification at ${program.domain}/verify using your certification number. CSBFP is a private industry certification. It is not a government license and does not authorize any activity that requires one.`,
    button: { label: 'View your certificate', path: '/portal/confirmation' },
    sample: { number: N, valid_through: 'November 21, 2027', amount: FEE },
  },
  certification_reactivated: {
    name: 'Certification reactivated', group: 'Certification', trigger: 'When a payment reactivates an inactive or expired certification.',
    subject: 'Your CSBFP certification is active again: {{number}}',
    body: `# Certification active again\n\nHi {{first_name}},\n\nYour payment was received and your certification is active again.\n\n- Certification number: **{{number}}**\n- Valid through: **{{valid_through}}**`,
    button: { label: 'View your certificate', path: '/portal/confirmation' },
    sample: { number: N, valid_through: 'November 21, 2027' },
  },
  application_not_approved: {
    name: 'Application not approved', group: 'Certification', trigger: 'When a reviewer records that an application is not approved.',
    subject: 'Your CSBFP application',
    body: `# Your application was not approved\n\nHi {{first_name}},\n\nAfter review, your CSBFP application was not approved. We will send any notices required by law separately.\n\nIf you believe this decision is wrong, contact ${S} to ask about reconsideration.`,
  },
  certification_suspended: {
    name: 'Certification suspended', group: 'Certification', trigger: 'When an administrator suspends a certification.',
    subject: 'Your CSBFP certification has been suspended',
    body: `# Certification suspended\n\nHi {{first_name}},\n\nYour CSBFP certification ({{number}}) has been suspended pending review and now shows as Suspended on public verification.\n\nWe will contact you about the review. You may respond, or ask about the review process, at ${S}.`,
    sample: { number: N },
  },
  certification_reinstated: {
    name: 'Certification reinstated', group: 'Certification', trigger: 'When an administrator lifts a suspension.',
    subject: 'Your CSBFP certification has been reinstated',
    body: `# Certification reinstated\n\nHi {{first_name}},\n\nYour CSBFP certification ({{number}}) has been reinstated and is valid through **{{valid_through}}**.`,
    sample: { number: N, valid_through: 'November 21, 2027' },
  },
  certification_revoked: {
    name: 'Certification revoked', group: 'Certification', trigger: 'When an administrator revokes a certification.',
    subject: 'Your CSBFP certification has been revoked',
    body: `# Certification revoked\n\nHi {{first_name}},\n\nYour CSBFP certification ({{number}}) has been revoked and now shows as Revoked on public verification. Automatic renewal has been stopped.\n\nTo ask about the appeal process, contact ${S}.`,
    sample: { number: N },
  },
  registration_info_updated: {
    name: 'Information updated', group: 'Certification', trigger: 'When a certificant changes their information (at most once a day).',
    subject: 'Your CSBFP information was updated',
    body: `# Information updated\n\nHi {{first_name}},\n\nThe information on your CSBFP account was updated today. You can review it any time from your account.\n\nIf you did not make this change, contact ${S}.`,
    button: { label: 'Review your information', path: '/portal/dashboard' },
  },

  // ---------- renewal ----------
  renewal_reminder: {
    name: 'Renewal reminder (30 days)', group: 'Renewal', trigger: 'Daily job, 30 days before an automatic renewal.',
    subject: 'Your CSBFP certification renews on {{renewal_date}}',
    body: `# Upcoming automatic renewal\n\nHi {{first_name}},\n\nYour CSBFP certification ({{number}}) renews automatically on **{{renewal_date}}**. On that date, **{{amount}}** will be charged to the payment method on file.\n\n- To update your payment method, sign in and go to Billing.\n- To cancel automatic renewal, sign in, go to Billing and choose "Cancel automatic renewal". Your certification stays valid through {{renewal_date}}.\n\nPlease also review your employment and contact information so your record stays accurate.`,
    button: { label: 'Go to Billing', path: '/portal/billing' },
    sample: { number: N, renewal_date: 'November 21, 2027', amount: FEE },
  },
  renewal_succeeded: {
    name: 'Renewal payment successful (receipt)', group: 'Renewal', trigger: 'When an automatic renewal is paid.',
    subject: 'CSBFP renewal receipt',
    body: `# Renewal successful\n\nHi {{first_name}},\n\nYour annual certification fee of {{amount}} was paid and your certification ({{number}}) is valid through **{{valid_through}}**.\n\nYour receipt: {{receipt_url}}`,
    button: { label: 'Go to Billing', path: '/portal/billing' },
    sample: { number: N, valid_through: 'November 21, 2028', amount: FEE, receipt_url: 'https://invoice.stripe.com/i/example' },
  },
  renewal_failed: {
    name: 'Renewal payment failed', group: 'Renewal', trigger: 'When an automatic renewal payment fails. The certification becomes Inactive.',
    subject: 'Action needed: your CSBFP renewal payment failed',
    body: `# Renewal payment failed\n\nHi {{first_name}},\n\nWe couldn't charge your payment method for your annual certification fee of {{amount}}, so your certification ({{number}}) is now **Inactive**.\n\nTo reactivate it, sign in, go to Billing, and pay now or update your payment method. Your certification becomes active again as soon as the payment goes through.`,
    button: { label: 'Pay now', path: '/portal/billing' },
    sample: { number: N, amount: FEE },
  },
  payment_method_reminder: {
    name: 'Payment method reminder', group: 'Renewal', trigger: 'Daily job, 3 days after a failed renewal that is still unpaid.',
    subject: 'Reminder: your CSBFP certification is inactive',
    body: `# Your certification is still inactive\n\nHi {{first_name}},\n\nYour renewal payment of {{amount}} is still unpaid, so your certification ({{number}}) remains **Inactive**.\n\nSign in, go to Billing, and pay now or update your payment method to reactivate it.`,
    button: { label: 'Pay now', path: '/portal/billing' },
    sample: { number: N, amount: FEE },
  },
  auto_renewal_canceled: {
    name: 'Automatic renewal canceled', group: 'Renewal', trigger: 'When automatic renewal is canceled.',
    subject: 'Automatic renewal canceled for your CSBFP certification',
    body: `# Automatic renewal canceled\n\nHi {{first_name}},\n\nAutomatic renewal is canceled for your certification ({{number}}). You will not be charged again.\n\nYour certification stays valid through **{{end_date}}** and then expires. You can turn automatic renewal back on from Billing any time before then, or renew later and keep the same certification number.`,
    button: { label: 'Go to Billing', path: '/portal/billing' },
    sample: { number: N, end_date: 'November 21, 2027' },
  },
  registration_expired: {
    name: 'Certification expired', group: 'Renewal', trigger: 'Daily job, when a certification reaches its date without renewal.',
    subject: 'Your CSBFP certification has expired',
    body: `# Certification expired\n\nHi {{first_name}},\n\nYour CSBFP certification ({{number}}) expired on **{{expired_on}}** and now shows as Expired on public verification.\n\nYou can renew at any time from your account and keep the same certification number.`,
    button: { label: 'Renew your certification', path: '/portal/checkout' },
    sample: { number: N, expired_on: 'November 21, 2027' },
  },

  renewal_add_card: {
    name: 'Renewal: employer-paid year ending, add a card', group: 'Renewal', trigger: 'Daily job, 30 days before an employer-paid year ends, if no card is on file.',
    subject: 'Keep your CSBFP certification active after {{end_date}}',
    body: `# Your employer-paid year ends soon\n\nHi {{first_name}},\n\nYour employer paid for your CSBFP certification ({{number}}) through **{{end_date}}**. Employer credits don't renew automatically.\n\nTo keep your certification active, put a card on file. You'll be charged {{amount}} on {{end_date}} and every year after that until you cancel. If you don't, your certification will expire on {{end_date}}; you can renew later and keep the same number.`,
    button: { label: 'Add a card', path: '/portal/checkout' },
    sample: { number: N, end_date: 'November 21, 2027', amount: FEE },
  },

  // ---------- employers ----------
  employer_welcome: {
    name: 'Employer ID issued', group: 'Employers', trigger: 'When an employer requests an Employer ID (or an administrator reissues one).',
    subject: 'Your CSBFP Employer ID: {{employer_number}}',
    body: `# Your Employer ID\n\nHi {{first_name}},\n\nHere is the CSBFP Employer ID for **{{company}}**:\n\n**{{employer_number}}**\n\n1. Buy certification credits on the For Employers page ({{amount}} each; one credit covers one person's first year).\n2. Give this ID to your employees. At the payment step, they choose "My employer is paying" and enter it.\n\nAnyone with this ID can use your credits, so share it only with your team. Credits are non-refundable and don't expire.`,
    button: { label: 'Buy credits', path: '/employers#buy' },
    sample: { company: 'ABC Funding', employer_number: 'ER-7KQ2X9', amount: FEE },
  },
  employer_credits_added: {
    name: 'Employer credits purchased (receipt)', group: 'Employers', trigger: 'When an employer\'s credit purchase is paid.',
    subject: 'CSBFP credits added: {{quantity}} for {{employer_number}}',
    body: `# Credits added\n\nHi {{first_name}},\n\n**{{quantity}}** certification credits were added for **{{company}}** ({{employer_number}}). You now have **{{balance}}** credits available.\n\nStripe emails your payment receipt separately.`,
    button: { label: 'Check your balance', path: '/employers#balance' },
    sample: { company: 'ABC Funding', employer_number: 'ER-7KQ2X9', quantity: '10', balance: '10' },
  },

  // ---------- support and privacy ----------
  support_request_received: {
    name: 'Support request received', group: 'Support', trigger: 'After someone submits the contact form or requests data deletion.',
    subject: 'We received your message (CSBFP)',
    body: `# We received your message\n\nHi {{first_name}},\n\nThanks for contacting CSBFP. We received your request about **{{topic}}** and will reply by email, usually within one business day.\n\nYour reference: {{reference}}`,
    sample: { topic: 'account access', reference: 'SR-7F3A21' },
  },
  identity_review_required: {
    name: 'Account recovery / identity review', group: 'Support', trigger: 'Sent by an administrator from a person\'s page.',
    subject: 'Action needed: confirming your CSBFP account details',
    body: `# We need to confirm a few details\n\nHi {{first_name}},\n\nBefore we can continue with your CSBFP application or request, we need to confirm some account details.\n\n{{note}}\n\nPlease reply to this email or contact ${S}. We will never ask for your Social Security number or your full card number by email.`,
    sample: { note: 'Please confirm your legal name and the ZIP code on your application.' },
  },
  data_deleted: {
    name: 'Data deletion completed', group: 'Support', trigger: 'Sent just before an administrator deletes a person\'s data.',
    subject: 'Your CSBFP data has been deleted',
    body: `# Your data has been deleted\n\nHi {{first_name}},\n\nAs you requested, we have deleted the personal information in your CSBFP account. Your certification can no longer be verified and your account has been closed.\n\nWe keep only a minimal record without your name: your retired certification number (so it is never reissued), payment records required for accounting, and the date you agreed to the automatic renewal terms.`,
  },
  program_update: {
    name: 'Program update (announcement)', group: 'Support', trigger: 'Written and sent by an administrator (Admin > Announce).',
    subject: '{{subject}}',
    body: `# {{subject}}\n\nHi {{first_name}},\n\n{{message}}`,
    sample: { subject: 'Updated training for 2027', message: 'We have updated the CSBFP training. You will be asked to complete the new modules before your next renewal.' },
  },

  // ---------- admin ----------
  admin_support_alert: {
    name: 'New support request (to admins)', group: 'Admin', trigger: 'Sent to ADMIN_EMAILS when a support or deletion request arrives.',
    subject: 'New CSBFP support request: {{topic}}',
    body: `# New support request\n\nA new request about **{{topic}}** was received ({{reference}}). Open the admin area to read and answer it.`,
    button: { label: 'Open support requests', path: '/admin/support' },
    sample: { topic: 'billing', reference: 'SR-7F3A21' },
  },
  admin_daily_summary: {
    name: 'Daily summary (to admins)', group: 'Admin', trigger: 'Sent to ADMIN_EMAILS each morning by the daily job.',
    subject: 'CSBFP daily summary: {{date}}',
    body: `# Daily summary\n\n{{date}}, covering the last 24 hours.\n\n**Activity**\n\n- New accounts: {{new_accounts}}\n- New paid applications: {{new_paid}}\n- Renewals paid: {{renewals}}\n- Revenue: {{revenue}}\n\n**Needs attention**\n\n- Awaiting screening or review: {{review}}\n- Inactive (renewal payment failed): {{inactive}}\n- Possible duplicates to review: {{duplicates}}\n- Open support requests: {{support}}\n\n**Totals**\n\n- Certified: {{active}}\n- Accounts: {{accounts}}`,
    button: { label: 'Open admin', path: '/admin/registrants' },
    sample: { date: 'Saturday, November 21, 2026', new_accounts: '42', new_paid: '31', renewals: '0', revenue: '$4,619.00', review: '3', inactive: '0', duplicates: '1', support: '2', active: '31', accounts: '42' },
  },
  admin_sign_in_code: {
    name: 'Admin sign-in code', group: 'Admin', trigger: 'Admin sign-in.',
    subject: 'Your CSBFP admin sign-in code',
    body: `# Admin sign-in code\n\nEnter this code to sign in to the CSBFP administrator area:\n\n{{code}}\n\nThe code expires in 10 minutes and can be used once. If you did not try to sign in, someone may be trying to access the admin area with your email address.`,
    sample: { code: '482913' },
  },
};

module.exports = T;
