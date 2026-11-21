// Formatting helpers available in every template (app.locals). Times are shown in Pacific time.
const TZ = 'America/Los_Angeles';
const STATUS = { pending: 'Pending', active: 'Active', inactive: 'Inactive', expired: 'Expired' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = {
  fmtDate: d => (d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: TZ }) : '—'),
  fmtTime: d => (d ? `${new Date(d).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ })} PT` : '—'),
  fmtMonth: d => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : ''),
  fmtPhone: p => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p || ''); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (p || '—'); },
  fullName: r => (r ? ([r.legal_first_name, r.middle_name, r.legal_last_name].filter(Boolean).join(' ') || '(name not entered)') : '(unknown)'),
  // Returns HTML; inputs are escaped.
  statusPill: (status, hold) => `<span class="status status-${esc(status || 'pending')}">${STATUS[status] || 'Pending'}</span>${hold ? ' <span class="status status-hold">On hold</span>' : ''}`,
};
