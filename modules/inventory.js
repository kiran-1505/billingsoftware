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

// ---- GRN ----
function _openGRNModal() {
  state.grnTarget = null;
  $('#grn-search').value = '';
  $('#grn-qty').value    = '';
  $('#grn-ref').value    = '';
  $('#grn-selected').classList.add('hidden');
  openModal('modal-grn');
  setTimeout(() => $('#grn-search').focus(), 50);
}

async function _saveGRN() {
  if (!state.grnTarget) return toast('Pick a product', 'error');
  const qty = parseInt($('#grn-qty').value, 10);
  const ref = $('#grn-ref').value.trim();
  if (!(qty > 0)) return toast('Enter a positive quantity', 'error');
  const p = await db.get('products', state.grnTarget.id);
  p.stockQty = (p.stockQty || 0) + qty;
  p.updatedAt = nowISO();
  await db.put('products', p);
  await db.add('stockMovements', {
    productId: p.id, type: 'receipt', qty,
    reason: 'GRN' + (ref ? ' · ' + ref : ''), date: nowISO(),
  });
  closeModal('modal-grn');
  toast(`Added ${qty} to ${p.shortCode}`, 'success');
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
export function wireInventory() {
  $('#btn-grn').addEventListener('click', _openGRNModal);
  $('#btn-adjust').addEventListener('click', _openAdjModal);
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

  _wireProductPicker($('#grn-search'), $('#grn-dropdown'), (p) => {
    state.grnTarget = p;
    const box = $('#grn-selected');
    box.classList.remove('hidden');
    box.innerHTML = `Selected: <b>${escapeHTML(p.shortCode)}</b> — ${escapeHTML(p.name)} (current stock: ${p.stockQty})`;
  });
  _wireProductPicker($('#adj-search'), $('#adj-dropdown'), (p) => {
    state.adjTarget = p;
    const box = $('#adj-selected');
    box.classList.remove('hidden');
    box.innerHTML = `Selected: <b>${escapeHTML(p.shortCode)}</b> — ${escapeHTML(p.name)} (current stock: ${p.stockQty})`;
    $('#adj-qty').value = p.stockQty;
  });

  $('#grn-save').addEventListener('click', _saveGRN);
  $('#adj-save').addEventListener('click', _saveAdj);

  document.addEventListener('toolbill:categories-changed', renderInventoryCategoryView);
  document.addEventListener('toolbill:data-restored', renderInventoryCategoryView);

  registerTabRenderer('inventory', renderInventoryCategoryView);
}
