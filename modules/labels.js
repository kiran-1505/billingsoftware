// modules/labels.js — label grid, barcode/QR print, PDF download
import {
  state, $, fmtMoney, todayISO, escapeHTML, toast,
  openModal, canonicalCategory, debounce, makeQRPayload,
  downloadBlob, registerTabRenderer,
} from './core.js';

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
        <div class="mrp">MRP ${fmtMoney(p.sellingPrice)}</div>
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
    return `
      <div class="label-card">
        <div class="name">${escapeHTML(p.name)}</div>
        <div class="codes">
          ${bcImg ? `<img src="${bcImg}" alt="barcode" style="height:44px;width:auto;"/>` : ''}
          ${qrImg ? `<img src="${qrImg}" alt="qr" style="height:72px;width:72px;"/>` : ''}
        </div>
        <div class="shortcode">${escapeHTML(p.shortCode)}</div>
        <div class="mrp">MRP ${fmtMoney(p.sellingPrice)}</div>
      </div>`;
  }));
  $('#print-area').innerHTML = `<div class="print-labels">${blocks.join('')}</div>`;
}

export async function showSingleLabel(productId) {
  const p = state.products.find(x => x.id === productId);
  if (!p) return;
  const box = $('#label-preview');
  box.dataset.productId = productId;
  box.innerHTML = `
    <div class="label-card" style="min-width:220px">
      <div class="name">${escapeHTML(p.name)}</div>
      <div class="codes">
        <canvas id="lbl-bc" width="140" height="50"></canvas>
        <canvas id="lbl-qr" width="90" height="90"></canvas>
      </div>
      <div class="shortcode">${escapeHTML(p.shortCode)}</div>
      <div class="mrp">MRP ${fmtMoney(p.sellingPrice)}</div>
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

async function _downloadLabelsPDF(ids) {
  ids = ids || Array.from(state.selectedLabels);
  if (!ids.length) return toast('Select labels first', 'error');
  const items = ids.map(id => state.products.find(p => p.id === id)).filter(Boolean);
  if (!items.length) return;

  const { jsPDF } = window.jspdf;
  const doc    = new jsPDF({ unit: 'mm', format: 'a4' });
  const marginX = 7, marginY = 10;
  const cols = 3, rows = 10;
  const cellW = (210 - marginX * 2) / cols;
  const cellH = (297 - marginY * 2) / rows;

  for (let i = 0; i < items.length; i++) {
    const p    = items[i];
    const slot = i % (cols * rows);
    if (i > 0 && slot === 0) doc.addPage();
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    const x   = marginX + col * cellW;
    const y   = marginY + row * cellH;

    doc.setFontSize(8);
    const lines = doc.splitTextToSize(p.name || '', cellW - 4);
    doc.text(lines.slice(0, 2).join('\n'), x + cellW / 2, y + 4, { align: 'center' });

    try {
      const bcCanvas = document.createElement('canvas');
      JsBarcode(bcCanvas, p.shortCode, { format: 'CODE128', displayValue: false, margin: 0, height: 40, width: 1.5 });
      doc.addImage(bcCanvas.toDataURL('image/png'), 'PNG', x + 2, y + 9, cellW * 0.55 - 4, cellH - 22);
    } catch {}

    try {
      const qrData = await QRCode.toDataURL(makeQRPayload(p), { width: 200, margin: 0 });
      const qrSize = Math.min(cellW * 0.45 - 4, cellH - 22);
      doc.addImage(qrData, 'PNG', x + cellW * 0.55, y + 9, qrSize, qrSize);
    } catch {}

    doc.setFontSize(9);
    doc.text(p.shortCode, x + cellW / 2, y + cellH - 6, { align: 'center' });
    doc.setFontSize(10);
    doc.setFont(undefined, 'bold');
    doc.text(`MRP ${fmtMoney(p.sellingPrice)}`, x + cellW / 2, y + cellH - 1.5, { align: 'center' });
    doc.setFont(undefined, 'normal');
  }
  doc.save(`labels-${todayISO()}.pdf`);
  toast(`Downloaded ${items.length} label(s)`, 'success');
}

// ---- Wire ----
export function wireLabels() {
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
  $('#btn-labels-pdf').addEventListener('click', () => _downloadLabelsPDF());
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
