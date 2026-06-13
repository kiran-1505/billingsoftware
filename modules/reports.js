// modules/reports.js — reports tab, totals, CSV export
import { db } from '../db.js';
import {
  state, $, $$, fmtMoney, todayISO, escapeHTML, toast,
  downloadBlob, registerTabRenderer, openModal, closeModal,
} from './core.js';
import { renderBillToPrintArea } from './billing.js';

// A bill counts as GST if it has a GSTIN typed in OR was explicitly marked GST
// (e.g. via the "2+ spaces in GST field" shortcut, which saves customerType='gst'
// but customerGst=null).
export function isGstInvoice(inv) {
  return !!inv.customerGst || inv.customerType === 'gst';
}

// User2 sees actual (pre-scale) totals; User1 sees filed (post-scale) totals
export function getActualTotal(inv) {
  if (inv._gstOriginalItems) {
    return inv._gstOriginalItems.reduce((s, l) => s + (l.price || 0) * (l.qty || 0), 0);
  }
  return inv.total || 0;
}

export function getDisplayTotal(inv) {
  return state.currentUser === 'user2' ? getActualTotal(inv) : (inv.total || 0);
}

export async function renderReports() {
  const isAdmin = state.currentUser === 'user2';
  $('#bills-head-paid').classList.toggle('hidden', !isAdmin);
  $('#bills-foot-paid').classList.toggle('hidden', !isAdmin);
  $('#bills-head-actions')?.classList.toggle('hidden', !isAdmin);
  $('#bills-foot-actions')?.classList.toggle('hidden', !isAdmin);

  const invoices = await db.all('invoices');
  invoices.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const today       = todayISO();
  const monthPrefix = today.slice(0, 7);

  const todayInv    = invoices.filter(i => (i.date || '').slice(0, 10) === today);
  const monthInv    = invoices.filter(i => (i.date || '').slice(0, 7) === monthPrefix);
  const monthGst    = monthInv.filter(isGstInvoice);
  const monthWalkin = monthInv.filter(i => !isGstInvoice(i));

  $('#rep-today-sales').textContent       = fmtMoney(todayInv.reduce((s, i) => s + getDisplayTotal(i), 0));
  $('#rep-today-bills').textContent       = `${todayInv.length} bills`;
  $('#rep-month-sales').textContent       = fmtMoney(monthInv.reduce((s, i) => s + getDisplayTotal(i), 0));
  $('#rep-month-bills').textContent       = `${monthInv.length} bills`;
  $('#rep-month-gst-sales').textContent   = fmtMoney(monthGst.reduce((s, i) => s + getDisplayTotal(i), 0));
  $('#rep-month-gst-bills').textContent   = `${monthGst.length} bills`;
  $('#rep-month-walkin-sales').textContent = fmtMoney(monthWalkin.reduce((s, i) => s + getDisplayTotal(i), 0));
  $('#rep-month-walkin-bills').textContent = `${monthWalkin.length} bills`;
  $('#rep-alltime-sales').textContent     = fmtMoney(invoices.reduce((s, i) => s + getDisplayTotal(i), 0));
  $('#rep-alltime-bills').textContent     = `${invoices.length} bills`;

  const from = $('#rep-date-from').value;
  const to   = $('#rep-date-to').value;
  let filtered = invoices;
  if (from) filtered = filtered.filter(i => (i.date || '').slice(0, 10) >= from);
  if (to)   filtered = filtered.filter(i => (i.date || '').slice(0, 10) <= to);
  if (state.repCustFilter === 'gst')    filtered = filtered.filter(isGstInvoice);
  if (state.repCustFilter === 'walkin') filtered = filtered.filter(i => !isGstInvoice(i));

  const body = $('#bills-body');
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-gray-400">No bills in range</td></tr>`;
  } else {
    body.innerHTML = filtered.slice(0, 200).map(i => {
      const d             = new Date(i.date);
      const itemCount     = (i.items || []).reduce((s, l) => s + l.qty, 0);
      const gstBadge      = isGstInvoice(i)
        ? ` <span class="text-xs bg-green-100 text-green-700 px-1 rounded" title="${i.customerGst ? 'GSTIN: ' + escapeHTML(i.customerGst) : 'GST customer (no GSTIN)'}">GST</span>`
        : '';
      const reportedTotal = getDisplayTotal(i);
      const adjBadge      = (i._gstOriginalItems && state.currentUser === 'user2')
        ? ` <button class="text-xs bg-orange-100 text-orange-700 px-1 rounded hover:bg-orange-200 cursor-pointer" data-view-adj="${i.id}" title="View adjusted (filed) bill">adj</button>`
        : '';
      const invoiceCell   = isAdmin
        ? `<button class="mono text-blue-600 hover:underline text-left" data-view-orig="${i.id}">${escapeHTML(i.invoiceNo)}</button>`
        : `<span class="mono">${escapeHTML(i.invoiceNo)}</span>`;
      return `<tr>
        <td>${invoiceCell}</td>
        <td class="text-xs">${d.toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td>${escapeHTML(i.customerName || '')}${gstBadge}</td>
        <td class="text-right">${itemCount}</td>
        <td class="text-right font-semibold">${fmtMoney(reportedTotal)}${adjBadge}</td>
        ${isAdmin ? (() => { const p = i._gstOriginalAmountPaid ?? i.amountPaid; return `<td class="text-right">${p != null ? fmtMoney(p) : '—'}</td>`; })() : ''}
        ${isAdmin ? `<td><button class="text-blue-600 hover:underline text-sm" data-reprint="${i.id}">Reprint</button></td>` : ''}
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-reprint]').forEach(b => b.addEventListener('click', () => _reprintInvoice(+b.dataset.reprint)));
    body.querySelectorAll('[data-view-orig]').forEach(b => b.addEventListener('click', () => _showBillPreview(+b.dataset.viewOrig, 'original')));
    body.querySelectorAll('[data-view-adj]').forEach(b => b.addEventListener('click', () => _showBillPreview(+b.dataset.viewAdj, 'adjusted')));
  }

  // Footer totals
  const footSlice = filtered.slice(0, 200);
  const footTotal = footSlice.reduce((s, i) => s + getDisplayTotal(i), 0);
  // Admin's "Paid" footer shows the real cash received (original pre-scale amount)
  const footPaid  = footSlice.reduce((s, i) => s + ((i._gstOriginalAmountPaid ?? i.amountPaid) ?? getDisplayTotal(i)), 0);
  const foot      = $('#bills-foot');
  if (filtered.length) {
    $('#bills-foot-total').textContent = fmtMoney(footTotal);
    $('#bills-foot-paid').textContent  = fmtMoney(footPaid);
    foot.classList.remove('hidden');
  } else {
    foot.classList.add('hidden');
  }

  // The "top-selling items" panel was moved to the Inventory tab
  // (left of the Low Stock button) where it lives as an on-demand modal
  // with bar-chart visualisation and full ranking of every item.
}

async function _reprintInvoice(id) {
  const inv = await db.get('invoices', id);
  if (!inv) return;
  renderBillToPrintArea(inv);
  window.print();
}

async function _showBillPreview(id, which) {
  const inv = await db.get('invoices', id);
  if (!inv) return;

  // Build display invoice based on which view is requested
  const displayInv = { ...inv };
  if (which === 'original' && inv._gstOriginalItems) {
    // Show items before scale-down (actual items sold)
    displayInv.items      = inv._gstOriginalItems;
    displayInv.total      = inv._gstOriginalItems.reduce((s, l) => s + (l.price || 0) * (l.qty || 0), 0);
    displayInv.amountPaid = inv._gstOriginalAmountPaid ?? displayInv.total;
  }
  // 'adjusted' uses inv.items as-is (post scale-down)

  renderBillToPrintArea(displayInv);

  // Copy rendered print-area HTML into the preview modal
  const printArea = document.getElementById('print-area');
  document.getElementById('bill-view-content').innerHTML = printArea.innerHTML;
  document.getElementById('bill-view-title').textContent =
    which === 'original'
      ? `Original Bill — ${inv.invoiceNo}`
      : `Adjusted (Filed) Bill — ${inv.invoiceNo}`;

  openModal('modal-bill-view');
}

// Build the GST Sales Register data (rows + totals) shared by Excel export
// and the PDF export. Role-aware via _gstRowFor:
//   • Accounts → filed (scaled-down) figures they see on screen
//   • Admin    → complete (original pre-scale) figures
function _buildGSTRegisterRows(list, sellerStateCode) {
  const header = [
    'Invoice No', 'Invoice Date', 'Customer Name', 'GSTIN', 'State',
    'Invoice Type', 'HSN Code',
    'Taxable Value (₹)', 'GST Rate', 'CGST (₹)', 'SGST (₹)', 'IGST (₹)',
    'Total Invoice (₹)',
  ];
  const rows = [header];
  let tT = 0, tC = 0, tS = 0, tI = 0, tInv = 0;
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  for (const inv of list) {
    const r = _gstRowFor(inv, sellerStateCode);
    tT += r.taxable; tC += r.cgst; tS += r.sgst; tI += r.igst; tInv += r.total;
    rows.push([
      r.invoiceNo, r.date, r.customer, r.gstin, r.state,
      r.type, r.hsn,
      round2(r.taxable), r.rateLabel,
      round2(r.cgst), round2(r.sgst), round2(r.igst), round2(r.total),
    ]);
  }
  rows.push([
    'TOTAL', '', '', '', '', '', '',
    round2(tT), '', round2(tC), round2(tS), round2(tI), round2(tInv),
  ]);
  return rows;
}

// Export the filtered bills in the GST Sales Register format as an Excel
// (.xlsx) workbook. Uses SheetJS (XLSX global from CDN). Same data as the
// PDF — one row per invoice with auditor-ready columns + a TOTAL row.
async function _exportBillsCSV() {
  if (typeof XLSX === 'undefined') return toast('Excel library not loaded — refresh and try again', 'error');
  const invoices = await db.all('invoices');
  const from     = $('#rep-date-from').value;
  const to       = $('#rep-date-to').value;
  let list = invoices;
  if (from) list = list.filter(i => (i.date || '').slice(0, 10) >= from);
  if (to)   list = list.filter(i => (i.date || '').slice(0, 10) <= to);
  if (state.repCustFilter === 'gst')    list = list.filter(isGstInvoice);
  if (state.repCustFilter === 'walkin') list = list.filter(i => !isGstInvoice(i));
  if (!list.length) return toast('No bills in this range', 'error');
  list.sort((a, b) => (a.invoiceNo || '').localeCompare(b.invoiceNo || ''));

  const s = state.settings || {};
  const sellerStateCode = (s.gstin || '').slice(0, 2);
  const rows = _buildGSTRegisterRows(list, sellerStateCode);

  // Build the worksheet
  const ws = XLSX.utils.aoa_to_sheet(rows);
  // Set column widths (in character units)
  ws['!cols'] = [
    { wch: 12 }, { wch: 12 }, { wch: 28 }, { wch: 18 }, { wch: 18 },
    { wch:  8 }, { wch: 10 },
    { wch: 16 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 },
  ];
  // Freeze the header row
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  // Number-format the money columns
  const moneyCols = [7, 9, 10, 11, 12]; // 0-based indices
  for (let r = 1; r < rows.length; r++) {
    for (const c of moneyCols) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr] && typeof ws[addr].v === 'number') {
        ws[addr].t = 'n';
        ws[addr].z = '#,##0.00';
      }
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'GST Sales Register');
  const filename = `GST-sales-register-${from || 'start'}-to-${to || 'end'}.xlsx`;
  XLSX.writeFile(wb, filename);
  toast(`Excel downloaded — ${list.length} bills`, 'success');
}

// ---- GST Sales Register PDF (auditor-ready) ----
// State codes (first 2 chars of GSTIN). Kept local so this module is self-contained.
const _STATES = {
  '01':'Jammu and Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh',
  '05':'Uttarakhand','06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh',
  '10':'Bihar','11':'Sikkim','12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur',
  '15':'Mizoram','16':'Tripura','17':'Meghalaya','18':'Assam','19':'West Bengal',
  '20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh','24':'Gujarat',
  '27':'Maharashtra','29':'Karnataka','30':'Goa','32':'Kerala','33':'Tamil Nadu',
  '34':'Puducherry','36':'Telangana','37':'Andhra Pradesh','38':'Ladakh',
};
function _stateName(code) { return _STATES[code || ''] || ''; }

// One row of GST Sales Register numbers for a single invoice.
// Role-aware so the export matches what each user is meant to see:
//   • Accounts (user1) → FILED values (inv.items / inv.total). For scaled
//     bills these are the GST-return / scaled-down figures they see on screen.
//   • Admin (user2)    → COMPLETE/original values. For scaled bills we read
//     the pre-scale snapshot (_gstOriginalItems) so admin gets the real,
//     unscaled report.
function _gstRowFor(inv, sellerStateCode) {
  const isAdmin = state.currentUser === 'user2';
  const items = (isAdmin && inv._gstOriginalItems) ? inv._gstOriginalItems : (inv.items || []);
  const totalForRow = isAdmin ? getActualTotal(inv) : (inv.total || 0);
  const buyerStateCode = (inv.customerGst || '').slice(0, 2);
  const isInterState = !!sellerStateCode && !!buyerStateCode && sellerStateCode !== buyerStateCode;
  let taxable = 0, cgst = 0, sgst = 0, igst = 0;
  let firstHSN = '';
  const ratesSeen = new Set();
  for (const l of items) {
    const prod = (state.products || []).find(p => p.id === l.productId);
    let cRate = prod?.cgstRate, sRate = prod?.sgstRate;
    if (cRate == null && sRate == null) {
      const legacy = prod?.gstRate ?? 18;
      cRate = legacy / 2; sRate = legacy / 2;
    } else { cRate = cRate ?? 0; sRate = sRate ?? 0; }
    const gstRate = cRate + sRate;
    ratesSeen.add(Math.round(gstRate * 100) / 100);
    const rateIncl = Number(l.price) || 0;
    const qty      = Number(l.qty) || 0;
    const base     = rateIncl / (1 + gstRate / 100);
    const lineTax  = base * qty;
    taxable += lineTax;
    if (isInterState) igst += lineTax * gstRate / 100;
    else { cgst += lineTax * cRate / 100; sgst += lineTax * sRate / 100; }
    if (!firstHSN && prod?.hsn) firstHSN = prod.hsn;
  }
  const rateLabel = ratesSeen.size === 0 ? '—'
                  : ratesSeen.size === 1 ? `${[...ratesSeen][0]}%`
                  : 'Mixed';
  return {
    invoiceNo: inv.invoiceNo || '',
    date:      (inv.date || '').slice(0, 10),
    customer:  inv.customerName || (isGstInvoice(inv) ? '(GST customer)' : 'Cash Sale'),
    gstin:     inv.customerGst || '—',
    state:     _stateName(buyerStateCode) || _stateName(sellerStateCode) || '',
    type:      isGstInvoice(inv) ? 'B2B' : 'B2C',
    hsn:       firstHSN || '—',
    taxable,
    rateLabel,
    cgst, sgst, igst,
    total:     totalForRow, // accounts → filed; admin → original (pre-scale)
  };
}

async function _exportGSTSalesRegisterPDF() {
  const invoices = await db.all('invoices');
  const from = $('#rep-date-from').value;
  const to   = $('#rep-date-to').value;
  let list = invoices;
  if (from) list = list.filter(i => (i.date || '').slice(0, 10) >= from);
  if (to)   list = list.filter(i => (i.date || '').slice(0, 10) <= to);
  if (state.repCustFilter === 'gst')    list = list.filter(isGstInvoice);
  if (state.repCustFilter === 'walkin') list = list.filter(i => !isGstInvoice(i));
  if (!list.length) return toast('No bills in this range', 'error');
  list.sort((a, b) => (a.invoiceNo || '').localeCompare(b.invoiceNo || ''));

  const s = state.settings || {};
  const sellerStateCode = (s.gstin || '').slice(0, 2);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const PAGE_W = 297, PAGE_H = 210, mg = 8;
  let y = mg;

  // ── Top header block ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('GST SALES REGISTER', PAGE_W / 2, y + 6, { align: 'center' });
  y += 9;
  doc.setFontSize(9); doc.setFont('helvetica', 'normal');
  doc.text(s.shopName || '', PAGE_W / 2, y, { align: 'center' });
  y += 4;
  if (s.gstin) { doc.text(`GSTIN: ${s.gstin}    State: ${_stateName(sellerStateCode) || '—'}`, PAGE_W / 2, y, { align: 'center' }); y += 4; }
  const period = from || to ? `Period: ${from || '…'}  to  ${to || '…'}` : 'Period: All bills';
  doc.text(period, PAGE_W / 2, y, { align: 'center' });
  y += 6;

  // ── Column definitions ──
  const COLS = [
    { key: 's',       label: 'Sl',          w: 8,  align: 'center' },
    { key: 'invoiceNo', label: 'Invoice No.', w: 22, align: 'left'   },
    { key: 'date',    label: 'Date',        w: 18, align: 'left'   },
    { key: 'customer', label: 'Customer',   w: 38, align: 'left'   },
    { key: 'gstin',   label: 'GSTIN',       w: 30, align: 'left'   },
    { key: 'state',   label: 'State',       w: 22, align: 'left'   },
    { key: 'type',    label: 'Type',        w: 10, align: 'center' },
    { key: 'hsn',     label: 'HSN',         w: 14, align: 'center' },
    { key: 'taxable', label: 'Taxable ₹',   w: 22, align: 'right', n: true },
    { key: 'rateLabel', label: 'GST %',     w: 12, align: 'center' },
    { key: 'cgst',    label: 'CGST ₹',      w: 18, align: 'right', n: true },
    { key: 'sgst',    label: 'SGST ₹',      w: 18, align: 'right', n: true },
    { key: 'igst',    label: 'IGST ₹',      w: 18, align: 'right', n: true },
    { key: 'total',   label: 'Total ₹',     w: 22, align: 'right', n: true },
  ];
  const tableW = COLS.reduce((a, c) => a + c.w, 0);
  const tableX = mg + Math.max(0, (PAGE_W - 2 * mg - tableW) / 2);
  const rowH = 6;

  const drawHeader = () => {
    doc.setFillColor(30, 41, 59); doc.setTextColor(255);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5);
    doc.rect(tableX, y, tableW, rowH + 1, 'F');
    let x = tableX;
    for (const c of COLS) {
      const tx = c.align === 'right' ? x + c.w - 1 : c.align === 'center' ? x + c.w / 2 : x + 1;
      doc.text(c.label, tx, y + rowH - 1, { align: c.align });
      x += c.w;
    }
    doc.setTextColor(0);
    y += rowH + 1;
  };
  drawHeader();

  // ── Data rows ──
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
  const fmt2 = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let totals = { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
  let zebra = false;
  let pageNum = 1;

  for (let i = 0; i < list.length; i++) {
    if (y + rowH > PAGE_H - mg - 18) {
      doc.setFontSize(7); doc.setTextColor(140);
      doc.text(`Page ${pageNum}`, PAGE_W - mg, PAGE_H - mg + 2, { align: 'right' });
      doc.setTextColor(0);
      doc.addPage(); pageNum++; y = mg + 4;
      drawHeader();
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
    }
    const r = _gstRowFor(list[i], sellerStateCode);
    totals.taxable += r.taxable;
    totals.cgst    += r.cgst;
    totals.sgst    += r.sgst;
    totals.igst    += r.igst;
    totals.total   += r.total;

    if (zebra) { doc.setFillColor(248, 250, 252); doc.rect(tableX, y, tableW, rowH, 'F'); }
    zebra = !zebra;

    let x = tableX;
    const cells = { s: String(i + 1), ...r,
      taxable: fmt2(r.taxable), cgst: fmt2(r.cgst), sgst: fmt2(r.sgst),
      igst: fmt2(r.igst), total: fmt2(r.total),
    };
    for (const c of COLS) {
      let v = String(cells[c.key] ?? '');
      // Trim text that's too wide
      while (doc.getTextWidth(v) > c.w - 1.5 && v.length > 4) v = v.slice(0, -2);
      const tx = c.align === 'right' ? x + c.w - 1 : c.align === 'center' ? x + c.w / 2 : x + 1;
      doc.text(v, tx, y + rowH - 2, { align: c.align });
      x += c.w;
    }
    // Vertical column lines
    doc.setDrawColor(220); doc.setLineWidth(0.1);
    let lx = tableX;
    for (const c of COLS) { doc.line(lx, y, lx, y + rowH); lx += c.w; }
    doc.line(lx, y, lx, y + rowH);
    // Bottom border for the row
    doc.line(tableX, y + rowH, tableX + tableW, y + rowH);
    y += rowH;
  }

  // ── Totals row ──
  doc.setFillColor(30, 41, 59); doc.setTextColor(255);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
  doc.rect(tableX, y, tableW, rowH + 1, 'F');
  let tx = tableX;
  const totalCells = {
    label: 'TOTAL',
    taxable: fmt2(totals.taxable), cgst: fmt2(totals.cgst),
    sgst: fmt2(totals.sgst), igst: fmt2(totals.igst), total: fmt2(totals.total),
  };
  for (const c of COLS) {
    let v = '';
    if (c.key === 'invoiceNo') v = 'TOTAL';
    else if (['taxable','cgst','sgst','igst','total'].includes(c.key)) v = totalCells[c.key];
    const tt = c.align === 'right' ? tx + c.w - 1 : c.align === 'center' ? tx + c.w / 2 : tx + 1;
    doc.text(v, tt, y + rowH - 1, { align: c.align });
    tx += c.w;
  }
  doc.setTextColor(0);
  y += rowH + 3;

  // ── Footer ──
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
  doc.text(`Bills: ${list.length}`, mg, PAGE_H - mg + 2);
  doc.text(`Generated: ${new Date().toLocaleString('en-IN')}`, PAGE_W / 2, PAGE_H - mg + 2, { align: 'center' });
  doc.text(`Page ${pageNum}`, PAGE_W - mg, PAGE_H - mg + 2, { align: 'right' });

  doc.save(`GST-sales-register-${from || 'start'}-to-${to || 'end'}.pdf`);
  toast(`PDF downloaded — ${list.length} bills`, 'success');
}

// ---- Wire ----
export function wireReports() {
  // Bill preview modal print button
  document.getElementById('bill-view-print').addEventListener('click', () => window.print());

  $('#btn-rep-filter').addEventListener('click', renderReports);
  $('#btn-rep-today').addEventListener('click', () => {
    $('#rep-date-from').value = todayISO();
    $('#rep-date-to').value   = todayISO();
    renderReports();
  });
  $('#btn-rep-export').addEventListener('click', _exportBillsCSV);
  $('#btn-rep-pdf')?.addEventListener('click', _exportGSTSalesRegisterPDF);
  $$('.rep-cust-filter-btn').forEach(btn => btn.addEventListener('click', () => {
    state.repCustFilter = btn.dataset.filter;
    $$('.rep-cust-filter-btn').forEach(b => {
      b.className = `rep-cust-filter-btn px-3 py-1.5 font-medium ${b.dataset.filter === state.repCustFilter ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`;
    });
    renderReports();
  }));

  document.addEventListener('toolbill:data-restored', renderReports);
  registerTabRenderer('reports', renderReports);
}
