// modules/inventory.js — inventory tab, GRN, stock adjustment
import { db } from '../db.js';
import {
  state, $, fmtMoney, fmtInt, nowISO, escapeHTML, toast,
  openModal, closeModal, canonicalCategory, debounce,
  refreshProducts, registerTabRenderer,
} from './core.js';

function _inventoryCountsByCategory() {
  const agg = {};
  for (const c of state.categories) agg[c.name] = { items: 0, stock: 0, low: 0 };
  for (const p of state.products) {
    const n = canonicalCategory(p.category);
    if (!agg[n]) agg[n] = { items: 0, stock: 0, low: 0 };
    agg[n].items++;
    agg[n].stock += (p.stockQty || 0);
    if ((p.stockQty || 0) <= (p.reorderLevel || 0)) agg[n].low++;
  }
  return agg;
}

export function renderInventoryCategoryView() {
  $('#inv-list-view').classList.add('hidden');
  $('#inv-cat-view').classList.remove('hidden');

  const totalSKUs   = state.products.length;
  const totalStock  = state.products.reduce((s, p) => s + (p.stockQty || 0), 0);
  const low         = state.products.filter(p => (p.stockQty || 0) <= (p.reorderLevel || 0));
  $('#inv-total-skus').textContent   = fmtInt(totalSKUs);
  $('#inv-total-stock').textContent  = fmtInt(totalStock);
  $('#inv-low-count').textContent    = fmtInt(low.length);

  const agg = _inventoryCountsByCategory();
  const q   = $('#inv-cat-search').value.trim().toLowerCase();
  const cats = state.categories
    .map(c => ({ ...c, ...agg[c.name] }))
    .filter(c => {
      if (q && !c.name.toLowerCase().includes(q)) return false;
      if (state.showLowOnly && !(c.low > 0)) return false;
      return true;
    });
  const grid = $('#inv-cat-grid');
  if (!cats.length) {
    grid.innerHTML = `<div class="col-span-full text-center py-8 text-gray-400">No categories match</div>`;
    return;
  }
  grid.innerHTML = cats.map(c => `
    <button class="cat-card text-left" data-cat="${escapeHTML(c.name)}">
      ${c.image ? `<img src="${escapeHTML(c.image)}" class="w-full h-20 object-cover rounded mb-2" />` : ''}
      <div class="font-semibold text-gray-800 truncate">${escapeHTML(c.name)}</div>
      <div class="text-xs text-gray-500 mt-1">${fmtInt(c.items || 0)} items · ${fmtInt(c.stock || 0)} units</div>
      ${c.low ? `<div class="text-xs stock-low mt-1">${c.low} low</div>` : ''}
    </button>
  `).join('');
  grid.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => {
    state.currentInvCategory = b.dataset.cat;
    $('#inv-list-title').textContent = b.dataset.cat;
    $('#inv-cat-view').classList.add('hidden');
    $('#inv-list-view').classList.remove('hidden');
    $('#inv-search').value = '';
    renderInventoryList();
    setTimeout(() => $('#inv-search').focus(), 30);
  }));
}

export function renderInventoryList() {
  const cat = state.currentInvCategory;
  const q   = $('#inv-search').value.trim().toLowerCase();
  let list  = state.products.filter(p => canonicalCategory(p.category) === cat);
  if (q)                list = list.filter(p => (p.name || '').toLowerCase().includes(q) || (p.shortCode || '').toLowerCase().includes(q));
  if (state.showLowOnly) list = list.filter(p => (p.stockQty || 0) <= (p.reorderLevel || 0));

  const body = $('#inventory-body');
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-gray-400">${state.showLowOnly ? 'No low-stock items' : 'No items match'}</td></tr>`;
    return;
  }
  body.innerHTML = list.map(p => {
    const isLow = (p.stockQty || 0) <= (p.reorderLevel || 0);
    return `<tr>
      <td class="mono">${escapeHTML(p.shortCode)}</td>
      <td>${escapeHTML(p.name)}</td>
      <td class="text-right ${isLow ? 'stock-low' : ''}">${fmtInt(p.stockQty)}</td>
      <td class="text-right">${fmtInt(p.reorderLevel)}</td>
      <td>${isLow ? '<span class="stock-low">LOW</span>' : '<span class="stock-ok">OK</span>'}</td>
    </tr>`;
  }).join('');
}

// ---- Product picker (shared search dropdown for GRN / Adj) ----
function _wireProductPicker(input, dd, onPick) {
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { dd.classList.add('hidden'); return; }
    if (/^[A-Z]+-\d+$/i.test(q)) {
      const p = state.products.find(x => x.shortCode.toUpperCase() === q.toUpperCase());
      if (p) { onPick(p); dd.classList.add('hidden'); return; }
    }
    const matches = state.products
      .filter(p => (p.name || '').toLowerCase().includes(q) || (p.shortCode || '').toLowerCase().includes(q))
      .slice(0, 8);
    if (!matches.length) { dd.classList.add('hidden'); return; }
    dd.innerHTML = matches.map(p => `
      <div class="item" data-pid="${p.id}">
        <div><div class="font-medium">${escapeHTML(p.name)}</div><div class="text-xs text-gray-500 mono">${escapeHTML(p.shortCode)}</div></div>
        <div class="text-right text-sm">${p.stockQty} in stock</div>
      </div>`).join('');
    dd.classList.remove('hidden');
    dd.querySelectorAll('[data-pid]').forEach(el => el.addEventListener('click', () => {
      const p = state.products.find(x => x.id === +el.dataset.pid);
      onPick(p);
      input.value = p.name;
      dd.classList.add('hidden');
    }));
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = input.value.trim();
      if (/^[A-Z]+-\d+$/i.test(q)) {
        const p = state.products.find(x => x.shortCode.toUpperCase() === q.toUpperCase());
        if (p) { onPick(p); dd.classList.add('hidden'); return; }
      }
      const first = dd.querySelector('[data-pid]');
      if (first) first.click();
    }
  });
}

// ---- GRN (multi-row receive stock) ----
function _grnFmtQty(n) {
  const r = Number((Number(n) || 0).toFixed(3));
  return Number.isInteger(r) ? String(r) : r.toString();
}

function _grnRenumber() {
  Array.from($('#grn-body').children).forEach((tr, i) => {
    tr.firstElementChild.textContent = i + 1;
  });
}

function _grnUpdateSummary() {
  const rows = Array.from($('#grn-body').children);
  let ready = 0, totalQty = 0;
  for (const tr of rows) {
    const pid = +(tr.dataset.productId || 0);
    const qty = parseFloat(tr.querySelector('[data-grn-qty]')?.value || '0');
    if (pid > 0 && qty > 0) { ready++; totalQty += qty; }
  }
  const summary = $('#grn-summary');
  if (!rows.length) {
    summary.textContent = '';
  } else if (!ready) {
    summary.innerHTML = `<span class="text-gray-500">${rows.length} row${rows.length === 1 ? '' : 's'} — pick products and quantities</span>`;
  } else {
    summary.innerHTML = `<span class="text-green-700 font-semibold">${ready} row${ready === 1 ? '' : 's'} ready · ${_grnFmtQty(totalQty)} units total</span>`;
  }
  $('#grn-save').disabled = ready === 0;
}

function _grnAddRow(presetProduct = null) {
  const tbody = $('#grn-body');
  const tr = document.createElement('tr');
  tr.dataset.productId = presetProduct?.id ? String(presetProduct.id) : '0';
  tr.innerHTML = `
    <td class="bulk-rownum"></td>
    <td>
      <input type="text" class="bulk-input" data-grn-prod placeholder="Type product name or code…" autocomplete="off"
        value="${presetProduct ? escapeHTML(presetProduct.name + ' — ' + (presetProduct.shortCode || '')) : ''}" />
    </td>
    <td class="text-right text-gray-600 text-xs" data-grn-current>${presetProduct ? _grnFmtQty(presetProduct.stockQty || 0) : '—'}</td>
    <td><input type="number" min="0.001" step="0.001" class="bulk-input text-right" data-grn-qty placeholder="0" /></td>
    <td class="text-right font-semibold text-green-700 text-xs" data-grn-new>—</td>
    <td class="text-center"><button type="button" class="bulk-del-btn" title="Delete row">&times;</button></td>
  `;
  tbody.appendChild(tr);

  tr.querySelector('.bulk-del-btn').addEventListener('click', () => {
    tr.remove();
    _grnRenumber();
    _grnUpdateSummary();
  });
  _wireGrnProductSearch(tr.querySelector('[data-grn-prod]'), tr);
  tr.querySelector('[data-grn-qty]').addEventListener('input', () => {
    _grnUpdateNewStock(tr);
    _grnUpdateSummary();
  });
  _grnRenumber();
  _grnUpdateSummary();
}

function _grnUpdateNewStock(tr) {
  const pid = +(tr.dataset.productId || 0);
  const qty = parseFloat(tr.querySelector('[data-grn-qty]').value || '0');
  const cell = tr.querySelector('[data-grn-new]');
  if (pid > 0 && qty > 0) {
    const p = state.products.find(x => x.id === pid);
    if (p) cell.textContent = _grnFmtQty((p.stockQty || 0) + qty);
  } else {
    cell.textContent = '—';
  }
}

// ---- Floating product-search dropdown (one shared instance for all rows) ----
let _grnActiveInput = null;
let _grnActiveTr = null;
let _grnDdActive = -1;

function _grnProductMatches() {
  const q = (_grnActiveInput?.value || '').trim().toLowerCase();
  if (!q) return state.products.slice(0, 30);
  return state.products
    .filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.shortCode || '').toLowerCase().includes(q)
    ).slice(0, 30);
}

function _renderGrnProductDropdown() {
  const dd = $('#grn-prod-dropdown');
  if (!dd || !_grnActiveInput) return;
  const matches = _grnProductMatches();
  const rect = _grnActiveInput.getBoundingClientRect();
  dd.style.left  = rect.left + 'px';
  dd.style.top   = (rect.bottom + 2) + 'px';
  dd.style.width = Math.max(rect.width, 280) + 'px';
  if (!matches.length) {
    dd.innerHTML = `<div class="px-3 py-2 text-gray-400">No products match</div>`;
    dd.classList.remove('hidden');
    _grnDdActive = -1;
    return;
  }
  if (_grnDdActive >= matches.length) _grnDdActive = matches.length - 1;
  dd.innerHTML = matches.map((p, idx) => `
    <div class="px-3 py-2 cursor-pointer flex items-center gap-2 ${idx === _grnDdActive ? 'bg-blue-100' : 'hover:bg-gray-100'}" data-grn-pick="${p.id}">
      ${p.image
        ? `<img src="${escapeHTML(p.image)}" class="w-6 h-6 object-cover rounded flex-shrink-0" />`
        : `<div class="w-6 h-6 rounded bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-[9px] flex-shrink-0">${escapeHTML((p.name || '??').slice(0, 2).toUpperCase())}</div>`}
      <div class="flex-1 min-w-0">
        <div class="truncate">${escapeHTML(p.name)}</div>
        <div class="text-[10px] text-gray-500">${escapeHTML(p.shortCode || '')} · stock ${_grnFmtQty(p.stockQty || 0)}</div>
      </div>
    </div>
  `).join('');
  dd.classList.remove('hidden');
  dd.querySelectorAll('[data-grn-pick]').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pid = +el.dataset.grnPick;
      const p = state.products.find(x => x.id === pid);
      if (!p || !_grnActiveInput || !_grnActiveTr) return;
      _grnActiveInput.value = `${p.name} — ${p.shortCode || ''}`;
      _grnActiveTr.dataset.productId = String(p.id);
      _grnActiveTr.querySelector('[data-grn-current]').textContent = _grnFmtQty(p.stockQty || 0);
      _grnUpdateNewStock(_grnActiveTr);
      _grnUpdateSummary();
      _closeGrnDropdown();
      _grnActiveTr.querySelector('[data-grn-qty]').focus();
    });
  });
}

function _closeGrnDropdown() {
  const dd = $('#grn-prod-dropdown');
  if (dd) dd.classList.add('hidden');
  _grnActiveInput = null;
  _grnActiveTr = null;
  _grnDdActive = -1;
}

function _wireGrnProductSearch(input, tr) {
  input.addEventListener('focus', () => {
    _grnActiveInput = input;
    _grnActiveTr = tr;
    _grnDdActive = -1;
    _renderGrnProductDropdown();
  });
  input.addEventListener('input', () => {
    // Typing replaces the previous pick — clear the row's productId
    tr.dataset.productId = '0';
    tr.querySelector('[data-grn-current]').textContent = '—';
    tr.querySelector('[data-grn-new]').textContent = '—';
    _grnDdActive = -1;
    _renderGrnProductDropdown();
    _grnUpdateSummary();
  });
  input.addEventListener('keydown', (e) => {
    if ($('#grn-prod-dropdown')?.classList.contains('hidden')) return;
    const matches = _grnProductMatches();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _grnDdActive = Math.min(matches.length - 1, _grnDdActive + 1);
      _renderGrnProductDropdown();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _grnDdActive = Math.max(0, _grnDdActive - 1);
      _renderGrnProductDropdown();
    } else if (e.key === 'Enter' && _grnDdActive >= 0 && matches[_grnDdActive]) {
      e.preventDefault();
      const p = matches[_grnDdActive];
      input.value = `${p.name} — ${p.shortCode || ''}`;
      tr.dataset.productId = String(p.id);
      tr.querySelector('[data-grn-current]').textContent = _grnFmtQty(p.stockQty || 0);
      _grnUpdateNewStock(tr);
      _grnUpdateSummary();
      _closeGrnDropdown();
      tr.querySelector('[data-grn-qty]').focus();
    } else if (e.key === 'Escape') {
      _closeGrnDropdown();
    }
  });
  input.addEventListener('blur', () => setTimeout(_closeGrnDropdown, 150));
}

function _openGRNModal() {
  $('#grn-body').innerHTML = '';
  $('#grn-ref').value = '';
  $('#grn-summary').textContent = '';
  $('#grn-save').disabled = true;
  // Start with 3 empty rows
  for (let i = 0; i < 3; i++) _grnAddRow();
  openModal('modal-grn');
  setTimeout(() => $('#grn-body input[data-grn-prod]')?.focus(), 50);
}

async function _saveGRN() {
  const rows = Array.from($('#grn-body').children);
  const ref = $('#grn-ref').value.trim();
  const payload = [];
  for (const tr of rows) {
    const pid = +(tr.dataset.productId || 0);
    const qty = parseFloat(tr.querySelector('[data-grn-qty]').value || '0');
    if (pid > 0 && qty > 0) payload.push({ pid, qty });
  }
  if (!payload.length) return toast('No valid rows to save', 'error');

  let saved = 0;
  for (const { pid, qty } of payload) {
    const p = await db.get('products', pid);
    if (!p) continue;
    p.stockQty = (Number(p.stockQty) || 0) + qty;
    p.updatedAt = nowISO();
    await db.put('products', p);
    await db.add('stockMovements', {
      productId: p.id, type: 'receipt', qty,
      reason: 'GRN' + (ref ? ' · ' + ref : ''), date: nowISO(),
    });
    saved++;
  }
  closeModal('modal-grn');
  toast(`Received stock for ${saved} item${saved === 1 ? '' : 's'}`, 'success');
  await refreshProducts();
  renderInventoryCategoryView();
  if (state.currentInvCategory) renderInventoryList();
}

// ---- Adjustment ----
function _openAdjModal() {
  state.adjTarget = null;
  $('#adj-search').value = '';
  $('#adj-qty').value    = '';
  $('#adj-selected').classList.add('hidden');
  openModal('modal-adjust');
  setTimeout(() => $('#adj-search').focus(), 50);
}

async function _saveAdj() {
  if (!state.adjTarget) return toast('Pick a product', 'error');
  const newQty  = parseInt($('#adj-qty').value, 10);
  const reason  = $('#adj-reason').value;
  if (!(newQty >= 0)) return toast('Enter a valid quantity', 'error');
  const p    = await db.get('products', state.adjTarget.id);
  const diff = newQty - (p.stockQty || 0);
  if (diff === 0) { closeModal('modal-adjust'); return; }
  p.stockQty  = newQty;
  p.updatedAt = nowISO();
  await db.put('products', p);
  await db.add('stockMovements', { productId: p.id, type: 'adjust', qty: diff, reason, date: nowISO() });
  closeModal('modal-adjust');
  toast(`Stock updated to ${newQty}`, 'success');
  await refreshProducts();
  renderInventoryCategoryView();
  if (state.currentInvCategory) renderInventoryList();
}

// ---- Wire ----
// ---- Top items modal — all items ranked by chosen metric, with bar chart ----
function _todayISO() { return new Date().toISOString().slice(0, 10); }
function _firstOfMonthISO() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); }
function _lastOfMonthISO() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10); }

let _tsFilter = 'top-sales';

// Metric config: how to sort + which value drives the bar + how to label
const _TS_METRICS = {
  'top-sales':   { title: 'Top selling',   field: 'qtySold',      label: 'Qty sold',  asc: false, bar: 'bg-emerald-500', accent: 'emerald' },
  'low-sales':   { title: 'Low selling',   field: 'qtySold',      label: 'Qty sold',  asc: true,  bar: 'bg-slate-400',   accent: 'slate'   },
  'top-revenue': { title: 'Top revenue',   field: 'revenue',      label: 'Revenue ₹', asc: false, bar: 'bg-emerald-600', accent: 'emerald' },
  'top-reorder': { title: 'Top reordered', field: 'reorderCount', label: 'Reorders',  asc: false, bar: 'bg-amber-500',   accent: 'amber'   },
  'top-damaged': { title: 'Top damaged',   field: 'damaged',      label: 'Damaged',   asc: false, bar: 'bg-rose-500',    accent: 'rose'    },
};

async function _renderTopSellers() {
  const from = $('#ts-from').value;
  const to   = $('#ts-to').value;
  const inRange = (iso) => {
    const d = (iso || '').slice(0, 10);
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  };

  const [invoices, movements] = await Promise.all([
    db.all('invoices'),
    db.all('stockMovements'),
  ]);

  // Seed an aggregate row for every product so unsold items are still ranked
  const agg = new Map();
  for (const p of state.products) {
    agg.set(`id:${p.id}`, {
      productId: p.id,
      shortCode: p.shortCode || '',
      name: p.name,
      category: p.category || '',
      stockQty: p.stockQty ?? null,
      qtySold: 0, revenue: 0, bills: 0,
      reorderCount: 0, reorderQty: 0,
      damaged: 0,
    });
  }

  // Sales aggregation (respects date range)
  const isAdmin = state.currentUser === 'user2';
  for (const inv of invoices.filter(i => inRange(i.date))) {
    const items = (isAdmin && inv._gstOriginalItems) ? inv._gstOriginalItems : (inv.items || []);
    for (const l of items) {
      const key = l.productId != null ? `id:${l.productId}` : `name:${(l.name || '').toLowerCase()}`;
      if (!agg.has(key)) {
        agg.set(key, {
          productId: l.productId,
          shortCode: l.shortCode || '',
          name: l.name || '(unknown)',
          category: '', stockQty: null,
          qtySold: 0, revenue: 0, bills: 0,
          reorderCount: 0, reorderQty: 0,
          damaged: 0,
        });
      }
      const r = agg.get(key);
      r.qtySold += Number(l.qty) || 0;
      r.revenue += (Number(l.qty) || 0) * (Number(l.price) || 0);
      r.bills   += 1;
    }
  }

  // Reorders + damage aggregation (also respects date range, by movement.date)
  for (const m of movements) {
    if (!inRange(m.date)) continue;
    const key = `id:${m.productId}`;
    if (!agg.has(key)) continue; // product was deleted; skip
    const qty = Number(m.qty) || 0;
    const r = agg.get(key);
    if (m.type === 'receipt' || (m.type === 'adjust' && qty > 0)) {
      r.reorderCount += 1;
      r.reorderQty   += Math.abs(qty);
    } else if (m.type === 'adjust' && qty < 0) {
      r.damaged += Math.abs(qty);
    }
    // 'sale' movements duplicate the invoice data — ignored here
  }

  // Sort + filter based on the active metric
  const metric = _TS_METRICS[_tsFilter] || _TS_METRICS['top-sales'];
  let list = Array.from(agg.values());
  list.sort((a, b) => {
    const av = a[metric.field] || 0;
    const bv = b[metric.field] || 0;
    return metric.asc ? av - bv : bv - av;
  });
  // For "low selling" exclude items with zero sales? — the user said "every item",
  // so keep them all, but zeros will appear at top of ascending list. Push the never-stocked items down.
  if (_tsFilter === 'low-sales') {
    list = list.filter(r => r.stockQty != null); // products no longer in catalog → skip
  }

  // Bar denominator = max value of the active metric across the list
  const maxVal = list.reduce((mx, r) => Math.max(mx, r[metric.field] || 0), 0) || 1;

  // Summary numbers
  const fmt    = (n) => '₹' + (Number(n) || 0).toFixed(2);
  const fmtQty = (n) => {
    const r = Number((Number(n) || 0).toFixed(3));
    return Number.isInteger(r) ? String(r) : r.toString();
  };
  const totalSold     = list.reduce((s, r) => s + r.qtySold, 0);
  const totalRev      = list.reduce((s, r) => s + r.revenue, 0);
  const totalReorders = list.reduce((s, r) => s + r.reorderCount, 0);
  const totalDamaged  = list.reduce((s, r) => s + r.damaged, 0);

  $('#ts-title').textContent = `${metric.title} — all items ranked`;

  // Highlight active filter pill
  document.querySelectorAll('.ts-filter-btn').forEach(b => {
    b.dataset.active = (b.dataset.tsFilter === _tsFilter) ? 'true' : 'false';
  });

  // Summary cards — same 4 always so the layout doesn't jump
  $('#ts-summary').innerHTML = `
    <div class="bg-gray-50 border rounded p-3">
      <div class="text-[10px] text-gray-500 uppercase tracking-wide">Items tracked</div>
      <div class="text-xl font-bold">${list.length}</div>
    </div>
    <div class="bg-gray-50 border rounded p-3">
      <div class="text-[10px] text-gray-500 uppercase tracking-wide">Qty sold</div>
      <div class="text-xl font-bold">${fmtQty(totalSold)}</div>
    </div>
    <div class="bg-amber-50 border border-amber-200 rounded p-3">
      <div class="text-[10px] text-amber-700 uppercase tracking-wide">Reorders</div>
      <div class="text-xl font-bold text-amber-700">${totalReorders}</div>
    </div>
    <div class="bg-rose-50 border border-rose-200 rounded p-3">
      <div class="text-[10px] text-rose-700 uppercase tracking-wide">Damaged</div>
      <div class="text-xl font-bold text-rose-700">${fmtQty(totalDamaged)}</div>
    </div>`;

  if (!list.length) {
    $('#ts-body').innerHTML = `<div class="p-6 text-center text-gray-400 text-sm">No products yet.</div>`;
    return;
  }

  // Bar colour scale per rank position
  const barClass = (i, fallback) => {
    if (i === 0)  return fallback;
    if (i < 3)    return fallback.replace('-500', '-400').replace('-600', '-500');
    if (i < 10)   return fallback.replace('-500', '-300').replace('-600', '-400');
    return 'bg-gray-300';
  };

  // Format the active metric value column based on its field
  const fmtMetricVal = (r) => {
    const v = r[metric.field] || 0;
    if (metric.field === 'revenue') return fmt(v);
    if (metric.field === 'reorderCount') return String(v);
    return fmtQty(v);
  };

  $('#ts-body').innerHTML = `
    <table class="w-full text-sm">
      <thead class="bg-gray-50 border-b text-xs uppercase text-gray-500 sticky top-0">
        <tr>
          <th class="text-right p-2 w-12">#</th>
          <th class="text-left p-2">Item</th>
          <th class="text-left p-2 w-1/3">${escapeHTML(metric.label)} <span class="font-normal text-gray-400">(bar)</span></th>
          <th class="text-right p-2 w-24">${escapeHTML(metric.label)}</th>
          <th class="text-right p-2 w-20">Sold</th>
          <th class="text-right p-2 w-20">Reorders</th>
          <th class="text-right p-2 w-20">Damaged</th>
          <th class="text-right p-2 w-20">Stock</th>
        </tr>
      </thead>
      <tbody>
        ${list.map((r, i) => {
          const v = r[metric.field] || 0;
          const pct = maxVal > 0 ? Math.max(1, (v / maxVal) * 100) : 0;
          const showBar = v > 0;
          const rankPill = i === 0 ? `bg-${metric.accent}-100 text-${metric.accent}-800 border border-${metric.accent}-300`
                         : i < 3   ? `bg-${metric.accent}-50 text-${metric.accent}-700`
                         : i < 10  ? 'bg-gray-100 text-gray-700'
                                   : 'text-gray-500';
          return `
          <tr class="border-b hover:bg-gray-50">
            <td class="p-2 text-right"><span class="inline-block px-2 py-0.5 rounded text-xs font-bold ${rankPill}">${i + 1}</span></td>
            <td class="p-2">
              <div class="font-medium text-gray-800">${escapeHTML(r.name)}</div>
              <div class="text-[10px] text-gray-500 mono">${escapeHTML(r.shortCode || '—')}${r.category ? ' · ' + escapeHTML(r.category) : ''}</div>
            </td>
            <td class="p-2">
              ${showBar ? `<div class="h-3 rounded ${barClass(i, metric.bar)}" style="width:${pct.toFixed(1)}%"></div>` : `<div class="h-3 rounded bg-gray-100" style="width:6px"></div>`}
            </td>
            <td class="p-2 text-right font-bold">${fmtMetricVal(r)}</td>
            <td class="p-2 text-right text-xs text-gray-600">${fmtQty(r.qtySold)}</td>
            <td class="p-2 text-right text-xs text-amber-700 font-semibold">${r.reorderCount || '—'}</td>
            <td class="p-2 text-right text-xs ${r.damaged > 0 ? 'text-rose-600 font-semibold' : 'text-gray-400'}">${r.damaged > 0 ? fmtQty(r.damaged) : '—'}</td>
            <td class="p-2 text-right text-xs ${r.stockQty != null && r.stockQty <= 0 ? 'text-red-600 font-semibold' : 'text-gray-600'}">${r.stockQty != null ? fmtQty(r.stockQty) : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

async function _openTopSellersModal() {
  if (!$('#ts-from').value) $('#ts-from').value = _firstOfMonthISO();
  if (!$('#ts-to').value)   $('#ts-to').value   = _lastOfMonthISO();
  _tsFilter = 'top-sales';
  await _renderTopSellers();
  openModal('modal-top-sellers');
}

export function wireInventory() {
  $('#btn-grn').addEventListener('click', _openGRNModal);
  $('#btn-adjust').addEventListener('click', _openAdjModal);
  $('#btn-top-sellers')?.addEventListener('click', _openTopSellersModal);
  $('#ts-from')?.addEventListener('change', _renderTopSellers);
  $('#ts-to')?.addEventListener('change', _renderTopSellers);
  $('#ts-quick-month')?.addEventListener('click', () => {
    $('#ts-from').value = _firstOfMonthISO();
    $('#ts-to').value   = _lastOfMonthISO();
    _renderTopSellers();
  });
  $('#ts-quick-all')?.addEventListener('click', () => {
    $('#ts-from').value = '';
    $('#ts-to').value   = '';
    _renderTopSellers();
  });
  document.querySelectorAll('.ts-filter-btn').forEach(b => {
    b.addEventListener('click', () => {
      _tsFilter = b.dataset.tsFilter;
      _renderTopSellers();
    });
  });
  $('#btn-show-low').addEventListener('click', () => {
    state.showLowOnly = !state.showLowOnly;
    $('#btn-show-low').textContent = state.showLowOnly ? 'Show All' : 'Low Stock Only';
    renderInventoryCategoryView();
    if (state.currentInvCategory) renderInventoryList();
  });
  $('#inv-cat-search').addEventListener('input', debounce(renderInventoryCategoryView, 100));
  $('#inv-search').addEventListener('input', debounce(renderInventoryList, 100));
  $('#btn-inv-back').addEventListener('click', () => {
    state.currentInvCategory = null;
    $('#inv-list-view').classList.add('hidden');
    $('#inv-cat-view').classList.remove('hidden');
    renderInventoryCategoryView();
  });

  // GRN now uses a multi-row grid (modal-grn rewritten) — its own
  // per-row product search is wired by _wireGrnProductSearch when rows
  // are added, so no global _wireProductPicker call here for GRN.
  _wireProductPicker($('#adj-search'), $('#adj-dropdown'), (p) => {
    state.adjTarget = p;
    const box = $('#adj-selected');
    box.classList.remove('hidden');
    box.innerHTML = `Selected: <b>${escapeHTML(p.shortCode)}</b> — ${escapeHTML(p.name)} (current stock: ${p.stockQty})`;
    $('#adj-qty').value = p.stockQty;
  });

  $('#grn-save').addEventListener('click', _saveGRN);
  $('#grn-add-row')?.addEventListener('click', () => _grnAddRow());
  $('#grn-clear')?.addEventListener('click', () => {
    if (!$('#grn-body').children.length) return;
    if (!confirm('Clear all rows?')) return;
    $('#grn-body').innerHTML = '';
    for (let i = 0; i < 3; i++) _grnAddRow();
  });
  $('#adj-save').addEventListener('click', _saveAdj);

  document.addEventListener('toolbill:categories-changed', renderInventoryCategoryView);
  document.addEventListener('toolbill:data-restored', renderInventoryCategoryView);

  registerTabRenderer('inventory', renderInventoryCategoryView);
}
