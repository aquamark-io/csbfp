// Training modules as slides: one section at a time with Back/Next, a progress bar,
// arrow keys and swipe. Without JavaScript every slide simply shows, stacked.
(function () {
  function init() {
    var deck = document.querySelector('[data-deck]');
    if (!deck) return;
    var slides = Array.prototype.slice.call(deck.querySelectorAll('.slide'));
    var end = document.querySelector('[data-deck-end]');
    if (slides.length < 2) { deck.classList.add('deck-single'); return; }
    var prev = deck.querySelector('[data-prev]'), next = deck.querySelector('[data-next]'), finish = deck.querySelector('[data-finish]');
    var bar = deck.querySelector('.deck-bar span'), count = deck.querySelector('.deck-count');
    var i = 0;
    var m = /^#s(\d+)$/.exec(location.hash);
    if (m) i = Math.min(Math.max(parseInt(m[1], 10) - 1, 0), slides.length - 1);
    // Assessment: open on the first unanswered question after a failed submit, and
    // only allow Next once the current question is answered.
    var firstMissing = slides.findIndex(function (sl) { return sl.classList.contains('unanswered'); });
    if (firstMissing >= 0) i = firstMissing;
    var needAnswer = deck.hasAttribute('data-require-answer');
    function answered(sl) { return !sl.querySelector('input[type=radio]') || !!sl.querySelector('input[type=radio]:checked'); }
    if (needAnswer) deck.addEventListener('change', function () { show(i, false); });
    // Submitting with a gap: go to the first unanswered question and say so (instead of a dead button).
    var form = deck.closest('form');
    if (needAnswer && form) form.addEventListener('submit', function (e) {
      var k = slides.findIndex(function (sl) { return !answered(sl); });
      if (k < 0) return;
      e.preventDefault();
      slides.forEach(function (sl) { sl.classList.toggle('unanswered', !answered(sl)); });
      var left = slides.filter(function (sl) { return !answered(sl); }).length;
      var note = deck.querySelector('.deck-note');
      if (!note) { note = document.createElement('p'); note.className = 'alert deck-note'; note.setAttribute('role', 'alert'); deck.insertBefore(note, deck.firstChild); }
      note.textContent = 'Please answer every question (' + left + (left === 1 ? ' is' : ' are') + ' unanswered). Here is the first one.';
      show(k, true);
    });
    deck.addEventListener('change', function (e) { var sl = e.target.closest('.slide'); if (sl) sl.classList.remove('unanswered'); });
    deck.classList.add('deck-on');
    if (end) end.classList.add('deck-hide');

    function show(n, scroll) {
      i = Math.min(Math.max(n, 0), slides.length - 1);
      slides.forEach(function (s, k) { s.hidden = k !== i; });
      var last = i === slides.length - 1;
      prev.disabled = i === 0;
      if (needAnswer) next.disabled = !answered(slides[i]);
      next.hidden = last;
      if (finish) finish.hidden = !last;
      bar.style.width = ((i + 1) / slides.length * 100) + '%';
      count.textContent = (i + 1) + ' of ' + slides.length;
      if (history.replaceState) history.replaceState(null, '', '#s' + (i + 1));
      if (scroll) {
        var top = deck.getBoundingClientRect().top + window.pageYOffset - 110;
        if (window.pageYOffset > top) window.scrollTo({ top: top, behavior: 'smooth' });
      }
    }
    prev.addEventListener('click', function () { show(i - 1, true); });
    next.addEventListener('click', function () { show(i + 1, true); });
    document.addEventListener('keydown', function (e) {
      if (e.target.closest('input, textarea, select') || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === 'ArrowRight') show(i + 1, true);
      if (e.key === 'ArrowLeft') show(i - 1, true);
    });
    var x0 = null, y0 = null;
    deck.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    deck.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) show(i + (dx < 0 ? 1 : -1), true);
      x0 = null;
    }, { passive: true });
    show(i, false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
