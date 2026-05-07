// modules/reports.js — reports tab, totals, CSV export
import { db } from '../db.js';
import {
  state, $, $$, fmtMoney, todayISO, escapeHTML, toast,
  downloadBlob, registerTabRenderer,
} from './core.js';
import { renderBillToPrintArea } from './billing.js';

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
  $('#top-items-section').classList.toggle('hidden', isAdmin ? false : true);

  const invoices = await db.all('invoices');
  invoices.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const today       = todayISO();
  const monthPrefix = today.slice(0, 7);

  const todayInv    = invoices.filter(i => (i.date || '').slice(0, 10) === today);
  const monthInv    = invoices.filter(i => (i.date || '').slice(0, 7) === monthPrefix);
  const monthGst    = monthInv.filter(i => i.customerGst);
  const monthWalkin = monthInv.filter(i => !i.customerGst);

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
  if (state.repCustFilter === 'gst')    filtered = filtered.filter(i => i.customerGst);
  if (state.repCustFilter === 'walkin') filtered = filtered.filter(i => !i.customerGst);

  const body = $('#bills-body');
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-gray-400">No bills in range</td></tr>`;
  } else {
    body.innerHTML = filtered.slice(0, 200).map(i => {
      const d             = new Date(i.date);
      const itemCount     = (i.items || []).reduce((s, l) => s + l.qty, 0);
      const gstBadge      = i.customerGst
        ? ` <span class="text-xs bg-green-100 text-green-700 px-1 rounded" title="GSTIN: ${escapeHTML(i.customerGst)}">GST</span>`
        : '';
      const reportedTotal = getDisplayTotal(i);
      const adjBadge      = (i._gstOriginalItems && state.currentUser === 'user2')
        ? ` <span class="text-xs bg-orange-100 text-orange-700 px-1 rounded" title="Filed: ${fmtMoney(i.total)}">adj</span>`
        : '';
      return `<tr>
        <td class="mono">${escapeHTML(i.invoiceNo)}</td>
        <td class="text-xs">${d.toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td>${escapeHTML(i.customerName || '')}${gstBadge}</td>
        <td class="text-right">${itemCount}</td>
        <td class="text-right font-semibold">${fmtMoney(reportedTotal)}${adjBadge}</td>
        ${isAdmin ? `<td class="text-right">${i.amountPaid != null ? fmtMoney(i.amountPaid) : '—'}</td>` : ''}
        <td><button class="text-blue-600 hover:underline text-sm" data-reprint="${i.id}">Reprint</button></td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-reprint]').forEach(b => b.addEventListener('click', () => _reprintInvoice(+b.dataset.reprint)));
  }

  // Footer totals
  const footSlice = filtered.slice(0, 200);
  const footTotal = footSlice.reduce((s, i) => s + getDisplayTotal(i), 0);
  const footPaid  = footSlice.reduce((s, i) => s + (i.amountPaid ?? getDisplayTotal(i)), 0);
  const foot      = $('#bills-foot');
  if (filtered.length) {
    $('#bills-foot-total').textContent = fmtMoney(footTotal);
    $('#bills-foot-paid').textContent  = fmtMoney(footPaid);
    foot.classList.remove('hidden');
  } else {
    foot.classList.add('hidden');
  }

  // Top items — admin sees original (pre-scale) quantities
  const isAdmin = state.currentUser === 'user2';
  const counter = {};
  for (const inv of invoices) {
    const items = isAdmin && inv._gstOriginalItems ? inv._gstOriginalItems : (inv.items || []);
    for (const l of items) {
      const k = l.shortCode || '__' + l.name;
      if (!counter[k]) counter[k] = { name: l.name, shortCode: l.shortCode, qty: 0, rev: 0 };
      counter[k].qty += l.qty;
      counter[k].rev += l.qty * l.price;
    }
  }
  const top   = Object.values(counter).sort((a, b) => b.qty - a.qty).slice(0, 20);
  const tBody = $('#top-items-body');
  if (!top.length) {
    tBody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-gray-400">No sales yet</td></tr>`;
  } else {
    tBody.innerHTML = top.map(t => `<tr>
      <td class="mono">${escapeHTML(t.shortCode || '—')}</td>
      <td>${escapeHTML(t.name)}</td>
      <td class="text-right">${(Number(t.qty) || 0).toLocaleString('en-IN')}</td>
      <td class="text-right">${fmtMoney(t.rev)}</td>
    </tr>`).join('');
  }
}

async function _reprintInvoice(id) {
  const inv = await db.get('invoices', id);
  if (!inv) return;
  renderBillToPrintArea(inv);
  window.print();
}

async function _exportBillsCSV() {
  const invoices = await db.all('invoices');
  const from     = $('#rep-date-from').value;
  const to       = $('#rep-date-to').value;
  let list = invoices;
  if (from) list = list.filter(i => (i.date || '').slice(0, 10) >= from);
  if (to)   list = list.filter(i => (i.date || '').slice(0, 10) <= to);

  const rows = [['Invoice', 'Date', 'Customer', 'CustomerPhone', 'CustomerGST', 'ItemCode', 'ItemName', 'Qty', 'Price', 'LineTotal', 'InvoiceTotal', 'AdjustedTotal', 'AmountPaid', 'Notes']];
  for (const inv of list) {
    const date          = (inv.date || '').slice(0, 10);
    const reportedTotal = inv.adjustedTotal ?? inv.total;
    for (const l of inv.items || []) {
      rows.push([inv.invoiceNo, date, inv.customerName || '', inv.customerPhone || '', inv.customerGst || '', l.shortCode || '', l.name, l.qty, l.price, l.qty * l.price, inv.total, reportedTotal, inv.amountPaid ?? '', inv.notes || '']);
    }
  }
  const csv = rows.map(r => r.map(c => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `bills-${from || 'all'}-${to || ''}.csv`);
  toast('CSV downloaded', 'success');
}

// ---- Wire ----
export function wireReports() {
  $('#btn-rep-filter').addEventListener('click', renderReports);
  $('#btn-rep-today').addEventListener('click', () => {
    $('#rep-date-from').value = todayISO();
    $('#rep-date-to').value   = todayISO();
    renderReports();
  });
  $('#btn-rep-export').addEventListener('click', _exportBillsCSV);
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
