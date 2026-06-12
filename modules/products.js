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

// Display the price the customer actually pays — Our Price if set, else MRP.
const _displayPrice = (p) =>
  (p?.ourPrice != null && p?.ourPrice !== '') ? Number(p.ourPrice) : (p?.sellingPrice ?? 0);
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
        ? `<img src="${escapeHTML(c.image)}" class="w-full h-40 object-cover rounded mb-2" />`
        : `<div class="w-full h-40 rounded mb-2 bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-3xl">${escapeHTML(c.name.slice(0, 2).toUpperCase())}</div>`}
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
        <td class="text-right">${fmtMoney(_displayPrice(p))}</td>
        <td class="text-right ${p.stockQty <= (p.reorderLevel || 0) ? 'stock-low' : ''}">${fmtInt(p.stockQty)}</td>
        <td class="whitespace-nowrap">
          <button class="text-blue-600 text-sm hover:underline mr-2" data-edit="${p.id}">Edit</button>
          <button class="text-gray-700 text-sm hover:underline mr-2" data-label="${p.id}">Label</button>
          <button class="text-emerald-700 text-sm hover:underline mr-2" data-buyers="${p.id}" title="When you reordered this item from suppliers">Reorders</button>
          <button class="text-red-600 text-sm hover:underline" data-del="${p.id}">Del</button>
        </td>
      </tr>`).join('');
    body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openProductModal(+b.dataset.edit)));
    body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => _deleteProduct(+b.dataset.del)));
    body.querySelectorAll('[data-label]').forEach(b => b.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('toolbill:show-label', { detail: +b.dataset.label }));
    }));
    body.querySelectorAll('[data-buyers]').forEach(b => b.addEventListener('click', () => _showProductBuyers(+b.dataset.buyers)));
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
          ? `<img src="${escapeHTML(p.image)}" class="w-full h-44 object-cover flex-shrink-0" />`
          : `<div class="w-full h-44 bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-3xl flex-shrink-0">${escapeHTML(initials)}</div>`
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
          <button class="w-full text-left px-3 py-2 hover:bg-emerald-50 text-emerald-700 flex items-center gap-2" data-buyers="${p.id}">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>Reorders
          </button>
          <button class="w-full text-left px-3 py-2 hover:bg-red-50 text-red-600 flex items-center gap-2" data-del="${p.id}">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>Delete
          </button>
        </div>
        <div class="p-2 flex flex-col flex-1">
          <div class="font-semibold text-gray-800 text-sm leading-tight" title="${escapeHTML(p.name)}">${escapeHTML(p.name)}</div>
          <div class="text-xs text-gray-500 truncate mt-0.5">${escapeHTML(canonicalCategory(p.category))}</div>
          <div class="mt-auto pt-1.5 flex items-center justify-between">
            <span class="font-bold text-gray-800">${fmtMoney(_displayPrice(p))}</span>
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

  // Edit / Label / Buyers / Delete actions
  container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openProductModal(+b.dataset.edit)));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => _deleteProduct(+b.dataset.del)));
  container.querySelectorAll('[data-buyers]').forEach(b => b.addEventListener('click', () => _showProductBuyers(+b.dataset.buyers)));
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
  $('#pm-our-price').value = editing?.ourPrice ?? '';
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
  const fxInput = $('#pm-fixed-code');
  if (fxInput) fxInput.value = editing?.fixedCode || '';

  // Reset inline "+ New category" mini form each open
  _resetNewCategoryMiniForm();

  if (!editing) _updatePendingShortCode();
  openModal('modal-product');
  setTimeout(() => $('#pm-name').focus(), 50);
}

// ---- Inline "+ New category" mini form inside product modal ----
let _newCatImage = null;

function _resetNewCategoryMiniForm() {
  const row = $('#pm-new-cat-row');
  if (!row) return;
  row.classList.add('hidden');
  $('#pm-new-cat-name').value = '';
  _newCatImage = null;
  const prev = $('#pm-new-cat-preview');
  const ph   = $('#pm-new-cat-placeholder');
  if (prev) { prev.style.display = 'none'; prev.src = ''; }
  if (ph)   ph.style.display = '';
  // Reset the file input so the same file can be re-picked
  const img = $('#pm-new-cat-img');
  if (img) img.value = '';
}

async function _addNewCategoryFromMiniForm() {
  const name = $('#pm-new-cat-name').value.trim();
  if (!name) return toast('Enter a category name', 'error');
  if (state.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    return toast('Category already exists', 'error');
  }
  await db.add('categories', {
    name,
    image: _newCatImage || null,
    createdAt: nowISO(),
  });
  await refreshCategories();
  populateCategorySelects();
  $('#pm-category').value = name;
  _resetNewCategoryMiniForm();
  document.dispatchEvent(new CustomEvent('toolbill:categories-changed'));
  toast(`Added "${name}"`, 'success');
}

// ---- Custom category dropdown for the product modal ----
let _catDdActive = -1;

function _renderCategoryDropdown() {
  const dd = $('#pm-category-dropdown');
  if (!dd) return;
  const q = ($('#pm-category').value || '').trim().toLowerCase();
  const matches = state.categories.filter(c => !q || c.name.toLowerCase().includes(q));
  if (!matches.length) {
    dd.innerHTML = `<div class="px-3 py-2 text-gray-400">No matches — use "+ New" to create</div>`;
    dd.classList.remove('hidden');
    _catDdActive = -1;
    return;
  }
  if (_catDdActive >= matches.length) _catDdActive = matches.length - 1;
  dd.innerHTML = matches.map((c, idx) => `
    <div class="cat-dd-item flex items-center gap-2 px-3 py-2 cursor-pointer ${idx === _catDdActive ? 'bg-blue-100' : 'hover:bg-gray-100'}" data-cat-name="${escapeHTML(c.name)}">
      ${c.image
        ? `<img src="${escapeHTML(c.image)}" class="w-6 h-6 object-cover rounded flex-shrink-0" />`
        : `<div class="w-6 h-6 rounded bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-[10px] flex-shrink-0">${escapeHTML(c.name.slice(0, 2).toUpperCase())}</div>`}
      <span>${escapeHTML(c.name)}</span>
    </div>
  `).join('');
  dd.classList.remove('hidden');

  dd.querySelectorAll('[data-cat-name]').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus so blur doesn't close before click registers
      $('#pm-category').value = el.dataset.catName;
      _closeCategoryDropdown();
    });
  });
}

function _closeCategoryDropdown() {
  const dd = $('#pm-category-dropdown');
  if (dd) dd.classList.add('hidden');
  _catDdActive = -1;
}

function _handleCategoryKey(e) {
  const dd = $('#pm-category-dropdown');
  if (!dd || dd.classList.contains('hidden')) return;
  const items = Array.from(dd.querySelectorAll('[data-cat-name]'));
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _catDdActive = Math.min(items.length - 1, _catDdActive + 1);
    _renderCategoryDropdown();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _catDdActive = Math.max(0, _catDdActive - 1);
    _renderCategoryDropdown();
  } else if (e.key === 'Enter' && _catDdActive >= 0 && items[_catDdActive]) {
    e.preventDefault();
    $('#pm-category').value = items[_catDdActive].dataset.catName;
    _closeCategoryDropdown();
  } else if (e.key === 'Escape') {
    _closeCategoryDropdown();
  }
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
  const typedCat  = $('#pm-category').value.trim();
  // Case-insensitive match against existing categories; auto-create if brand new
  let category = '';
  if (typedCat) {
    const match = state.categories.find(c => c.name.toLowerCase() === typedCat.toLowerCase());
    if (match) {
      category = match.name;
    } else {
      // Brand-new category typed in directly — auto-create (no image)
      await db.add('categories', { name: typedCat, createdAt: nowISO() });
      await refreshCategories();
      populateCategorySelects();
      document.dispatchEvent(new CustomEvent('toolbill:categories-changed'));
      category = typedCat;
      toast(`Created category "${typedCat}"`, 'success');
    }
  }
  const unit      = $('#pm-unit').value;
  const mrpRaw    = $('#pm-price').value.trim();
  const ourPriceRaw = $('#pm-our-price').value.trim();
  const ourPrice  = ourPriceRaw === '' ? NaN : parseFloat(ourPriceRaw);
  // MRP is optional — defaults to Our Price when blank
  const price     = mrpRaw === '' ? ourPrice : parseFloat(mrpRaw);
  const stock     = parseFloat($('#pm-stock').value || '0') || 0;
  const reorder   = parseFloat($('#pm-reorder').value || '0') || 0;
  const hsn       = $('#pm-hsn').value.trim();
  const cgstRate  = parseFloat($('#pm-cgst-rate').value) || 0;
  const sgstRate  = parseFloat($('#pm-sgst-rate').value) || 0;
  const gstRate   = cgstRate + sgstRate; // back-compat field
  const costCode  = ($('#pm-costcode')?.value || '').trim().toLowerCase() || null;
  const fixedCode = ($('#pm-fixed-code')?.value || '').trim().toLowerCase() || null;
  const editingId = $('#pm-save').dataset.editingId;

  if (!name)            return toast('Name required', 'error');
  if (!category)        return toast('Pick a category', 'error');
  if (!(ourPrice >= 0)) return toast('Our Price is required', 'error');

  try {
    if (editingId) {
      const p = await db.get('products', +editingId);
      p.name = name; p.category = category; p.unit = unit;
      p.sellingPrice = price; p.ourPrice = ourPrice;
      p.reorderLevel = reorder; p.hsn = hsn;
      p.gstRate = gstRate; p.cgstRate = cgstRate; p.sgstRate = sgstRate;
      p.image = _productModalImage; p.costCode = costCode; p.fixedCode = fixedCode;
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
        sellingPrice: price, ourPrice,
        stockQty: stock, reorderLevel: reorder, hsn,
        image: _productModalImage, costCode, fixedCode,
        gstRate, cgstRate, sgstRate,
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

// Show the shop owner's REORDER history for a product — i.e., every time
// they restocked the item (receipts via GRN or opening stock), showing:
//   • Date of each reorder
//   • Qty received
//   • Stock just BEFORE the reorder (so they see how low they let it run)
//   • Stock just AFTER the reorder
//   • Supplier / reason from the stock movement
//   • Gap (days) since the previous reorder — to spot patterns
async function _showProductBuyers(productId) {
  const product = state.products.find(p => p.id === productId);
  if (!product) return;

  const movements = await db.all('stockMovements');
  const prodMoves = movements
    .filter(m => m.productId === productId)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // Receipts are the "reorders" (qty > 0 stock additions from suppliers).
  // We also include 'adjust' rows with positive qty for completeness.
  const reorders = prodMoves.filter(m => (Number(m.qty) || 0) > 0);

  // Compute stock just before each movement: running sum of all earlier movements.
  const movesByDate = prodMoves; // already sorted asc
  let running = 0;
  const stockBeforeMap = new Map();
  for (const m of movesByDate) {
    stockBeforeMap.set(m, running);
    running += Number(m.qty) || 0;
  }
  // sanity: running ≈ product.stockQty (might differ if stockQty was edited
  // without a movement — but for our purposes the running balance from
  // movements is the audit trail of what we know).

  // Build the list newest first
  const list = reorders.slice().reverse().map((m, idx, arr) => {
    const stockBefore = stockBeforeMap.get(m) || 0;
    const qty = Number(m.qty) || 0;
    const stockAfter  = stockBefore + qty;
    // Previous reorder is the next item in this reversed array (older)
    const prev = arr[idx + 1];
    const gapDays = prev
      ? Math.round((new Date(m.date) - new Date(prev.date)) / 86400000)
      : null;
    return {
      date: m.date,
      qty,
      stockBefore,
      stockAfter,
      reason: m.reason || (m.type === 'receipt' ? 'Receipt' : m.type || ''),
      type: m.type || '',
      gapDays,
    };
  });

  const fmt    = (n) => '₹' + (Number(n) || 0).toFixed(2);
  const fmtQty = (n) => {
    const r = Number(n.toFixed(3));
    return Number.isInteger(r) ? String(r) : r.toString();
  };
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  // Header stats
  const totalQty   = reorders.reduce((s, m) => s + (Number(m.qty) || 0), 0);
  const lastDate   = list[0]?.date || '';
  const gaps       = list.map(r => r.gapDays).filter(g => g != null);
  const avgGap     = gaps.length ? Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length) : null;
  const currentStock = product.stockQty ?? 0;

  $('#buyers-title').textContent = product.name;
  $('#buyers-summary').innerHTML = `
    <div class="bg-gray-50 border rounded p-3">
      <div class="text-[10px] text-gray-500 uppercase tracking-wide">Times reordered</div>
      <div class="text-xl font-bold">${list.length}</div>
    </div>
    <div class="bg-gray-50 border rounded p-3">
      <div class="text-[10px] text-gray-500 uppercase tracking-wide">Total qty received</div>
      <div class="text-xl font-bold">${fmtQty(totalQty)}</div>
    </div>
    <div class="bg-gray-50 border rounded p-3">
      <div class="text-[10px] text-gray-500 uppercase tracking-wide">Avg gap (days)</div>
      <div class="text-xl font-bold">${avgGap != null ? avgGap : '—'}</div>
    </div>
    <div class="bg-emerald-50 border border-emerald-200 rounded p-3">
      <div class="text-[10px] text-emerald-700 uppercase tracking-wide">Current stock</div>
      <div class="text-xl font-bold text-emerald-700">${fmtQty(currentStock)}</div>
    </div>`;

  if (!list.length) {
    $('#buyers-body').innerHTML = `
      <div class="p-6 text-center text-gray-400 text-sm">
        No reorders recorded yet for this item.<br/>
        Use <strong>Receive Stock (GRN)</strong> from the Inventory tab when restocking.
      </div>`;
    openModal('modal-product-buyers');
    return;
  }

  $('#buyers-body').innerHTML = `
    <table class="w-full text-sm">
      <thead class="bg-gray-50 border-b text-xs uppercase text-gray-500 sticky top-0">
        <tr>
          <th class="text-right p-2 w-10">#</th>
          <th class="text-left p-2 w-36">Date</th>
          <th class="text-right p-2 w-24">Qty received</th>
          <th class="text-right p-2 w-28">Stock before</th>
          <th class="text-right p-2 w-28">Stock after</th>
          <th class="text-right p-2 w-24">Gap (days)</th>
          <th class="text-left p-2">Supplier / reference</th>
        </tr>
      </thead>
      <tbody>
        ${list.map((r, i) => {
          const lowBefore = r.stockBefore <= (product.reorderLevel || 0);
          const beforeClass = r.stockBefore <= 0 ? 'text-red-600 font-bold'
                          : lowBefore ? 'text-amber-600 font-semibold'
                          : 'text-gray-700';
          const tag = r.type === 'receipt' ? '' :
                       `<span class="ml-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-700">${escapeHTML(r.type)}</span>`;
          return `
            <tr class="border-b hover:bg-blue-50/40">
              <td class="p-2 text-right text-xs text-gray-400 mono">${list.length - i}</td>
              <td class="p-2">
                <div class="text-gray-800">${fmtDate(r.date)}</div>
                <div class="text-[10px] text-gray-400">${new Date(r.date).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</div>
              </td>
              <td class="p-2 text-right font-bold text-emerald-700">+${fmtQty(r.qty)}</td>
              <td class="p-2 text-right ${beforeClass}">${fmtQty(r.stockBefore)}</td>
              <td class="p-2 text-right">${fmtQty(r.stockAfter)}</td>
              <td class="p-2 text-right text-gray-600">${r.gapDays != null ? r.gapDays : '—'}</td>
              <td class="p-2 text-xs text-gray-700">${escapeHTML(r.reason)}${tag}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  openModal('modal-product-buyers');
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
// ---- Bulk add (Excel-style editable grid) ----
const _BULK_COLS = [
  { key: 'name',         type: 'text',   required: true },
  { key: 'category',     type: 'text',   required: true, datalist: true },
  { key: 'ourPrice',     type: 'number', required: true, step: '0.01', min: '0' },
  { key: 'sellingPrice', type: 'number', step: '0.01', min: '0' },
  { key: 'unit',         type: 'select', options: ['piece','set','box','meter','kg','litre','pack'], default: 'piece' },
  { key: 'stockQty',     type: 'number', step: '1', min: '0', default: '0' },
  { key: 'reorderLevel', type: 'number', step: '1', min: '0', default: '5' },
  { key: 'hsn',          type: 'text' },
  { key: 'cgstRate',     type: 'number', step: '0.01', min: '0', default: '9' },
  { key: 'sgstRate',     type: 'number', step: '0.01', min: '0', default: '9' },
  { key: 'costCode',     type: 'text' },
  { key: 'fixedCode',    type: 'text' },
];

function _bulkAddRow(values = {}) {
  const tbody = $('#bulk-body');
  const tr = document.createElement('tr');
  tr.innerHTML =
    `<td class="bulk-rownum"></td>` +
    _BULK_COLS.map(c => {
      const raw = values[c.key];
      const val = (raw !== undefined && raw !== '') ? raw : (c.default ?? '');
      if (c.type === 'select') {
        return `<td><select data-col="${c.key}" class="bulk-input">${c.options.map(o => `<option value="${o}" ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select></td>`;
      }
      const isCat = c.datalist ? 'data-bulk-cat="1"' : '';
      const step = c.step ? `step="${c.step}"` : '';
      const min  = c.min  ? `min="${c.min}"`  : '';
      return `<td><input type="${c.type}" data-col="${c.key}" class="bulk-input" ${isCat} ${step} ${min} value="${escapeHTML(String(val))}" autocomplete="off" /></td>`;
    }).join('') +
    `<td class="text-center"><button type="button" class="bulk-del-btn" title="Delete row">&times;</button></td>`;
  tbody.appendChild(tr);
  tr.querySelector('.bulk-del-btn').addEventListener('click', () => {
    tr.remove();
    _bulkRenumber();
    _bulkUpdateSummary();
  });
  tr.querySelectorAll('.bulk-input').forEach(el => el.addEventListener('input', _bulkUpdateSummary));
  // Wire the category search dropdown for any category input in this row
  tr.querySelectorAll('[data-bulk-cat]').forEach(_wireBulkCategoryDropdown);
  _bulkRenumber();
  _bulkUpdateSummary();
}

// ---- Floating category search dropdown (shared across all bulk rows) ----
let _bulkCatActiveInput = null;
let _bulkCatActiveIdx = -1;

function _bulkCatMatches() {
  const q = (_bulkCatActiveInput?.value || '').trim().toLowerCase();
  return state.categories
    .filter(c => !q || c.name.toLowerCase().includes(q))
    .slice(0, 50);
}

function _renderBulkCatDropdown() {
  const dd = $('#bulk-cat-dropdown');
  if (!dd || !_bulkCatActiveInput) return;
  const matches = _bulkCatMatches();
  const rect = _bulkCatActiveInput.getBoundingClientRect();
  dd.style.left  = rect.left + 'px';
  dd.style.top   = (rect.bottom + 2) + 'px';
  dd.style.width = Math.max(rect.width, 200) + 'px';
  if (!matches.length) {
    const q = (_bulkCatActiveInput.value || '').trim();
    dd.innerHTML = q
      ? `<div class="px-3 py-2 text-gray-500">No match — <strong>"${escapeHTML(q)}"</strong> will be created on save</div>`
      : `<div class="px-3 py-2 text-gray-400">No categories yet — type one</div>`;
    dd.classList.remove('hidden');
    _bulkCatActiveIdx = -1;
    return;
  }
  if (_bulkCatActiveIdx >= matches.length) _bulkCatActiveIdx = matches.length - 1;
  dd.innerHTML = matches.map((c, idx) => `
    <div class="px-3 py-2 cursor-pointer flex items-center gap-2 ${idx === _bulkCatActiveIdx ? 'bg-blue-100' : 'hover:bg-gray-100'}" data-cat="${escapeHTML(c.name)}">
      ${c.image
        ? `<img src="${escapeHTML(c.image)}" class="w-5 h-5 object-cover rounded flex-shrink-0" />`
        : `<div class="w-5 h-5 rounded bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-[9px] flex-shrink-0">${escapeHTML(c.name.slice(0, 2).toUpperCase())}</div>`}
      <span>${escapeHTML(c.name)}</span>
    </div>
  `).join('');
  dd.classList.remove('hidden');
  dd.querySelectorAll('[data-cat]').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent blur before we set the value
      if (_bulkCatActiveInput) {
        _bulkCatActiveInput.value = el.dataset.cat;
        _bulkCatActiveInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      _closeBulkCatDropdown();
    });
  });
}

function _closeBulkCatDropdown() {
  const dd = $('#bulk-cat-dropdown');
  if (dd) dd.classList.add('hidden');
  _bulkCatActiveInput = null;
  _bulkCatActiveIdx = -1;
}

function _wireBulkCategoryDropdown(input) {
  input.addEventListener('focus', () => {
    _bulkCatActiveInput = input;
    _bulkCatActiveIdx = -1;
    _renderBulkCatDropdown();
  });
  input.addEventListener('input', () => {
    _bulkCatActiveIdx = -1;
    _renderBulkCatDropdown();
  });
  input.addEventListener('keydown', (e) => {
    if ($('#bulk-cat-dropdown')?.classList.contains('hidden')) return;
    const matches = _bulkCatMatches();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _bulkCatActiveIdx = Math.min(matches.length - 1, _bulkCatActiveIdx + 1);
      _renderBulkCatDropdown();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _bulkCatActiveIdx = Math.max(0, _bulkCatActiveIdx - 1);
      _renderBulkCatDropdown();
    } else if (e.key === 'Enter' && _bulkCatActiveIdx >= 0 && matches[_bulkCatActiveIdx]) {
      e.preventDefault();
      input.value = matches[_bulkCatActiveIdx].name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      _closeBulkCatDropdown();
    } else if (e.key === 'Escape') {
      _closeBulkCatDropdown();
    }
  });
  input.addEventListener('blur', () => setTimeout(_closeBulkCatDropdown, 150));
}

function _bulkRenumber() {
  Array.from($('#bulk-body').children).forEach((tr, i) => {
    tr.firstElementChild.textContent = i + 1;
  });
}

function _openBulkModal() {
  $('#bulk-body').innerHTML = '';
  $('#bulk-parse-summary').textContent = '';
  $('#bulk-save').disabled = true;
  // Start with 5 empty rows for quick typing
  for (let i = 0; i < 5; i++) _bulkAddRow();
  openModal('modal-bulk');
  setTimeout(() => $('#bulk-body input,#bulk-body select')?.focus?.(), 50);
}

function _bulkReadRows() {
  const rows = [];
  for (const tr of $('#bulk-body').children) {
    const obj = {};
    let hasContent = false;
    tr.querySelectorAll('[data-col]').forEach(el => {
      const v = (el.value || '').trim();
      if (v && !['piece','0','5','9'].includes(v)) hasContent = true; // ignore default-only rows
      if (v) hasContent = true;
      obj[el.dataset.col] = v;
    });
    if (hasContent) rows.push({ obj, tr });
  }
  return rows;
}

function _bulkUpdateSummary() {
  const rows = _bulkReadRows();
  const errors = [];
  rows.forEach(({ obj, tr }, i) => {
    const cells = tr.querySelectorAll('[data-col]');
    cells.forEach(c => c.classList.remove('invalid'));
    let rowOk = true;
    if (!obj.name)     { errors.push(`Row ${i + 1}: name`); tr.querySelector('[data-col="name"]')?.classList.add('invalid'); rowOk = false; }
    if (!obj.category) { errors.push(`Row ${i + 1}: category`); tr.querySelector('[data-col="category"]')?.classList.add('invalid'); rowOk = false; }
    const op = parseFloat(obj.ourPrice);
    if (!(op >= 0))    { errors.push(`Row ${i + 1}: our price`); tr.querySelector('[data-col="ourPrice"]')?.classList.add('invalid'); rowOk = false; }
  });
  const sum = $('#bulk-parse-summary');
  if (!sum) return;
  if (!rows.length) {
    sum.textContent = 'Fill at least one row';
    sum.className = 'text-sm text-gray-500';
  } else if (errors.length) {
    sum.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} — ${errors.length} missing field${errors.length === 1 ? '' : 's'}: ${errors.slice(0, 3).join(' · ')}${errors.length > 3 ? '…' : ''}`;
    sum.className = 'text-sm text-red-600 font-medium';
  } else {
    sum.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} ready to save`;
    sum.className = 'text-sm text-green-700 font-medium';
  }
  $('#bulk-save').disabled = !rows.length || !!errors.length;
}

async function _bulkPasteFromClipboard() {
  try {
    if (!navigator.clipboard?.readText) throw new Error('Clipboard API not available — paste directly into a cell instead');
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) return toast('Clipboard is empty', 'error');
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    // Detect header row
    const firstLower = lines[0].toLowerCase();
    const looksLikeHeader = /name|category|price/.test(firstLower);
    const dataLines = looksLikeHeader ? lines.slice(1) : lines;
    if (!dataLines.length) return toast('No data rows in clipboard', 'error');
    // Clear empty default rows before pasting
    const existing = Array.from($('#bulk-body').children);
    for (const tr of existing) {
      const inputs = tr.querySelectorAll('[data-col]');
      const empty = Array.from(inputs).every(el => {
        const v = (el.value || '').trim();
        return !v || ['piece','0','5','9'].includes(v);
      });
      if (empty) tr.remove();
    }
    for (const line of dataLines) {
      const parts = line.includes('\t') ? line.split('\t') : line.split(',');
      const values = {};
      _BULK_COLS.forEach((c, i) => { values[c.key] = (parts[i] || '').trim(); });
      _bulkAddRow(values);
    }
    toast(`Pasted ${dataLines.length} row${dataLines.length === 1 ? '' : 's'}`, 'success');
  } catch (e) {
    console.error(e);
    toast('Could not paste: ' + e.message, 'error');
  }
}

async function _saveBulk() {
  const rows = _bulkReadRows();
  if (!rows.length) return;
  const catByLower = Object.fromEntries(state.categories.map(c => [c.name.toLowerCase(), c.name]));
  let saved = 0;
  let categoriesCreated = 0;
  for (const { obj: r } of rows) {
    // Auto-create category if it doesn't exist
    let category = catByLower[(r.category || '').toLowerCase()];
    if (!category) {
      await db.add('categories', { name: r.category, createdAt: nowISO() });
      category = r.category;
      catByLower[r.category.toLowerCase()] = r.category;
      categoriesCreated++;
    }
    const shortCode = await db.nextShortCode();
    const cgst = parseFloat(r.cgstRate) || 0;
    const sgst = parseFloat(r.sgstRate) || 0;
    const ourPrice = r.ourPrice ? parseFloat(r.ourPrice) : null;
    const mrp      = r.sellingPrice ? parseFloat(r.sellingPrice) : (ourPrice ?? 0);
    const prod = {
      shortCode,
      name: r.name,
      category,
      sellingPrice: mrp,
      ourPrice,
      unit: r.unit || 'piece',
      stockQty: parseFloat(r.stockQty || '0') || 0,
      reorderLevel: parseFloat(r.reorderLevel || '5') || 5,
      hsn: r.hsn || '',
      cgstRate: cgst,
      sgstRate: sgst,
      gstRate: cgst + sgst,
      costCode:  (r.costCode  || '').trim().toLowerCase() || null,
      fixedCode: (r.fixedCode || '').trim().toLowerCase() || null,
      createdAt: nowISO(), updatedAt: nowISO(),
    };
    const newId = await db.add('products', prod);
    if (prod.stockQty > 0) {
      await db.add('stockMovements', { productId: newId, type: 'receipt', qty: prod.stockQty, reason: 'Opening stock (bulk)', date: nowISO() });
    }
    saved++;
  }
  closeModal('modal-bulk');
  toast(`Saved ${saved} product${saved === 1 ? '' : 's'}${categoriesCreated ? ` (+${categoriesCreated} new categor${categoriesCreated === 1 ? 'y' : 'ies'})` : ''}`, 'success');
  await refreshCategories();
  await refreshProducts();
  populateCategorySelects();
  renderProductsCategoryView();
  document.dispatchEvent(new CustomEvent('toolbill:categories-changed'));
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

  // Custom category dropdown wiring
  const catInput = $('#pm-category');
  if (catInput) {
    catInput.addEventListener('focus', _renderCategoryDropdown);
    catInput.addEventListener('input', () => { _catDdActive = -1; _renderCategoryDropdown(); });
    catInput.addEventListener('keydown', _handleCategoryKey);
    catInput.addEventListener('blur', () => setTimeout(_closeCategoryDropdown, 150));
  }

  // Inline "+ New category" mini form inside the product modal
  $('#pm-new-cat-btn')?.addEventListener('click', () => {
    $('#pm-new-cat-row').classList.remove('hidden');
    setTimeout(() => $('#pm-new-cat-name').focus(), 30);
  });
  $('#pm-new-cat-cancel')?.addEventListener('click', _resetNewCategoryMiniForm);
  $('#pm-new-cat-add')?.addEventListener('click', _addNewCategoryFromMiniForm);
  $('#pm-new-cat-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); _addNewCategoryFromMiniForm(); }
  });
  $('#pm-new-cat-img')?.addEventListener('change', async (e) => {
    if (!e.target.files[0]) return;
    _newCatImage = await compressImage(e.target.files[0]);
    const prev = $('#pm-new-cat-preview');
    const ph   = $('#pm-new-cat-placeholder');
    if (prev) { prev.src = _newCatImage; prev.style.display = ''; }
    if (ph)   ph.style.display = 'none';
  });
  $('#bulk-save').addEventListener('click', _saveBulk);
  $('#bulk-add-row')?.addEventListener('click', () => _bulkAddRow());
  $('#bulk-paste')?.addEventListener('click', _bulkPasteFromClipboard);
  $('#bulk-clear')?.addEventListener('click', () => {
    if (!confirm('Clear all rows?')) return;
    $('#bulk-body').innerHTML = '';
    for (let i = 0; i < 5; i++) _bulkAddRow();
  });
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
