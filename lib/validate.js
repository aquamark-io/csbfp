/**
 * Server-side validation and normalization for portal forms.
 * Each validator returns { errors: { field: message }, data: {...normalized} }.
 */

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const RELATIONSHIP_TYPES = {
  employee: 'Employee',
  contractor_1099: 'Independent contractor',
  self_employed: 'Self-employed',
};

const WORK_ARRANGEMENTS = { remote: 'Remote', hybrid: 'Hybrid', on_site: 'On-site' };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

const str = v => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
const asArray = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

function text(errors, field, value, label, { required = true, max = 100 } = {}) {
  const v = str(value);
  if (!v) { if (required) errors[field] = `${label} is required.`; return null; }
  if (v.length > max) { errors[field] = `${label} must be ${max} characters or fewer.`; return null; }
  return v;
}

function normEmail(value) {
  return str(value).toLowerCase();
}

function validEmail(v) {
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(v);
}

// U.S. mobile numbers only for now: 10 digits, optional leading 1. Stored as +1XXXXXXXXXX.
function normPhone(value) {
  let d = String(value || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10 || /^[01]/.test(d)) return null;
  return `+1${d}`;
}

const fmtPhone = v => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(v || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (v || '');
};

// Month + year selects -> 'YYYY-MM-01'. Not in the future, not before 1950.
function monthYear(errors, field, month, year, label, { required = true } = {}) {
  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  if (!month && !year) { if (required) errors[field] = `${label} is required.`; return null; }
  if (!(m >= 1 && m <= 12) || !(y >= 1950 && y <= 2100)) { errors[field] = `Please choose a month and year for ${label.toLowerCase()}.`; return null; }
  const now = new Date();
  if (y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth() + 1)) {
    errors[field] = `${label} can't be in the future.`;
    return null;
  }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

function ageOn(dobIso, today = new Date()) {
  const [y, m, d] = dobIso.split('-').map(Number);
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age -= 1;
  return age;
}

function validateSignup(body) {
  const errors = {};
  const email = normEmail(body.email);
  if (!email) errors.email = 'Email is required.';
  else if (!validEmail(email)) errors.email = 'Please enter a valid email address.';
  const phone = normPhone(body.phone);
  if (!str(body.phone)) errors.phone = 'Mobile phone number is required.';
  else if (!phone) errors.phone = 'Please enter a 10-digit U.S. mobile number.';
  if (body.agree !== 'yes') errors.agree = 'Please agree to the Program Terms and Privacy Policy.';
  return { errors, data: { email, phone } };
}

function validatePersonal(body) {
  const errors = {};
  const data = {
    legal_first_name: text(errors, 'legal_first_name', body.legal_first_name, 'Legal first name', { max: 60 }),
    middle_name: text(errors, 'middle_name', body.middle_name, 'Middle name', { required: false, max: 60 }),
    legal_last_name: text(errors, 'legal_last_name', body.legal_last_name, 'Legal last name', { max: 60 }),
  };

  const dob = str(body.dob);
  if (!dob) errors.dob = 'Date of birth is required.';
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(`${dob}T00:00:00Z`))) errors.dob = 'Please enter a valid date of birth.';
  else if (Number(dob.slice(0, 4)) < 1900) errors.dob = 'Please enter a valid date of birth.';
  else if (ageOn(dob) < 18) errors.dob = 'You must be 18 or older to apply.';
  else data.dob = dob;

  const zip = str(body.zip5);
  if (!zip) errors.zip5 = 'ZIP code is required.';
  else if (!/^\d{5}$/.test(zip)) errors.zip5 = 'Please enter a 5-digit ZIP code.';
  else data.zip5 = zip;

  const phone = normPhone(body.phone);
  if (!str(body.phone)) errors.phone = 'Mobile phone number is required.';
  else if (!phone) errors.phone = 'Please enter a 10-digit U.S. mobile number.';
  else data.phone_e164 = phone;

  data.industry_start_month = monthYear(errors, 'industry_start', body.industry_start_month, body.industry_start_year, 'Industry start date');
  return { errors, data };
}

// CSBFP is for brokers, funders and lenders: these are the only company types offered.
const COMPANY_TYPES = {
  broker: 'Brokerage only',
  funder_lender: 'Funder/Lender only',
  funder_with_sales: 'Funder with sales division',
  broker_with_funding: 'Brokerage with funding division',
};
// Labels for every type ever stored, so records saved before the scope change still display.
const COMPANY_TYPE_LABELS = {
  ...COMPANY_TYPES,
  service_provider: 'Service Provider',
  technology_provider: 'Technology / Software Provider',
  other: 'Other',
};
const PRIMARY_ROLES = {
  owner_executive: 'Owner / Executive',
  sales_bizdev: 'Sales / Business Development',
  sales_management: 'Sales Management',
  underwriting_credit: 'Underwriting / Credit',
  operations: 'Operations',
  funding_processing: 'Funding / Processing',
  servicing_collections: 'Servicing / Collections',
  compliance_risk: 'Compliance / Risk',
  legal: 'Legal',
  technology_it: 'Technology / IT',
  marketing: 'Marketing',
  administrative_support: 'Administrative / Support',
  other: 'Other',
};
const NOT_INVOLVED_PRODUCT = 'Not directly involved with financing products';

function validateRelationship(body) {
  const errors = {};
  const data = {};
  data.relationship_type = Object.hasOwn(RELATIONSHIP_TYPES, body.relationship_type) ? body.relationship_type : null;
  if (!data.relationship_type) errors.relationship_type = 'Please choose how you work with this company.';
  data.company_name = text(errors, 'company_name', body.company_name, 'Company name', { max: 120 });

  const site = str(body.company_website);
  if (site) {
    try {
      const u = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`);
      if (!u.hostname.includes('.')) throw new Error('no dot');
      data.company_website = u.origin;
    } catch {
      errors.company_website = 'Please enter a valid website, for example example.com.';
    }
  } else {
    data.company_website = null;
  }

  data.start_month = monthYear(errors, 'start', body.start_month, body.start_year, 'Start date');
  data.work_arrangement = Object.hasOwn(WORK_ARRANGEMENTS, body.work_arrangement) ? body.work_arrangement : null;
  if (!data.work_arrangement) errors.work_arrangement = 'Please choose a work arrangement.';

  // Pick lists only, so the data stays consistent.
  data.company_type = Object.hasOwn(COMPANY_TYPES, body.company_type) ? body.company_type : null;
  if (!data.company_type) errors.company_type = 'Please choose the company type.';
  data.primary_role = Object.hasOwn(PRIMARY_ROLES, body.primary_role) ? body.primary_role : null;
  if (!data.primary_role) errors.primary_role = 'Please choose your primary role.';
  data.primary_role_other = null;

  // Phase 1 records current employers only.
  data.is_current = true;
  data.end_month = null;
  return { errors, data };
}

// productIds: Map of id -> label. "Not directly involved" can't be combined with a product.
function validateProducts(body, productIds) {
  const errors = {};
  const products = [...new Set(asArray(body.products).map(n => parseInt(n, 10)).filter(n => productIds.has(n)))];
  const none = products.filter(id => productIds.get(id) === NOT_INVOLVED_PRODUCT);
  if (!products.length) errors.products = 'Please choose at least one product.';
  else if (none.length && products.length > 1) errors.products = `Choose either "${NOT_INVOLVED_PRODUCT}" or the products you work with, not both.`;
  return { errors, data: { products } };
}

module.exports = {
  STATES, RELATIONSHIP_TYPES, WORK_ARRANGEMENTS, MONTHS, PRIMARY_ROLES, COMPANY_TYPES, COMPANY_TYPE_LABELS, NOT_INVOLVED_PRODUCT,
  normEmail, validEmail, normPhone, fmtPhone, ageOn,
  validateSignup, validatePersonal, validateRelationship, validateProducts,
};
