// modules/products.js — products tab, product modal, bulk add, category manager
import { db } from '../db.js';
import {
  state, $, $$, fmtMoney, fmtInt, nowISO, escapeHTML, toast,
  openModal, closeModal, canonicalCategory, debounce, compressImage,
  refreshCategories, refreshProducts, populateCategorySelects, registerTabRenderer,
  LEGACY_CAT_CODE, decodeCostCode, encodeCostCode,
} from './core.js';

let _productModalImage = null;
let _prodViewMode = 'list'; // 'list' | 'card'
let _catViewMode  = 'card'; // 'card' | 'list'

// ---- Product counts helper (also used by billing's sell pane via state) ----
export function productCountsByCategory() {
  const counts = {};
  for (const c of state.categories) counts[c.name] = 0;
  for (const p of state.products) {
    const n = canonicalCategory(p.category);
    counts[n] = (counts[n] || 0) + 1;
  }
  return counts;
}

// ---- Category view ----
function _onCatClick(catName) {
  state.currentProductsCategory = catName;
  $('#products-list-title').textContent = catName;
  $('#products-cat-view').classList.add('hidden');
  $('#products-list-view').classList.remove('hidden');
  $('#product-search').value = '';
  renderProductsList();
  setTimeout(() => $('#product-search').focus(), 30);
}

function _catFilteredList() {
  const q      = $('#products-cat-search').value.trim().toLowerCase();
  const counts = productCountsByCategory();
  return state.categories
    .map(c => ({ ...c, count: counts[c.name] || 0 }))
    .filter(c => !q || c.name.toLowerCase().includes(q));
}

function _renderCategoryCardView() {
  const cats = _catFilteredList();
  const grid  = $('#products-cat-grid');
  if (!cats.length) {
    grid.innerHTML = `<div class="col-span-full text-center py-8 text-gray-400">No categories. Click "+ New Category" to add one.</div>`;
    return;
  }
  grid.innerHTML = cats.map(c => `
    <button class="cat-card text-left" data-cat="${escapeHTML(c.name)}">
      ${c.image
        ? `<img src="${escapeHTML(c.image)}" class="w-full h-24 object-cover rounded mb-2" />`
        : `<div class="w-full h-24 rounded mb-2 bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-3xl">${escapeHTML(c.name.slice(0, 2).toUpperCase())}</div>`}
      <div class="font-semibold text-gray-800 truncate">${escapeHTML(c.name)}</div>
      <div class="text-xs text-gray-500 mt-1">${fmtInt(c.count)} ${c.count === 1 ? 'item' : 'items'}</div>
    </button>
  `).join('');
  grid.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => _onCatClick(b.dataset.cat)));
}

function _renderCategoryListView() {
  const cats = _catFilteredList();
  const list  = $('#products-cat-list');
  if (!cats.length) {
    list.innerHTML = `<div class="p-4 text-center text-gray-400">No categories.</div>`;
    return;
  }
  list.innerHTML = cats.map(c => `
    <button class="w-full flex items-center gap-3 p-3 hover:bg-gray-50 text-left border-b last:border-0" data-cat="${escapeHTML(c.name)}">
      ${c.image
        ? `<img src="${escapeHTML(c.image)}" class="w-20 h-14 object-cover rounded flex-shrink-0" />`
        : `<div class="w-20 h-14 rounded bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-2xl flex-shrink-0">${escapeHTML(c.name.slice(0, 2).toUpperCase())}</div>`}
      <div class="flex-1 min-w-0">
        <div class="font-semibold text-gray-800 truncate">${escapeHTML(c.name)}</div>
        <div class="text-xs text-gray-500">${fmtInt(c.count)} ${c.count === 1 ? 'item' : 'items'}</div>
      </div>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="flex-shrink-0 text-gray-400"><polyline points="9 18 15 12 9 6"/></svg>
    </button>
  `).join('');
  list.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => _onCatClick(b.dataset.cat)));
}

export function renderProductsCategoryView() {
  $('#products-list-view').classList.add('hidden');
  $('#products-cat-view').classList.remove('hidden');
  if (_catViewMode === 'list') {
    $('#products-cat-grid').classList.add('hidden');
    $('#products-cat-list').classList.remove('hidden');
    _renderCategoryListView();
  } else {
    $('#products-cat-grid').classList.remove('hidden');
    $('#products-cat-list').classList.add('hidden');
    _renderCategoryCardView();
  }
}

function _productsFilteredForList() {
  const q   = $('#product-search').value.trim().toLowerCase();
  const cat = state.currentProductsCategory;
  return state.products.filter(p => {
    if (cat && canonicalCategory(p.category) !== cat) return false;
    return !q || (p.name || '').toLowerCase().includes(q) || (p.shortCode || '').toLowerCase().includes(q);
  });
}

export function renderProductsList() {
  const list = _productsFilteredForList();
  $('#product-count').textContent = `${list.length} of ${state.products.length} products`;

  // --- Table (list) view ---
  const body = $('#products-body');
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-gray-400">No products in this category yet. Click "+ Add Product".</td></tr>`;
  } else {
    body.innerHTML = list.map(p => `
      <tr>
        <td class="mono">${escapeHTML(p.shortCode)}</td>
        <td>
          <div class="flex items-center gap-2">
            ${p.image ? `<img src="${escapeHTML(p.image)}" class="w-8 h-8 object-cover rounded flex-shrink-0" />` : ''}
            <span>${escapeHTML(p.name)}</span>
          </div>
        </td>
        <td>${escapeHTML(canonicalCategory(p.category))}</td>
        <td>${escapeHTML(p.unit || 'piece')}</td>
        <td class="text-right">${fmtMoney(p.sellingPrice)}</td>
        <td class="text-right ${p.stockQty <= (p.reorderLevel || 0) ? 'stock-low' : ''}">${fmtInt(p.stockQty)}</td>
        <td class="whitespace-nowrap">
          <button class="text-blue-600 text-sm hover:underline mr-2" data-edit="${p.id}">Edit</button>
          <button class="text-gray-700 text-sm hover:underline mr-2" data-label="${p.id}">Label</button>
          <button class="text-red-600 text-sm hover:underline" data-del="${p.id}">Del</button>
        </td>
      </tr>`).join('');
    body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openProductModal(+b.dataset.edit)));
    body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => _deleteProduct(+b.dataset.del)));
    body.querySelectorAll('[data-label]').forEach(b => b.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('toolbill:show-label', { detail: +b.dataset.label }));
    }));
  }

  // --- Card view ---
  if (_prodViewMode === 'card') _renderProductsCardView(list);
}

function _renderProductsCardView(list) {
  list = list || _productsFilteredForList();
  const container = $('#products-card-container');
  if (!list.length) {
    container.innerHTML = `<div class="col-span-full text-center py-8 text-gray-400">No products in this category yet. Click "+ Add Product".</div>`;
    return;
  }
  container.innerHTML = list.map(p => {
    const initials   = (p.name || '??').slice(0, 2).toUpperCase();
    const stockClass = p.stockQty <= (p.reorderLevel || 0) ? 'text-red-600 font-bold' : 'text-gray-600';
    return `
      <div class="relative bg-white border rounded-lg overflow-hidden shadow-sm flex flex-col">
        ${p.image
          ? `<img src="${escapeHTML(p.image)}" class="w-full h-28 object-cover flex-shrink-0" />`
          : `<div class="w-full h-28 bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-3xl flex-shrink-0">${escapeHTML(initials)}</div>`
        }
        <!-- 3-dot kebab menu -->
        <button class="absolute top-1.5 right-1.5 w-7 h-7 bg-white bg-opacity-90 rounded-full flex items-center justify-center text-gray-600 hover:bg-gray-100 shadow text-base leading-none font-bold" data-prod-menu="${p.id}">&#8942;</button>
        <div id="prod-menu-${p.id}" class="hidden absolute top-9 right-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 w-36 text-sm overflow-hidden">
          <button class="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2" data-edit="${p.id}">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Edit
          </button>
          <button class="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2" data-label="${p.id}">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>Label
          </button>
          <label class="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2 cursor-pointer">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>Change photo
            <input type="file" accept="image/*" class="hidden" data-card-img="${p.id}" />
          </label>
          <button class="w-full text-left px-3 py-2 hover:bg-red-50 text-red-600 flex items-center gap-2" data-del="${p.id}">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>Delete
          </button>
        </div>
        <div class="p-2 flex flex-col flex-1">
          <div class="font-semibold text-gray-800 text-sm leading-tight" title="${escapeHTML(p.name)}">${escapeHTML(p.name)}</div>
          <div class="text-xs text-gray-500 truncate mt-0.5">${escapeHTML(canonicalCategory(p.category))}</div>
          <div class="mt-auto pt-1.5 flex items-center justify-between">
            <span class="font-bold text-gray-800">${fmtMoney(p.sellingPrice)}</span>
            <span class="text-xs ${stockClass}">Qty: ${fmtInt(p.stockQty)}</span>
          </div>
        </div>
      </div>`;
  }).join('');

  // Wire 3-dot menu toggle
  container.querySelectorAll('[data-prod-menu]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id   = btn.dataset.prodMenu;
      const menu = document.getElementById(`prod-menu-${id}`);
      const wasHidden = menu.classList.contains('hidden');
      // Close all menus first
      container.querySelectorAll('[id^="prod-menu-"]').forEach(m => m.classList.add('hidden'));
      if (wasHidden) menu.classList.remove('hidden');
    });
  });

  // Edit / Label / Delete actions
  container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openProductModal(+b.dataset.edit)));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => _deleteProduct(+b.dataset.del)));
  container.querySelectorAll('[data-label]').forEach(b => b.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('toolbill:show-label', { detail: +b.dataset.label }));
  }));

  // Change photo
  container.querySelectorAll('[data-card-img]').forEach(input => {
    input.addEventListener('change', async () => {
      if (!input.files[0]) return;
      const id = +input.dataset.cardImg;
      const p  = state.products.find(x => x.id === id);
      if (!p) return;
      p.image     = await compressImage(input.files[0]);
      p.updatedAt = nowISO();
      await db.put('products', p);
      await refreshProducts();
      _renderProductsCardView();
      toast('Photo updated', 'success');
    });
  });
}

// ---- Product modal ----
export function openProductModal(id) {
  const editing = id ? state.products.find(p => p.id === id) : null;
  $('#product-modal-title').textContent = editing ? 'Edit product' : 'Add product';
  $('#pm-name').value      = editing?.name || '';
  $('#pm-category').value  = editing?.category
    ? canonicalCategory(editing.category)
    : (state.currentProductsCategory || state.categories[0]?.name || 'General');
  $('#pm-unit').value      = editing?.unit || 'piece';
  $('#pm-price').value     = editing?.sellingPrice ?? '';
  $('#pm-stock').value     = editing?.stockQty ?? 0;
  $('#pm-reorder').value   = editing?.reorderLevel ?? 5;
  $('#pm-hsn').value       = editing?.hsn || '';
  // CGST/SGST: prefer explicit fields, else split legacy gstRate in half, else default 9/9
  const editCgst = editing?.cgstRate != null ? editing.cgstRate
                 : editing?.gstRate  != null ? editing.gstRate / 2
                 : 9;
  const editSgst = editing?.sgstRate != null ? editing.sgstRate
                 : editing?.gstRate  != null ? editing.gstRate / 2
                 : 9;
  $('#pm-cgst-rate').value = String(editCgst);
  $('#pm-sgst-rate').value = String(editSgst);
  _updateGstTotalLabel();
  $('#pm-shortcode').value = editing?.shortCode || '';
  $('#pm-save').dataset.editingId = editing?.id || '';

  _productModalImage = editing?.image || null;
  _setProductModalImagePreview(_productModalImage);

  const imgInput = $('#pm-img-input');
  const newInput = imgInput.cloneNode(true);
  imgInput.replaceWith(newInput);
  newInput.addEventListener('change', async () => {
    if (!newInput.files[0]) return;
    _productModalImage = await compressImage(newInput.files[0]);
    _setProductModalImagePreview(_productModalImage);
  });
  $('#pm-img-clear').addEventListener('click', () => {
    _productModalImage = null;
    _setProductModalImagePreview(null);
  }, { once: true });

  // Cost code field — always visible so user can enter codes anytime
  const ccWrap = $('#pm-costcode-wrap');
  if (ccWrap) ccWrap.style.display = '';
  const ccInput = $('#pm-costcode');
  if (ccInput) ccInput.value = editing?.costCode || '';

  if (!editing) _updatePendingShortCode();
  openModal('modal-product');
  setTimeout(() => $('#pm-name').focus(), 50);
}

function _setProductModalImagePreview(src) {
  const preview     = $('#pm-img-preview');
  const placeholder = $('#pm-img-placeholder');
  const clearBtn    = $('#pm-img-clear');
  if (src) {
    preview.src           = src;
    preview.style.display = '';
    placeholder.style.display = 'none';
    clearBtn.style.display    = '';
  } else {
    preview.style.display     = 'none';
    placeholder.style.display = '';
    clearBtn.style.display    = 'none';
  }
}

async function _updatePendingShortCode() {
  if ($('#pm-save').dataset.editingId) return;
  $('#pm-shortcode').value = await db.nextShortCode();
}

function _updateGstTotalLabel() {
  const c = parseFloat($('#pm-cgst-rate')?.value) || 0;
  const s = parseFloat($('#pm-sgst-rate')?.value) || 0;
  const el = $('#pm-gst-total');
  if (el) el.textContent = (c + s).toFixed(2);
}

async function _saveProductFromModal() {
  const name      = $('#pm-name').value.trim();
  const category  = $('#pm-category').value;
  const unit      = $('#pm-unit').value;
  const price     = parseFloat($('#pm-price').value);
  const stock     = parseInt($('#pm-stock').value || '0', 10);
  const reorder   = parseInt($('#pm-reorder').value || '0', 10);
  const hsn       = $('#pm-hsn').value.trim();
  const cgstRate  = parseFloat($('#pm-cgst-rate').value) || 0;
  const sgstRate  = parseFloat($('#pm-sgst-rate').value) || 0;
  const gstRate   = cgstRate + sgstRate; // back-compat field
  const costCode  = ($('#pm-costcode')?.value || '').trim().toLowerCase() || null;
  const editingId = $('#pm-save').dataset.editingId;

  if (!name)         return toast('Name required', 'error');
  if (!category)     return toast('Pick a category', 'error');
  if (!(price >= 0)) return toast('Valid price required', 'error');

  try {
    if (editingId) {
      const p = await db.get('products', +editingId);
      p.name = name; p.category = category; p.unit = unit;
      p.sellingPrice = price; p.reorderLevel = reorder; p.hsn = hsn;
      p.gstRate = gstRate; p.cgstRate = cgstRate; p.sgstRate = sgstRate;
      p.image = _productModalImage; p.costCode = costCode;
      p.updatedAt = nowISO();
      if (stock !== p.stockQty) {
        await db.add('stockMovements', {
          productId: p.id, type: 'adjust', qty: stock - p.stockQty,
          reason: 'Edit product stock', date: nowISO(),
        });
        p.stockQty = stock;
      }
      await db.put('products', p);
      toast('Product updated', 'success');
    } else {
      const shortCode = await db.nextShortCode();
      const prod = {
        shortCode, name, category, unit,
        sellingPrice: price, stockQty: stock, reorderLevel: reorder, hsn,
        image: _productModalImage, costCode, gstRate, cgstRate, sgstRate,
        createdAt: nowISO(), updatedAt: nowISO(),
      };
      const newId = await db.add('products', prod);
      if (stock > 0) {
        await db.add('stockMovements', {
          productId: newId, type: 'receipt', qty: stock,
          reason: 'Opening stock', date: nowISO(),
        });
      }
      toast(`Added ${shortCode}`, 'success');
    }
    closeModal('modal-product');
    await refreshProducts();
    if (state.currentProductsCategory) renderProductsList();
    else renderProductsCategoryView();
  } catch (e) {
    console.error(e);
    toast('Save failed: ' + e.message, 'error');
  }
}

async function _deleteProduct(id) {
  const p = state.products.find(x => x.id === id);
  if (!p) return;
  if (!confirm(`Delete ${p.shortCode} — ${p.name}?\nThis removes it from the master list. Past bills are kept.`)) return;
  await db.del('products', id);
  await refreshProducts();
  renderProductsList();
  toast('Deleted', 'success');
}

// ---- Bulk add ----
function _openBulkModal() {
  $('#bulk-text').value = '';
  $('#bulk-parse-summary').textContent = '';
  $('#bulk-save').disabled = true;
  state.bulkPreview = null;
  openModal('modal-bulk');
}

function _parseBulk() {
  const text = $('#bulk-text').value.trim();
  if (!text) { toast('Paste some rows first', 'error'); return; }
  const rows   = text.split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  const parsed = [];
  const errors = [];
  const catByLower = Object.fromEntries(state.categories.map(c => [c.name.toLowerCase(), c.name]));
  rows.forEach((r, i) => {
    const parts = r.includes('\t') ? r.split('\t') : r.split(',');
    const [name, cat, price, unit, stock, reorder] = parts.map(s => (s || '').trim());
    if (!name) { errors.push(`Row ${i + 1}: missing name`); return; }
    let catName = catByLower[(cat || '').toLowerCase()];
    if (!catName) {
      const legacy = LEGACY_CAT_CODE[(cat || '').toUpperCase()];
      if (legacy && catByLower[legacy.toLowerCase()]) catName = legacy;
    }
    if (!catName) { errors.push(`Row ${i + 1}: unknown category "${cat}"`); return; }
    const priceNum = parseFloat(price);
    if (!(priceNum >= 0)) { errors.push(`Row ${i + 1}: invalid price`); return; }
    parsed.push({ name, category: catName, sellingPrice: priceNum, unit: unit || 'piece', stockQty: parseInt(stock || '0', 10) || 0, reorderLevel: parseInt(reorder || '5', 10) || 0 });
  });
  state.bulkPreview = parsed;
  const summary = `Parsed ${parsed.length} row(s)` + (errors.length ? ` — ${errors.length} error(s): ` + errors.slice(0, 3).join(' | ') : '');
  $('#bulk-parse-summary').textContent = summary;
  $('#bulk-save').disabled = parsed.length === 0;
}

async function _saveBulk() {
  if (!state.bulkPreview?.length) return;
  let saved = 0;
  for (const row of state.bulkPreview) {
    const shortCode = await db.nextShortCode();
    const prod = { ...row, shortCode, gstRate: 18, hsn: '', createdAt: nowISO(), updatedAt: nowISO() };
    const newId = await db.add('products', prod);
    if (prod.stockQty > 0) {
      await db.add('stockMovements', { productId: newId, type: 'receipt', qty: prod.stockQty, reason: 'Opening stock (bulk)', date: nowISO() });
    }
    saved++;
  }
  closeModal('modal-bulk');
  toast(`Saved ${saved} product(s)`, 'success');
  await refreshProducts();
  renderProductsCategoryView();
}

// ---- Category manager ----
export function openCategoryManager() {
  renderCategoryManager();
  openModal('modal-category');
  setTimeout(() => $('#cat-new-name').focus(), 50);
}

export function renderCategoryManager() {
  const counts = productCountsByCategory();
  const box    = $('#cat-list');
  if (!state.categories.length) {
    box.innerHTML = `<div class="text-sm text-gray-500">No categories yet.</div>`;
    return;
  }
  box.innerHTML = state.categories.map(c => {
    const n         = counts[c.name] || 0;
    const canDelete = n === 0;
    return `
      <div class="flex items-center gap-2 p-2 border rounded">
        <div class="relative flex-shrink-0">
          <label class="cursor-pointer block" title="Click to upload image">
            ${c.image
              ? `<img src="${escapeHTML(c.image)}" class="w-10 h-10 object-cover rounded border border-gray-200" />`
              : `<div class="w-10 h-10 rounded bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-base">${escapeHTML(c.name.slice(0, 2).toUpperCase())}</div>`}
            <input type="file" accept="image/*" class="hidden" data-cat-img="${c.id}" />
          </label>
          ${c.image ? `<button data-cat-img-remove="${c.id}" title="Remove image" class="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full text-xs flex items-center justify-center leading-none">&times;</button>` : ''}
        </div>
        <div class="flex-1">
          <input type="text" class="w-full p-1 border rounded" data-cat-edit="${c.id}" value="${escapeHTML(c.name)}" />
        </div>
        <span class="text-xs text-gray-500 w-16 text-right flex-shrink-0">${fmtInt(n)} item${n === 1 ? '' : 's'}</span>
        <button class="text-blue-600 text-sm hover:underline flex-shrink-0" data-cat-save="${c.id}">Save</button>
        <button class="cart-rm-btn flex-shrink-0 ${canDelete ? '' : 'opacity-40 cursor-not-allowed'}"
                data-cat-del="${c.id}" ${canDelete ? '' : 'disabled'}
                title="${canDelete ? 'Delete' : 'Has products — reassign them first'}">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>`;
  }).join('');

  box.querySelectorAll('[data-cat-save]').forEach(b => b.addEventListener('click', async () => {
    const id      = +b.dataset.catSave;
    const input   = box.querySelector(`[data-cat-edit="${id}"]`);
    const newName = (input.value || '').trim();
    if (!newName) return toast('Name required', 'error');
    const cat = state.categories.find(x => x.id === id);
    if (!cat || cat.name === newName) return;
    if (state.categories.some(x => x.id !== id && x.name.toLowerCase() === newName.toLowerCase())) {
      return toast('Category with that name already exists', 'error');
    }
    const oldName = cat.name;
    cat.name = newName;
    await db.put('categories', cat);
    for (const p of state.products) {
      if (canonicalCategory(p.category) === oldName) {
        p.category = newName; p.updatedAt = nowISO();
        await db.put('products', p);
      }
    }
    if (state.currentProductsCategory === oldName) state.currentProductsCategory = newName;
    await refreshCategories();
    await refreshProducts();
    populateCategorySelects();
    renderCategoryManager();
    renderProductsCategoryView();
    document.dispatchEvent(new CustomEvent('toolbill:categories-changed'));
    toast('Category renamed', 'success');
  }));

  box.querySelectorAll('[data-cat-del]').forEach(b => b.addEventListener('click', async () => {
    if (b.disabled) return;
    const id  = +b.dataset.catDel;
    const cat = state.categories.find(x => x.id === id);
    if (!cat || !confirm(`Delete category "${cat.name}"?`)) return;
    await db.del('categories', id);
    await refreshCategories();
    populateCategorySelects();
    renderCategoryManager();
    renderProductsCategoryView();
    document.dispatchEvent(new CustomEvent('toolbill:categories-changed'));
    toast('Deleted', 'success');
  }));

  box.querySelectorAll('[data-cat-img]').forEach(input => {
    input.addEventListener('change', async () => {
      if (!input.files[0]) return;
      const id  = +input.dataset.catImg;
      const cat = state.categories.find(x => x.id === id);
      if (!cat) return;
      cat.image = await compressImage(input.files[0]);
      await db.put('categories', cat);
      await refreshCategories();
      renderCategoryManager();
      renderProductsCategoryView();
      document.dispatchEvent(new CustomEvent('toolbill:categories-changed'));
      toast('Image updated', 'success');
    });
  });

  box.querySelectorAll('[data-cat-img-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id  = +btn.dataset.catImgRemove;
      const cat = state.categories.find(x => x.id === id);
      if (!cat) return;
      delete cat.image;
      await db.put('categories', cat);
      await refreshCategories();
      renderCategoryManager();
      renderProductsCategoryView();
      document.dispatchEvent(new CustomEvent('toolbill:categories-changed'));
      toast('Image removed', 'success');
    });
  });
}

async function _addCategoryFromInput() {
  const input = $('#cat-new-name');
  const name  = (input.value || '').trim();
  if (!name) return toast('Enter a name', 'error');
  if (state.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    return toast('Already exists', 'error');
  }
  await db.add('categories', { name, createdAt: nowISO() });
  input.value = '';
  await refreshCategories();
  populateCategorySelects();
  renderCategoryManager();
  renderProductsCategoryView();
  document.dispatchEvent(new CustomEvent('toolbill:categories-changed'));
  toast(`Added "${name}"`, 'success');
}

// ---- View-toggle helpers ----
function _setCatViewButtons() {
  $('#btn-cat-card-view').className = `px-3 py-1.5 text-sm ${_catViewMode === 'card' ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`;
  $('#btn-cat-list-view').className = `px-3 py-1.5 text-sm ${_catViewMode === 'list' ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`;
}
function _setProdViewButtons() {
  $('#btn-prod-list-view').className = `px-3 py-1.5 text-sm ${_prodViewMode === 'list' ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`;
  $('#btn-prod-card-view').className = `px-3 py-1.5 text-sm ${_prodViewMode === 'card' ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`;
}

// ---- Wire ----
export function wireProducts() {
  $('#products-cat-search').addEventListener('input', debounce(renderProductsCategoryView, 100));
  $('#btn-manage-categories').addEventListener('click', openCategoryManager);
  $('#btn-add-product').addEventListener('click', () => openProductModal(null));
  $('#btn-add-product-2').addEventListener('click', () => openProductModal(null));
  $('#btn-bulk-add').addEventListener('click', _openBulkModal);
  $('#pm-save').addEventListener('click', _saveProductFromModal);
  $('#pm-cgst-rate').addEventListener('input', _updateGstTotalLabel);
  $('#pm-sgst-rate').addEventListener('input', _updateGstTotalLabel);
  $('#bulk-parse').addEventListener('click', _parseBulk);
  $('#bulk-save').addEventListener('click', _saveBulk);
  $('#product-search').addEventListener('input', debounce(renderProductsList, 100));
  $('#btn-products-back').addEventListener('click', () => {
    state.currentProductsCategory = null;
    $('#products-list-view').classList.add('hidden');
    $('#products-cat-view').classList.remove('hidden');
    renderProductsCategoryView();
  });

  // Category card/list toggle
  $('#btn-cat-card-view').addEventListener('click', () => {
    _catViewMode = 'card';
    _setCatViewButtons();
    renderProductsCategoryView();
  });
  $('#btn-cat-list-view').addEventListener('click', () => {
    _catViewMode = 'list';
    _setCatViewButtons();
    renderProductsCategoryView();
  });

  // Product list/card toggle
  $('#btn-prod-list-view').addEventListener('click', () => {
    _prodViewMode = 'list';
    _setProdViewButtons();
    $('#products-list-container').classList.remove('hidden');
    $('#products-card-container').classList.add('hidden');
  });
  $('#btn-prod-card-view').addEventListener('click', () => {
    _prodViewMode = 'card';
    _setProdViewButtons();
    $('#products-list-container').classList.add('hidden');
    $('#products-card-container').classList.remove('hidden');
    _renderProductsCardView();
  });

  // Close product 3-dot menus on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('[id^="prod-menu-"]').forEach(m => m.classList.add('hidden'));
  });

  document.addEventListener('toolbill:data-restored', renderProductsCategoryView);
  document.addEventListener('toolbill:categories-changed', () => {
    renderProductsCategoryView();
    if (state.currentProductsCategory) renderProductsList();
  });

  registerTabRenderer('products', renderProductsCategoryView);
}

export function wireCategoryManager() {
  $('#cat-add-btn').addEventListener('click', _addCategoryFromInput);
  $('#cat-new-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); _addCategoryFromInput(); }
  });
}
