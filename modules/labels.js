// modules/labels.js — label grid, barcode/QR print, PDF download
import { db } from '../db.js';
import {
  state, $, fmtMoney, todayISO, nowISO, escapeHTML, toast,
  openModal, canonicalCategory, debounce, makeQRPayload,
  downloadBlob, registerTabRenderer, encodeCostCode,
  refreshProducts,
} from './core.js';

// Basic label prints the customer-facing price under the "MRP" heading.
// Use Our Price (what the customer actually pays) if set; fall back to sellingPrice.
const _labelPrice = (p) =>
  (p?.ourPrice != null && p?.ourPrice !== '') ? Number(p.ourPrice) : (p?.sellingPrice ?? 0);

function _labelsList() {
  const q   = $('#labels-search').value.trim().toLowerCase();
  const cat = $('#labels-category').value;
  return state.products.filter(p => {
    if (cat && canonicalCategory(p.category) !== cat) return false;
    return !q || (p.name || '').toLowerCase().includes(q) || (p.shortCode || '').toLowerCase().includes(q);
  });
}

function _updateLabelsSelectedCount() {
  $('#labels-selected-count').textContent = `${state.selectedLabels.size} selected`;
}

export function renderLabels() {
  const list = _labelsList();
  const grid = $('#labels-grid');
  grid.innerHTML = list.map(p => {
    const checked = state.selectedLabels.has(p.id);
    return `
      <div class="label-card ${checked ? 'ring-2 ring-blue-500' : ''}" data-toggle="${p.id}">
        <label class="picker">
          <input type="checkbox" ${checked ? 'checked' : ''} data-check="${p.id}" />
        </label>
        <div class="name">${escapeHTML(p.name)}</div>
        <div class="codes">
          <canvas data-barcode="${p.id}" width="90" height="40"></canvas>
          <canvas data-qr="${p.id}" width="70" height="70"></canvas>
        </div>
        <div class="shortcode">${escapeHTML(p.shortCode)}</div>
        <div class="mrp">MRP ${fmtMoney(_labelPrice(p))}</div>
      </div>`;
  }).join('');

  list.forEach(p => {
    const bc = grid.querySelector(`[data-barcode="${p.id}"]`);
    const qc = grid.querySelector(`[data-qr="${p.id}"]`);
    try { if (bc && window.JsBarcode) JsBarcode(bc, p.shortCode, { format: 'CODE128', displayValue: false, margin: 0, height: 35, width: 1.4 }); } catch {}
    try { if (qc && window.QRCode) QRCode.toCanvas(qc, makeQRPayload(p), { width: 70, margin: 1 }); } catch {}
  });

  grid.querySelectorAll('[data-check]').forEach(cb => cb.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = +cb.dataset.check;
    if (cb.checked) state.selectedLabels.add(id); else state.selectedLabels.delete(id);
    _updateLabelsSelectedCount();
  }));
  grid.querySelectorAll('[data-toggle]').forEach(card => card.addEventListener('click', (e) => {
    if (e.target.matches('input,label')) return;
    const id = +card.dataset.toggle;
    if (state.selectedLabels.has(id)) state.selectedLabels.delete(id); else state.selectedLabels.add(id);
    renderLabels();
  }));
  _updateLabelsSelectedCount();
}

// ---- Printable HTML label sheet ----
// Read the print-layout controls from the labels tab
function _readPrintOptions() {
  const layout = $('#labels-layout')?.value || 'layout-3x8';
  const borders = !!$('#labels-borders')?.checked;
  const copies  = Math.max(1, Math.min(100, parseInt($('#labels-copies')?.value || '1', 10) || 1));
  return { layout, borders, copies };
}

async function _renderLabelsToPrintArea(ids) {
  const items  = ids.map(id => state.products.find(p => p.id === id)).filter(Boolean);
  const blocks = await Promise.all(items.map(async (p) => {
    let bcImg = '';
    try {
      const c = document.createElement('canvas');
      JsBarcode(c, p.shortCode, { format: 'CODE128', displayValue: false, margin: 0, height: 50, width: 2 });
      bcImg = c.toDataURL('image/png');
    } catch {}
    let qrImg = '';
    try { qrImg = await QRCode.toDataURL(makeQRPayload(p), { width: 220, margin: 1 }); } catch {}
    const cc = p.costCode && (state.settings.costCodeAlphabet || '').length === 10
      ? p.costCode.toUpperCase()
      : '';
    return `
      <div class="label-card">
        <div class="name">${escapeHTML(p.name)}</div>
        <div class="codes">
          ${bcImg ? `<img src="${bcImg}" alt="barcode" />` : ''}
          ${qrImg ? `<img src="${qrImg}" alt="qr" class="lbl-qr" />` : ''}
        </div>
        <div class="shortcode">${escapeHTML(p.shortCode)}</div>
        ${cc ? `<div class="shortcode" style="font-size:9px;letter-spacing:1px">${escapeHTML(cc)}</div>` : ''}
        <div class="mrp">MRP ${fmtMoney(_labelPrice(p))}</div>
      </div>`;
  }));
  const { layout, borders, copies } = _readPrintOptions();
  // Repeat each label "copies" times so the user can fill a sheet without re-selecting
  const allBlocks = [];
  for (let n = 0; n < copies; n++) allBlocks.push(...blocks);
  $('#print-area').innerHTML = `<div class="print-labels ${layout} ${borders ? 'with-borders' : ''}">${allBlocks.join('')}</div>`;
}

export async function showSingleLabel(productId) {
  const p = state.products.find(x => x.id === productId);
  if (!p) return;
  const box = $('#label-preview');
  box.dataset.productId = productId;
  const cc = p.costCode && (state.settings.costCodeAlphabet || '').length === 10
    ? p.costCode.toUpperCase()
    : '';
  box.innerHTML = `
    <div class="label-card" style="min-width:220px">
      <div class="name">${escapeHTML(p.name)}</div>
      <div class="codes">
        <canvas id="lbl-bc" width="140" height="50"></canvas>
        <canvas id="lbl-qr" width="90" height="90"></canvas>
      </div>
      <div class="shortcode">${escapeHTML(p.shortCode)}</div>
      ${cc ? `<div class="shortcode" style="font-size:9px;letter-spacing:1px">${escapeHTML(cc)}</div>` : ''}
      <div class="mrp">MRP ${fmtMoney(_labelPrice(p))}</div>
    </div>`;
  openModal('modal-label');
  setTimeout(() => {
    try { JsBarcode('#lbl-bc', p.shortCode, { format: 'CODE128', displayValue: false, margin: 0, height: 45, width: 1.8 }); } catch {}
    try { QRCode.toCanvas($('#lbl-qr'), makeQRPayload(p), { width: 90, margin: 1 }); } catch {}
  }, 50);
}

async function _printSelectedLabels() {
  const ids = Array.from(state.selectedLabels);
  if (!ids.length) return toast('Select labels first', 'error');
  await _renderLabelsToPrintArea(ids);
  setTimeout(() => window.print(), 80);
}

// ---- Detailed label (MRP, Our Price, Code, ShortCode) ----
async function _renderDetailedLabelsToPrintArea(ids) {
  const items  = ids.map(id => state.products.find(p => p.id === id)).filter(Boolean);
  const blocks = await Promise.all(items.map(async (p) => {
    let bcImg = '';
    try {
      const c = document.createElement('canvas');
      JsBarcode(c, p.shortCode, { format: 'CODE128', displayValue: false, margin: 0, height: 36, width: 1.5 });
      bcImg = c.toDataURL('image/png');
    } catch {}
    const cc = (p.costCode  || '').toString().trim();
    const fx = (p.fixedCode || '').toString().trim();
    return `
      <div class="label-card detailed-label">
        <div class="dl-name">${escapeHTML(p.name)}</div>
        <div class="dl-mrp"><span class="dl-lbl">MRP</span> <span class="dl-val">${fmtMoney(p.sellingPrice)}</span></div>
        ${p.ourPrice != null ? `<div class="dl-ourprice"><span class="dl-lbl">Our price</span> <span>${fmtMoney(p.ourPrice)}</span></div>` : ''}
        <div class="dl-codes">
          <span class="dl-fx">${fx ? `FP: <span class="dl-fx-val">${escapeHTML(fx.toUpperCase())}</span>` : ''}</span>
          <span class="dl-cc">${cc ? `<span class="dl-cc-lbl">Code:</span> <span class="dl-cc-val">${escapeHTML(cc.toUpperCase())}</span>` : ''}</span>
        </div>
        ${bcImg ? `<img src="${bcImg}" alt="barcode" class="dl-barcode" />` : ''}
        <div class="dl-shortcode">${escapeHTML(p.shortCode)}</div>
      </div>`;
  }));
  const { layout, borders, copies } = _readPrintOptions();
  const allBlocks = [];
  for (let n = 0; n < copies; n++) allBlocks.push(...blocks);
  $('#print-area').innerHTML = `<div class="print-labels detailed ${layout} ${borders ? 'with-borders' : ''}">${allBlocks.join('')}</div>`;
}

async function _printSelectedDetailedLabels() {
  const ids = Array.from(state.selectedLabels);
  if (!ids.length) return toast('Select labels first', 'error');
  await _renderDetailedLabelsToPrintArea(ids);
  setTimeout(() => window.print(), 80);
}

// PDF sheet layouts — match the HTML print layouts in styles.css
const _PDF_LAYOUTS = {
  'layout-3x8':  { cols: 3, rows: 8,  margX: 8,   margY: 8,  name: '3×8' },
  'layout-5x13': { cols: 5, rows: 13, margX: 6,   margY: 8,  name: '5×13' },
  'layout-4x12': { cols: 4, rows: 12, margX: 7,   margY: 8,  name: '4×12' },
  'layout-2x7':  { cols: 2, rows: 7,  margX: 8,   margY: 8,  name: '2×7' },
  'layout-3x10': { cols: 3, rows: 10, margX: 8,   margY: 8,  name: '3×10' },
  'layout-1x1':  { cols: 1, rows: 1,  margX: 10,  margY: 10, name: '1×1' },
  'layout-fit':  { cols: 3, rows: 8,  margX: 8,   margY: 8,  name: 'Auto' },
};

async function _downloadLabelsPDF(ids) {
  ids = ids || Array.from(state.selectedLabels);
  if (!ids.length) return toast('Select labels first', 'error');
  const itemsOnce = ids.map(id => state.products.find(p => p.id === id)).filter(Boolean);
  if (!itemsOnce.length) return;

  const { layout, borders, copies } = _readPrintOptions();
  const cfg = _PDF_LAYOUTS[layout] || _PDF_LAYOUTS['layout-3x8'];
  // Duplicate per "copies" so the user can fill a sheet without re-selecting
  const items = [];
  for (let n = 0; n < copies; n++) items.push(...itemsOnce);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const PAGE_W = 210, PAGE_H = 297;
  const { cols, rows, margX, margY } = cfg;
  const cellW = (PAGE_W - margX * 2) / cols;
  const cellH = (PAGE_H - margY * 2) / rows;
  const perPage = cols * rows;

  // Font / spacing scales relative to cell size
  const small  = cellH < 25;
  const tiny   = cellH < 22;
  const big    = cellH > 50;
  const huge   = cellH > 100;
  const pad    = small ? 0.8 : 1.5;
  const fName  = huge ? 24 : big ? 14 : small ? 6 : 8;
  const fCode  = huge ? 18 : big ? 11 : small ? 6 : 8;
  const fMRP   = huge ? 32 : big ? 18 : small ? 8 : 11;

  for (let i = 0; i < items.length; i++) {
    const p    = items[i];
    const slot = i % perPage;
    if (i > 0 && slot === 0) doc.addPage();
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    const x   = margX + col * cellW;
    const y   = margY + row * cellH;

    // Optional cut-line border
    if (borders) {
      doc.setDrawColor(180);
      doc.setLineWidth(0.1);
      doc.rect(x, y, cellW, cellH);
    }

    // Vertical layout: [name?] / barcode / shortcode / MRP
    let cursorY = y + pad + fName * 0.353; // approx pt → mm baseline

    // Product name — skip on tiny cells
    if (!tiny) {
      doc.setFontSize(fName);
      doc.setFont(undefined, 'normal');
      const nameLines = doc.splitTextToSize(p.name || '', cellW - pad * 2);
      const showLines = small ? nameLines.slice(0, 1) : nameLines.slice(0, 2);
      doc.text(showLines.join('\n'), x + cellW / 2, cursorY, { align: 'center' });
      cursorY += showLines.length * (fName * 0.353) + pad;
    }

    // Barcode — preserve aspect ratio
    try {
      const bcCanvas = document.createElement('canvas');
      JsBarcode(bcCanvas, p.shortCode, {
        format: 'CODE128', displayValue: false, margin: 0,
        height: 100, width: 2.5,
      });
      const srcW = bcCanvas.width, srcH = bcCanvas.height;
      const ratio = srcW / srcH;
      // Reserve room for shortcode + MRP at the bottom
      const bottomReserve = (fCode * 0.353) + pad + (fMRP * 0.353) + pad;
      const maxBcH = cellH - (cursorY - y) - bottomReserve - pad;
      const maxBcW = cellW - pad * 2;
      let bcW = maxBcW;
      let bcH = bcW / ratio;
      if (bcH > maxBcH) { bcH = maxBcH; bcW = bcH * ratio; }
      const bcX = x + (cellW - bcW) / 2;
      doc.addImage(bcCanvas.toDataURL('image/png'), 'PNG', bcX, cursorY, bcW, bcH);
      cursorY += bcH + pad * 0.6;
    } catch {}

    // Shortcode
    doc.setFontSize(fCode);
    doc.setFont(undefined, 'normal');
    doc.text(p.shortCode || '', x + cellW / 2, cursorY + fCode * 0.353 * 0.7, { align: 'center' });
    cursorY += fCode * 0.353 + pad * 0.5;

    // MRP — bold, pinned to bottom
    doc.setFontSize(fMRP);
    doc.setFont(undefined, 'bold');
    doc.text(`MRP ${fmtMoney(_labelPrice(p))}`, x + cellW / 2, y + cellH - pad * 0.8, { align: 'center' });
    doc.setFont(undefined, 'normal');
  }
  doc.save(`labels-${cfg.name}-${todayISO()}.pdf`);
  toast(`Downloaded ${items.length} label${items.length === 1 ? '' : 's'} (${cfg.name})`, 'success');
}

// ---- Wire ----
// ---- Export / Import barcodes (CSV) ----
// Columns: shortCode, name, category, sellingPrice, ourPrice, costCode, fixedCode, hsn
const _CSV_HEADERS = ['shortCode','name','category','sellingPrice','ourPrice','costCode','fixedCode','hsn'];

function _csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function _exportBarcodesCSV() {
  // Respect the current category + search filter (so the user can scope what's exported)
  const list = _labelsList();
  if (!list.length) return toast('Nothing to export — adjust filter first', 'error');
  const rows = [_CSV_HEADERS];
  for (const p of list) {
    rows.push([
      p.shortCode || '',
      p.name || '',
      canonicalCategory(p.category) || '',
      p.sellingPrice ?? '',
      p.ourPrice ?? '',
      p.costCode || '',
      p.fixedCode || '',
      p.hsn || '',
    ]);
  }
  const csv = rows.map(r => r.map(_csvEscape).join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `barcodes-${todayISO()}.csv`);
  toast(`Exported ${list.length} barcode${list.length === 1 ? '' : 's'}`, 'success');
}

// Tiny RFC-4180-ish CSV parser — handles quoted fields and "" escapes
function _parseCSV(text) {
  const rows = [];
  let i = 0, row = [], cell = '', inQ = false;
  text = text.replace(/\r\n?/g, '\n');
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(cell); cell = ''; i++; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += c; i++;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.length && r.some(v => String(v).trim() !== ''));
}

async function _importBarcodesCSV(e) {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const rows = _parseCSV(text);
    if (rows.length < 2) throw new Error('CSV is empty or missing header row');
    const header = rows[0].map(h => h.trim());
    const idx = {};
    _CSV_HEADERS.forEach(h => { idx[h] = header.indexOf(h); });
    if (idx.shortCode < 0 && idx.name < 0) throw new Error('CSV needs at least a shortCode or name column');

    const existingByCode = new Map();
    const existingByName = new Map();
    for (const p of state.products) {
      if (p.shortCode) existingByCode.set(String(p.shortCode).toLowerCase(), p);
      if (p.name)      existingByName.set(p.name.toLowerCase(), p);
    }

    let added = 0, updated = 0, skipped = 0;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const get = (k) => idx[k] >= 0 ? (row[idx[k]] || '').trim() : '';
      const shortCode = get('shortCode');
      const name      = get('name');
      if (!shortCode && !name) { skipped++; continue; }
      const payload = {
        name: name || undefined,
        category: get('category') || undefined,
        sellingPrice: get('sellingPrice') !== '' ? parseFloat(get('sellingPrice')) : undefined,
        ourPrice:     get('ourPrice')     !== '' ? parseFloat(get('ourPrice'))     : undefined,
        costCode:     get('costCode')     || undefined,
        fixedCode:    get('fixedCode')    || undefined,
        hsn:          get('hsn')          || undefined,
      };
      // Find existing product: shortCode first, then name
      let existing = shortCode ? existingByCode.get(shortCode.toLowerCase()) : null;
      if (!existing && name)   existing = existingByName.get(name.toLowerCase());
      if (existing) {
        for (const [k, v] of Object.entries(payload)) {
          if (v !== undefined && v !== '' && !(typeof v === 'number' && isNaN(v))) existing[k] = v;
        }
        if (shortCode) existing.shortCode = shortCode;
        existing.updatedAt = nowISO();
        await db.put('products', existing);
        updated++;
      } else {
        // Need a shortCode for new products — auto-assign if missing
        const assignedCode = shortCode || await db.nextShortCode();
        const newProd = {
          shortCode: assignedCode,
          name: name || 'Unnamed',
          category: payload.category || 'General',
          sellingPrice: payload.sellingPrice ?? 0,
          ourPrice:    payload.ourPrice ?? null,
          stockQty: 0, reorderLevel: 5,
          hsn: payload.hsn || '',
          costCode:  payload.costCode || null,
          fixedCode: payload.fixedCode || null,
          gstRate: 18, cgstRate: 9, sgstRate: 9,
          createdAt: nowISO(), updatedAt: nowISO(),
        };
        await db.add('products', newProd);
        added++;
      }
    }

    await refreshProducts();
    renderLabels();
    document.dispatchEvent(new CustomEvent('toolbill:data-restored'));
    toast(`Imported — ${added} added, ${updated} updated${skipped ? `, ${skipped} skipped` : ''}`, 'success');
  } catch (err) {
    console.error(err);
    toast('Import failed: ' + err.message, 'error');
  } finally {
    e.target.value = '';
  }
}

export function wireLabels() {
  // Restore last-used print options from localStorage (no schema change)
  try {
    const saved = JSON.parse(localStorage.getItem('toolbill:labelOptions') || '{}');
    if (saved.layout  && $('#labels-layout'))  $('#labels-layout').value  = saved.layout;
    if (saved.copies  && $('#labels-copies'))  $('#labels-copies').value  = saved.copies;
    if (typeof saved.borders === 'boolean' && $('#labels-borders')) $('#labels-borders').checked = saved.borders;
  } catch {}
  const saveOpts = () => {
    try {
      localStorage.setItem('toolbill:labelOptions', JSON.stringify({
        layout:  $('#labels-layout')?.value,
        copies:  $('#labels-copies')?.value,
        borders: !!$('#labels-borders')?.checked,
      }));
    } catch {}
  };
  $('#labels-layout')?.addEventListener('change', saveOpts);
  $('#labels-copies')?.addEventListener('input', saveOpts);
  $('#labels-borders')?.addEventListener('change', saveOpts);

  $('#labels-search').addEventListener('input', debounce(renderLabels, 100));
  $('#labels-category').addEventListener('change', renderLabels);
  $('#btn-labels-select-all').addEventListener('click', () => {
    _labelsList().forEach(p => state.selectedLabels.add(p.id));
    renderLabels();
  });
  $('#btn-labels-select-none').addEventListener('click', () => {
    state.selectedLabels.clear();
    renderLabels();
  });
  $('#btn-labels-print').addEventListener('click', _printSelectedLabels);
  $('#btn-labels-print-detailed')?.addEventListener('click', _printSelectedDetailedLabels);
  $('#btn-labels-pdf').addEventListener('click', () => _downloadLabelsPDF());
  $('#btn-labels-export-csv')?.addEventListener('click', _exportBarcodesCSV);
  $('#labels-import-csv')?.addEventListener('change', _importBarcodesCSV);
  $('#label-print').addEventListener('click', async () => {
    const id = +$('#label-preview').dataset.productId;
    if (!id) return;
    await _renderLabelsToPrintArea([id]);
    window.print();
  });
  $('#label-pdf').addEventListener('click', async () => {
    const id = +$('#label-preview').dataset.productId;
    if (id) await _downloadLabelsPDF([id]);
  });

  // labels-category is also populated by populateCategorySelects in core, re-render on change
  document.addEventListener('toolbill:data-restored', renderLabels);

  registerTabRenderer('labels', renderLabels);

  // Wire single-label shortcut from products tab
  document.addEventListener('toolbill:show-label', (e) => showSingleLabel(e.detail));
}
