// "Print or Save as PDF" button (inline handlers are blocked by the content security policy).
document.addEventListener('click', function (e) { if (e.target.closest('[data-print]')) window.print(); });
