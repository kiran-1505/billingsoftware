// modules/daily.js — daily sales tab
import { db } from '../db.js';
import {
  state, $, fmtMoney, fmtInt, todayISO, escapeHTML, debounce, registerTabRenderer,
} from './core.js';

export async function renderDaily() {
  const invoices = await db.all('invoices');
  const byDay    = {};
  for (const inv of invoices) {
    const day = (inv.date || '').slice(0, 10);
    if (!day) continue;
    if (!byDay[day]) byDay[day] = { date: day, invoices: [], bills: 0, items: 0, total: 0, qty: 0 };
    byDay[day].invoices.push(inv);
    byDay[day].bills++;
    byDay[day].total += (inv.adjustedTotal ?? inv.total) || 0;
    byDay[day].items += (inv.items || []).length;
    byDay[day].qty   += (inv.items || []).reduce((s, l) => s + (l.qty || 0), 0);
  }
  const days = Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date));

  if (!state.dailySelectedDate && days.length) {
    state.dailySelectedDate    = days[0].date;
    $('#daily-date').value     = state.dailySelectedDate;
  }

  const q            = $('#daily-search').value.trim().toLowerCase();
  const filteredDays = days.filter(d => {
    if (!q) return true;
    if (d.date.includes(q)) return true;
    return d.invoices.some(inv => (inv.customerName || '').toLowerCase().includes(q));
  });

  const daysBox = $('#daily-days-list');
  if (!filteredDays.length) {
    daysBox.innerHTML = `<div class="p-4 text-sm text-gray-400 text-center">No sales yet</div>`;
  } else {
    daysBox.innerHTML = filteredDays.map(d => {
      const active = d.date === state.dailySelectedDate;
      const dt     = new Date(d.date + 'T00:00:00');
      const label  = dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      return `
        <button class="w-full text-left p-3 border-b hover:bg-gray-50 ${active ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''}" data-day="${d.date}">
          <div class="flex justify-between items-baseline gap-2">
            <div class="font-medium text-sm">${escapeHTML(label)}</div>
            <div class="font-semibold text-sm">${fmtMoney(d.total)}</div>
          </div>
          <div class="text-xs text-gray-500">${d.bills} bills · ${d.qty} units</div>
        </button>`;
    }).join('');
    daysBox.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => {
      state.dailySelectedDate = b.dataset.day;
      $('#daily-date').value  = b.dataset.day;
      renderDaily();
    }));
  }

  const sel   = state.dailySelectedDate;
  const body  = $('#daily-items-body');
  const title = $('#daily-day-title');
  const stats = $('#daily-day-stats');

  if (!sel || !byDay[sel]) {
    title.textContent = sel ? sel : 'Select a day';
    stats.textContent = sel ? 'No sales that day' : '';
    body.innerHTML    = `<tr><td colspan="7" class="text-center py-8 text-gray-400">${sel ? 'No sales on ' + sel : 'No day selected'}</td></tr>`;
    return;
  }

  const d  = byDay[sel];
  const dt = new Date(sel + 'T00:00:00');
  title.textContent = dt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  stats.textContent = `${d.bills} bills · ${d.qty} units · ${fmtMoney(d.total)}`;

  const lines = [];
  for (const inv of d.invoices) {
    for (const l of (inv.items || [])) {
      lines.push({
        time: inv.date, invoiceNo: inv.invoiceNo,
        customer: inv.customerName || '', customerGst: inv.customerGst || '',
        adjusted: inv.adjustedTotal != null,
        name: l.name, qty: l.qty, price: l.price,
        total: (l.price || 0) * (l.qty || 0),
      });
    }
  }
  lines.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

  if (!lines.length) {
    body.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-gray-400">No items</td></tr>`;
    return;
  }

  body.innerHTML = lines.map(l => {
    const t        = new Date(l.time);
    const custBadge = l.customerGst
      ? ` <span class="text-xs bg-green-100 text-green-700 px-1 rounded" title="Customer has GST: ${escapeHTML(l.customerGst)}">GST</span>`
      : '';
    const adjBadge  = l.adjusted
      ? ` <span class="text-xs bg-orange-100 text-orange-700 px-1 rounded" title="Bill total was GST-adjusted">adj</span>`
      : '';
    const customerHtml = l.customer
      ? `<span class="text-gray-800">${escapeHTML(l.customer)}</span>${custBadge}`
      : `<span class="text-gray-300">—</span>${custBadge}`;
    return `<tr>
      <td class="text-xs">${t.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</td>
      <td class="mono text-sm">${escapeHTML(l.invoiceNo || '')}${adjBadge}</td>
      <td class="text-sm">${customerHtml}</td>
      <td>${escapeHTML(l.name)}</td>
      <td class="text-right">${fmtInt(l.qty)}</td>
      <td class="text-right">${fmtMoney(l.price)}</td>
      <td class="text-right font-semibold">${fmtMoney(l.total)}</td>
    </tr>`;
  }).join('');
}

// ---- Wire ----
export function wireDaily() {
  $('#daily-date').addEventListener('change', (e) => {
    state.dailySelectedDate = e.target.value;
    renderDaily();
  });
  $('#btn-daily-today').addEventListener('click', () => {
    state.dailySelectedDate = todayISO();
    $('#daily-date').value  = state.dailySelectedDate;
    renderDaily();
  });
  $('#daily-search').addEventListener('input', debounce(renderDaily, 100));

  document.addEventListener('toolbill:data-restored', renderDaily);
  registerTabRenderer('daily', renderDaily);
}
