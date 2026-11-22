// Mobile menu: the hamburger button opens and closes the header navigation.
(function () {
  function init() {
    var header = document.querySelector('.header');
    var btn = document.querySelector('.menu-toggle');
    var nav = document.getElementById('site-nav');
    if (!header || !btn || !nav) return;
    function setOpen(open) {
      header.classList.toggle('menu-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }
    btn.addEventListener('click', function () { setOpen(!header.classList.contains('menu-open')); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('click', function (e) { if (!header.contains(e.target)) setOpen(false); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

// FAQ: only one answer open at a time (the details "name" attribute does this in current browsers; this covers older ones).
document.addEventListener('toggle', function (e) {
  var d = e.target;
  if (!d.open || d.tagName !== 'DETAILS' || !d.closest('.faq')) return;
  d.closest('.faq').querySelectorAll('details[open]').forEach(function (o) { if (o !== d) o.open = false; });
}, true);

// Phone fields: format U.S. numbers as (555) 555-5555 while typing; at most 10 digits (a leading 1 is dropped).
document.addEventListener('input', function (e) {
  var el = e.target;
  if (!el.matches || !el.matches('input[type=tel]')) return;
  var d = el.value.replace(/\D/g, '');
  if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
  d = d.slice(0, 10);
  var out = d.length === 0 ? '' : d.length <= 3 ? '(' + d : d.length <= 6 ? '(' + d.slice(0, 3) + ') ' + d.slice(3) : '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  if (out !== el.value) el.value = out;
});

// One-time notices (?saved=1) shouldn't come back on refresh: drop the flag from the address bar once shown.
(function () {
  try {
    var url = new URL(window.location.href);
    if (url.searchParams.has('saved')) {
      url.searchParams.delete('saved');
      window.history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
    }
  } catch (e) { /* older browsers: leave the URL as is */ }
}());
