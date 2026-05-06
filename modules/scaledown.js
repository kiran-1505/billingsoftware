// modules/scaledown.js — scale-down (void bills) modal logic
import { db } from '../db.js';
import {
  state, $, fmtMoney, escapeHTML, toast, openModal, downloadBlob,
} from './core.js';
import { renderReports } from './reports.js';

export async function openVoidBillsModal() {
  $('#void-month').value  = new Date().toISOString().slice(0, 7);
  $('#void-target').value = '';
  await renderVoidBillsList();
  openModal('modal-void-bills');
}

export async function renderVoidBillsList() {
  const month = $('#void-month').value;
  const body  = $('#void-bills-list');
  if (!month) { body.innerHTML = ''; return; }

  const invoices = await db.all('invoices');
  const monthInv = invoices
    .filter(i => (i.date || '').slice(0, 7) === month && !i.customerGst)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  if (!monthInv.length) {
    body.innerHTML = `<div class="p-3 text-gray-400 text-center text-xs">No bills</div>`;
    return;
  }

  const rows = monthInv.map(i => {
    const d        = new Date(i.date);
    const modified = !!i._gstOriginalItems;
    const origTotal = modified
      ? i._gstOriginalItems.reduce((s, l) => s + (l.price || 0) * (l.qty || 0), 0)
      : null;
    return `<div class="flex items-center gap-2 px-3 py-2 border-b last:border-0 ${modified ? 'bg-orange-50 border-l-4 border-l-orange-400' : ''}">
      ${modified ? `<span class="text-orange-500 font-bold text-base leading-none">●</span>` : `<span class="w-3"></span>`}
      <span class="mono text-xs text-gray-500 w-20 flex-shrink-0">${escapeHTML(i.invoiceNo)}</span>
      <span class="text-xs text-gray-400 flex-shrink-0">${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
      <span class="flex-1 text-xs truncate">${escapeHTML(i.customerName || '')}</span>
      ${modified
        ? `<span class="text-xs text-gray-400 line-through">${fmtMoney(origTotal)}</span>
           <span class="font-semibold text-sm text-orange-600">${fmtMoney(i.total)}</span>`
        : `<span class="font-semibold text-sm">${fmtMoney(i.total)}</span>`}
    </div>`;
  }).join('');

  const total = monthInv.reduce((s, i) => s + (i.total || 0), 0);
  body.innerHTML = rows + `<div class="flex justify-between px-3 py-2 bg-gray-50 font-semibold text-sm">
    <span>Total</span><span>${fmtMoney(total)}</span>
  </div>`;
}

export async function applyVoidBills() {
  const month  = $('#void-month').value;
  const target = parseFloat($('#void-target').value);
  if (!month)                       return toast('Select a month first', 'error');
  if (isNaN(target) || target < 0)  return toast('Enter a valid target amount', 'error');

  const invoices      = await db.all('invoices');
  const monthInv      = invoices.filter(i => (i.date || '').slice(0, 7) === month);
  const protectedInv  = monthInv.filter(i => i.customerGst);
  const adjustableInv = monthInv.filter(i => !i.customerGst);

  if (!adjustableInv.length)   return toast('No walk-in bills found for this month', 'error');

  const protectedTotal   = protectedInv.reduce((s, i) => s + (i.total || 0), 0);
  const adjustableTotal  = adjustableInv.reduce((s, i) => s + (i.total || 0), 0);

  if (!adjustableTotal)       return toast('Walk-in bills have zero total', 'error');
  if (target < protectedTotal) return toast(`Target cannot be less than GST customer total (${fmtMoney(protectedTotal)})`, 'error');

  const adjustableTarget = target - protectedTotal;
  const reductionNeeded  = adjustableTotal - adjustableTarget;

  if (reductionNeeded <= 0) return toast(`Bills already total ${fmtMoney(adjustableTotal + protectedTotal)}, which is at or below target`, 'error');

  try {
    const billItems    = new Map(adjustableInv.map(inv => [inv.id, (inv.items || []).map(it => ({ ...it }))]));
    const origSnapshot = new Map(adjustableInv.map(inv => [inv.id, (inv.items || []).map(it => ({ ...it }))]));
    const billQty      = new Map(adjustableInv.map(inv => [inv.id, (inv.items || []).reduce((s, l) => s + (l.qty || 0), 0)]));

    const allUnits = [];
    for (const inv of adjustableInv) {
      for (const item of billItems.get(inv.id)) {
        for (let u = 0; u < (item.qty || 0); u++) {
          allUnits.push({ invId: inv.id, item, unitPrice: item.price || 0 });
        }
      }
    }
    allUnits.sort((a, b) => a.unitPrice - b.unitPrice);

    let reducedSoFar = 0;
    for (const { invId, item } of allUnits) {
      if (reducedSoFar >= reductionNeeded) break;
      if ((billQty.get(invId) || 0) <= 1) continue;
      if ((item.qty || 0) <= 0) continue;
      item.qty--;
      billQty.set(invId, billQty.get(invId) - 1);
      reducedSoFar += item.unitPrice;
    }

    for (const inv of adjustableInv) {
      const updatedItems  = billItems.get(inv.id).filter(i => (i.qty || 0) > 0);
      const newTotal      = updatedItems.reduce((s, l) => s + (l.price || 0) * (l.qty || 0), 0);
      const newAmountPaid = inv.amountPaid != null ? Math.min(inv.amountPaid, newTotal) : null;
      await db.put('invoices', {
        ...inv,
        items: updatedItems,
        subtotal: newTotal,
        total: newTotal,
        amountPaid: newAmountPaid,
        _gstOriginalItems: inv._gstOriginalItems || origSnapshot.get(inv.id),
      });
    }

    toast('Done', 'success');
    $('#void-target').value = '';
    await renderVoidBillsList();
    await renderReports();
  } catch (e) {
    console.error(e);
    toast('Error: ' + e.message, 'error');
  }
}

export async function restoreVoidBills() {
  const month = $('#void-month').value;
  if (!month) return;
  const invoices = await db.all('invoices');
  const monthInv = invoices.filter(i => (i.date || '').slice(0, 7) === month);
  for (const inv of monthInv) {
    if (!inv._gstOriginalItems) continue;
    const restoredItems = inv._gstOriginalItems;
    const newTotal      = restoredItems.reduce((s, l) => s + (l.price || 0) * (l.qty || 0), 0);
    const updated       = { ...inv, items: restoredItems, subtotal: newTotal, total: newTotal };
    delete updated._gstOriginalItems;
    await db.put('invoices', updated);
  }
  toast('Restored', 'success');
  await renderVoidBillsList();
  await renderReports();
}

export async function downloadVoidBillsPDF() {
  const month = $('#void-month').value;
  if (!month) return;

  const invoices = await db.all('invoices');
  const monthInv = invoices
    .filter(i => (i.date || '').slice(0, 7) === month)
    .sort((a, b) => (a.invoiceNo || '').localeCompare(b.invoiceNo || ''));

  if (!monthInv.length) { toast('No bills this month', 'error'); return; }

  const { jsPDF } = window.jspdf;
  const doc    = new jsPDF({ unit: 'mm', format: 'a4' });
  const s      = state.settings;
  const pageW  = 210, pageH = 297, mg = 12;
  const colW   = pageW - mg * 2;
  let y = mg, pageNum = 1;

  const addPageHeader = () => {
    doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(150);
    doc.text(`${s.shopName || ''} — ${month}`, mg, 8);
    doc.text(`Page ${pageNum}`, pageW - mg, 8, { align: 'right' });
    doc.setTextColor(0);
    y = mg + 4;
  };
  addPageHeader();

  for (const inv of monthInv) {
    const items  = inv.items || [];
    const billH  = 20 + items.length * 5 + 8;
    if (y + billH > pageH - mg) { doc.addPage(); pageNum++; addPageHeader(); }

    const d       = new Date(inv.date);
    const dateStr = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

    doc.setFontSize(8); doc.setFont('helvetica', 'bold');
    doc.text(inv.invoiceNo || '', mg, y);
    doc.setFont('helvetica', 'normal');
    doc.text(dateStr, pageW - mg, y, { align: 'right' });
    y += 4;

    if (inv.customerName) {
      doc.setFontSize(7);
      doc.text(inv.customerName + (inv.customerPhone ? `  ${inv.customerPhone}` : ''), mg, y);
      if (inv.customerGst) doc.text(`GSTIN: ${inv.customerGst}`, pageW - mg, y, { align: 'right' });
      y += 4;
    }

    doc.setFontSize(6.5); doc.setTextColor(120);
    doc.text('Item', mg, y);
    doc.text('Qty', mg + colW * 0.62, y);
    doc.text('Rate', mg + colW * 0.75, y);
    doc.text('Amount', pageW - mg, y, { align: 'right' });
    doc.setTextColor(0); y += 1.5;
    doc.setDrawColor(180); doc.line(mg, y, pageW - mg, y); y += 3;

    doc.setFontSize(7); doc.setFont('helvetica', 'normal');
    for (const item of items) {
      const name = (item.name || '').length > 30 ? item.name.slice(0, 29) + '…' : item.name;
      doc.text(name, mg, y);
      doc.text(String(item.qty || 0), mg + colW * 0.62, y);
      doc.text(fmtMoney(item.price || 0), mg + colW * 0.75, y);
      doc.text(fmtMoney((item.price || 0) * (item.qty || 0)), pageW - mg, y, { align: 'right' });
      y += 5;
    }

    doc.setDrawColor(180); doc.line(mg, y, pageW - mg, y); y += 3;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.text('Total', mg, y);
    doc.text(fmtMoney(inv.total), pageW - mg, y, { align: 'right' });
    doc.setFont('helvetica', 'normal'); y += 4;

    doc.setDrawColor(210); doc.setLineDashPattern([2, 2], 0);
    doc.line(mg, y, pageW - mg, y);
    doc.setLineDashPattern([], 0); doc.setDrawColor(0); y += 5;
  }

  if (y + 10 > pageH - mg) { doc.addPage(); pageNum++; addPageHeader(); }
  const grandTotal = monthInv.reduce((s, i) => s + (i.total || 0), 0);
  doc.setFontSize(9); doc.setFont('helvetica', 'bold');
  doc.text(`${monthInv.length} bills   Grand Total: ${fmtMoney(grandTotal)}`, mg, y);

  doc.save(`bills-${month}.pdf`);
  toast('PDF downloaded', 'success');
}

// ---- Wire ----
export function wireVoidBills() {
  $('#btn-scale-down').addEventListener('click', openVoidBillsModal);
  $('#void-month').addEventListener('change', renderVoidBillsList);
  $('#btn-void-enter').addEventListener('click', applyVoidBills);
  $('#btn-void-restore').addEventListener('click', restoreVoidBills);
  $('#btn-void-pdf').addEventListener('click', downloadVoidBillsPDF);
}
