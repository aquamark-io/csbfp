/**
 * A small, safe Markdown renderer for admin-written content (training modules, legal documents).
 * Everything is HTML-escaped first; only the formatting below is produced, so admin text can never inject markup.
 *
 *   ## Heading / ### Subheading (a new slide in training) / #### Subheading within the same slide
 *   ### Remember / In practice / Example / Core Standard -> a styled callout containing the paragraphs/list that follow,
 *                                          up to the next heading
 *   - list item                         -> bulleted list (consecutive lines)
 *   1. list item                        -> numbered list
 *   | A | B |  (header row, then |---|---|, then rows) -> table
 *   **bold**,  [link text](https://example.com)
 *   Goal: ...                           -> highlighted lead paragraph
 *   > text                              -> a large highlighted statement
 *   = Term | definition                 -> a two-column list of key terms (consecutive lines)
 *   blank line                          -> new paragraph
 */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// **bold** and [text](https://...) links. Links must be https; they open in a new tab.
const inline = s => esc(s)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\((https:\/\/[^\s)"<>]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

const CALLOUTS = { remember: 'Remember', 'in practice': 'In practice', example: 'Example', important: 'Important', 'core standard': 'Core Standard' };

function blocksOf(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = []; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flush(); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const last = blocks[blocks.length - 1];
      if (cells.every(c => /^:?-{3,}:?$/.test(c))) { if (last && last.type === 'table') last.sep = true; continue; }
      if (last && last.type === 'table') last.rows.push(cells); else blocks.push({ type: 'table', rows: [cells], sep: false });
      continue;
    }
    if ((m = /^(#{2,4})\s+(.*)$/.exec(line))) { flush(); blocks.push({ type: ['h2', 'h3', 'h4'][m[1].length - 2], text: m[2].trim() }); continue; }
    if ((m = /^=\s+(.*?)\s+\|\s+(.*)$/.exec(line))) {
      flush();
      const last = blocks[blocks.length - 1];
      const item = { text: m[1].trim(), body: m[2].trim() };
      if (last && last.type === 'terms') last.items.push(item); else blocks.push({ type: 'terms', items: [item] });
      continue;
    }
    if ((m = /^>\s*(.*)$/.exec(line))) { flush(); blocks.push({ type: 'statement', text: m[1].trim() }); continue; }
    if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'ul') last.items.push(m[1]); else blocks.push({ type: 'ul', items: [m[1]] });
      continue;
    }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'ol') last.items.push(m[1]); else blocks.push({ type: 'ol', items: [m[1]] });
      continue;
    }
    // A continuation line of a list item (indented) joins the previous item.
    const last = blocks[blocks.length - 1];
    if (!para.length && last && (last.type === 'ul' || last.type === 'ol') && /^\s{2,}\S/.test(raw)) {
      last.items[last.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

function renderBlock(b) {
  if (b.type === 'h2') return `<h2 id="${b.text.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}">${inline(b.text)}</h2>`;
  if (b.type === 'h3') return `<h3>${inline(b.text)}</h3>`;
  if (b.type === 'h4') return `<h3 class="subhead">${inline(b.text)}</h3>`;
  if (b.type === 'ul') return `<ul>${b.items.map(i => `<li>${inline(i)}</li>`).join('')}</ul>`;
  if (b.type === 'table') {
    const [head, ...body] = b.sep ? b.rows : [null, ...b.rows];
    const thead = head ? `<thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead>` : '';
    return `<div class="table-wrap"><table class="md-table">${thead}<tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  // Labels with a colon (e.g. "2008–2014: The Post-Crisis Void") read as headings: stack them above the text.
  if (b.type === 'terms') return `<dl class="terms${b.items.some(i => /:\s/.test(i.text)) ? ' stacked' : ''}">${b.items.map(i => `<div><dt>${inline(i.text)}</dt><dd>${inline(i.body)}</dd></div>`).join('')}</dl>`;
  if (b.type === 'statement') return `<p class="statement">${inline(b.text)}</p>`;
  // A numbered list of "Step | description" items renders as a process timeline.
  if (b.type === 'ol' && b.items.every(i => i.includes(' | '))) {
    return `<ol class="process">${b.items.map(i => { const [t, ...rest] = i.split(' | '); return `<li><strong>${inline(t.trim())}</strong><span>${inline(rest.join(' | ').trim())}</span></li>`; }).join('')}</ol>`;
  }
  if (b.type === 'ol') return `<ol>${b.items.map(i => `<li>${inline(i)}</li>`).join('')}</ol>`;
  if (/^Goal:\s/.test(b.text)) return `<p class="goal"><strong>Goal:</strong> ${inline(b.text.replace(/^Goal:\s*/, ''))}</p>`;
  return `<p>${inline(b.text)}</p>`;
}

function render(md) {
  const blocks = Array.isArray(md) ? md : blocksOf(md);
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const key = b.type === 'h3' ? b.text.toLowerCase() : null;
    if (key && CALLOUTS[key]) {
      const inner = [];
      while (i + 1 < blocks.length && !['h2', 'h3', 'h4'].includes(blocks[i + 1].type)) inner.push(renderBlock(blocks[++i]));
      out.push(`<aside class="callout callout-${key.replace(/\s+/g, '-')}"><p class="callout-title">${CALLOUTS[key]}</p>${inner.join('')}</aside>`);
    } else {
      out.push(renderBlock(b));
    }
  }
  return out.join('\n');
}

/**
 * Training slides: a new slide starts at every ## heading and at every ### heading that isn't a callout.
 * A ### slide carries its parent ## heading as a small label. Text before the first heading is its own slide, with no
 * heading, styled as a letter.
 * Returns HTML sections; the page shows them one at a time when JavaScript runs, or stacked otherwise.
 */
function renderSlides(md, { cover = '' } = {}) {
  const blocks = blocksOf(md);
  const slides = [];
  let cur = null;
  let section = '';
  const start = (heading, label) => { cur = { heading, label, blocks: [] }; slides.push(cur); };
  for (const b of blocks) {
    const isCallout = b.type === 'h3' && CALLOUTS[b.text.toLowerCase()];
    if (b.type === 'h2') { section = b.text; start(b.text, ''); continue; }
    if (b.type === 'h3' && !isCallout) {
      // A section heading with nothing under it would be an empty slide: let its first sub-heading take its place.
      if (cur && cur.heading === section && !cur.blocks.length) { cur.heading = b.text; cur.label = section; continue; }
      start(b.text, section); continue;
    }
    if (!cur) start('', '');
    cur.blocks.push(b);
  }
  // Optional cover: the module title on the program blue, shown before the first slide.
  const offset = cover ? 1 : 0;
  const coverHtml = cover ? `<section class="slide slide-cover" data-slide="1"><h2>${esc(cover)}</h2></section>\n` : '';
  return coverHtml + slides.map((sl, i) => {
    const head = sl.heading ? `<h2>${inline(sl.heading)}</h2>` : '';
    if (i === 0 && !sl.heading) {
      return `<section class="slide slide-letter" data-slide="${1 + offset}"><div class="letter"><img class="letter-logo" src="/img/csbfp-logo.png" alt="" width="104" height="54">${render(sl.blocks)}</div></section>`;
    }
    return `<section class="slide" data-slide="${i + 1 + offset}">${head}${render(sl.blocks)}</section>`;
  }).join('\n');
}

// "- " lines of a document, e.g. acknowledgment statements.
const listItems = md => blocksOf(md).filter(b => b.type === 'ul').flatMap(b => b.items);

module.exports = { render, renderSlides, listItems, esc };
