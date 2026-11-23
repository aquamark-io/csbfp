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
 *   @cash Working capital               -> icon tiles in a row (consecutive lines; icon names in ICONS below)
 *   + Funder | Provides the capital     -> columns side by side, each with a blue header band (consecutive lines)
 *   A table whose first header cell is empty is a comparison: row labels down the left, and a header cell may
 *   start with @icon (e.g. | | @bank Traditional bank | @clock Alternative finance |)
 *   ~ text                              -> a small note
 *   -> Request | The business asks...   -> a timeline beside one long arrow pointing down (consecutive lines)
 *   $ Purchase price | $50,000 | text   -> large figures side by side, joined by arrows (consecutive lines)
 *   = Term | definition                 -> a two-column list of key terms (consecutive lines)
 *   ? Question | Answer                 -> a quick check: the answer stays hidden until "Show answer" is clicked
 *   blank line                          -> new paragraph
 */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// **bold** and [text](https://...) links. Links must be https; they open in a new tab.
const inline = s => esc(s)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\((https:\/\/[^\s)"<>]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

// Line icons for icon rows (24x24, drawn with the current colour).
const ICONS = {
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  equipment: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2c2.9.4 5 2.9 5 5.8"/>',
  growth: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  shield: '<path d="M12 3 4 6v6c0 4.4 3.4 8.2 8 9 4.6-.8 8-4.6 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  document: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M8 13h8M8 17h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  store: '<path d="M4 4h16l1 5H3z"/><path d="M5 9v11h14V9M10 20v-6h4v6"/>',
  broker: '<circle cx="12" cy="7" r="3"/><path d="M6 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M3 11h3M4.5 9.5 3 11l1.5 1.5M21 11h-3M19.5 9.5 21 11l-1.5 1.5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  bank: '<path d="M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
};
const icon = name => ICONS[name] ? `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>` : '';

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
    if ((m = /^@([a-z-]+)\s+(.*)$/.exec(line))) {
      flush();
      const last = blocks[blocks.length - 1];
      const item = { icon: m[1], text: m[2].trim() };
      if (last && last.type === 'icons') last.items.push(item); else blocks.push({ type: 'icons', items: [item] });
      continue;
    }
    if ((m = /^\+\s+(.*?)\s+\|\s+(.*)$/.exec(line))) {
      flush();
      const last = blocks[blocks.length - 1];
      const item = { text: m[1].trim(), body: m[2].trim() };
      if (last && last.type === 'columns') last.items.push(item); else blocks.push({ type: 'columns', items: [item] });
      continue;
    }
    if ((m = /^->\s+(.*?)\s+\|\s+(.*)$/.exec(line))) {
      flush();
      const last = blocks[blocks.length - 1];
      const item = { text: m[1].trim(), body: m[2].trim() };
      if (last && last.type === 'timeline') last.items.push(item); else blocks.push({ type: 'timeline', items: [item] });
      continue;
    }
    if ((m = /^\$\s+(.*?)\s+\|\s+(.*?)\s+\|\s+(.*)$/.exec(line))) {
      flush();
      const last = blocks[blocks.length - 1];
      const item = { text: m[1].trim(), value: m[2].trim(), body: m[3].trim() };
      if (last && last.type === 'figures') last.items.push(item); else blocks.push({ type: 'figures', items: [item] });
      continue;
    }
    if ((m = /^=\s+(.*?)\s+\|\s+(.*)$/.exec(line))) {
      flush();
      const last = blocks[blocks.length - 1];
      const item = { text: m[1].trim(), body: m[2].trim() };
      if (last && last.type === 'terms') last.items.push(item); else blocks.push({ type: 'terms', items: [item] });
      continue;
    }
    if ((m = /^\?\s+(.*?)\s+\|\s+(.*)$/.exec(line))) { flush(); blocks.push({ type: 'quickcheck', text: m[1].trim(), body: m[2].trim() }); continue; }
    if ((m = /^~\s+(.*)$/.exec(line))) { flush(); blocks.push({ type: 'note', text: m[1].trim() }); continue; }
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
    const compare = Boolean(head && head[0] === '');
    const th = c => {
      const m = compare && /^@([a-z-]+)\s+(.*)$/.exec(c);
      return m ? `<th scope="col"><span class="icon-tile">${icon(m[1])}</span>${inline(m[2])}</th>` : `<th${compare ? ' scope="col"' : ''}>${inline(c)}</th>`;
    };
    const thead = head ? `<thead><tr>${head.map(th).join('')}</tr></thead>` : '';
    // Each comparison cell carries its column name, so on a phone a row can stack as "Column: value" lines.
    const colName = k => (head && head[k] ? head[k].replace(/^@[a-z-]+\s+/, '') : '');
    const row = r => `<tr>${r.map((c, k) => compare && k === 0 ? `<th scope="row">${inline(c)}</th>`
      : compare ? `<td data-label="${esc(colName(k))}">${inline(c)}</td>` : `<td>${inline(c)}</td>`).join('')}</tr>`;
    return `<div class="table-wrap"><table class="md-table${compare ? ' md-compare' : ''}">${thead}<tbody>${body.map(row).join('')}</tbody></table></div>`;
  }
  if (b.type === 'icons') return `<ul class="icon-row">${b.items.map(i => `<li><span class="icon-tile">${icon(i.icon)}</span><span>${inline(i.text)}</span></li>`).join('')}</ul>`;
  if (b.type === 'columns') return `<ul class="columns cols-${Math.min(b.items.length, 6)}">${b.items.map(i => `<li><p class="columns-head">${inline(i.text)}</p><p>${inline(i.body)}</p></li>`).join('')}</ul>`;
  if (b.type === 'timeline') return `<ol class="timeline">${b.items.map(i => `<li><p class="tl-title">${inline(i.text)}</p><p>${inline(i.body)}</p></li>`).join('')}</ol>`;
  if (b.type === 'figures') return `<div class="figures">${b.items.map((i, k) => `${k ? '<span class="fig-arrow" aria-hidden="true"></span>' : ''}<div class="figure"><p class="fig-label">${inline(i.text)}</p><p class="fig-value">${inline(i.value)}</p><p>${inline(i.body)}</p></div>`).join('')}</div>`;
  if (b.type === 'terms') return `<dl class="terms">${b.items.map(i => `<div><dt>${inline(i.text)}</dt><dd>${inline(i.body)}</dd></div>`).join('')}</dl>`;
  if (b.type === 'quickcheck') return `<details class="quick-check"><summary><span class="qc-label">Quick check</span><span class="qc-q">${inline(b.text)}</span><span class="qc-show" aria-hidden="true"></span></summary><p>${inline(b.body)}</p></details>`;
  if (b.type === 'note') return `<p class="note">${inline(b.text)}</p>`;
  if (b.type === 'statement') return `<p class="statement">${inline(b.text)}</p>`;
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
function renderSlides(md) {
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
  return slides.map((sl, i) => {
    const head = sl.heading ? `<h2>${inline(sl.heading)}</h2>` : '';
    if (i === 0 && !sl.heading) {
      return `<section class="slide slide-letter" data-slide="1"><div class="letter"><img class="letter-logo" src="/img/csbfp-logo.png" alt="" width="104" height="54">${render(sl.blocks)}</div></section>`;
    }
    return `<section class="slide" data-slide="${i + 1}">${head}${render(sl.blocks)}</section>`;
  }).join('\n');
}

// "- " lines of a document, e.g. acknowledgment statements.
const listItems = md => blocksOf(md).filter(b => b.type === 'ul').flatMap(b => b.items);

module.exports = { render, renderSlides, listItems, esc };
