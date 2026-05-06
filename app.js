// app.js — ToolBill main application
import { db } from './db.js';

// ========== Default categories (seed on first run) ==========
const DEFAULT_CATEGORIES = [
  'Hand Tools', 'Power Tools', 'Fasteners', 'Lubricants',
  'Chemicals', 'Abrasives', 'Electrical', 'Auto Spares', 'General',
];

// Legacy 2-letter code -> name (for old data)
const LEGACY_CAT_CODE = {
  HT: 'Hand Tools',  PT: 'Power Tools', FS: 'Fasteners',
  LB: 'Lubricants',  CH: 'Chemicals',   AB: 'Abrasives',
  EL: 'Electrical',  AS: 'Auto Spares', GN: 'General',
};

const DEFAULT_SETTINGS = {
  shopName: 'My Tools Shop',
  address: '',
  phone: '',
  gstin: '',
  invoicePrefix: 'INV-',
  nextInvoiceNo: 1,
  footer: 'Thank you! Visit again.',
  user1Name: 'accounts',
  user1Pass: '1234',
  user2Name: 'admin',
  user2Pass: 'admin123',
};

// ========== State ==========
const state = {
  products: [],
  categories: [],          // [{id, name}]
  drafts: [],              // [{id, date, items, customerName, amountPaid, notes}]
  activeDraftId: null,     // if set, Save & Print / Save Draft will replace this one
  settings: { ...DEFAULT_SETTINGS },
  cart: [],                // [{productId, shortCode, name, price, qty, unit}]
  searchResults: [],
  searchActive: -1,
  currentUser: null,   // null | 'user1' | 'user2'
  selectedLabels: new Set(),
  showLowOnly: false,
  bulkPreview: null,
  grnTarget: null,
  adjTarget: null,
  currentProductsCategory: null,  // selected category name for product list view
  currentInvCategory: null,       // selected category name for inventory list view
  sellPickerCategory: null,       // null = showing categories; else showing products in this category
  dailySelectedDate: null,
  customerType: 'walkin',   // 'walkin' | 'gst'
  repCustFilter: 'all',     // 'all' | 'gst' | 'walkin'
};

// ========== Utils ==========
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmtMoney = (n) => '₹' + (Number(n) || 0).toFixed(2);
const fmtInt = (n) => (Number(n) || 0).toLocaleString('en-IN');
const todayISO = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();

// Convert a rupee amount to Indian words (e.g. 2500.50 → "Two Thousand Five Hundred Rupees and Fifty Paise Only")
function amountInWords(amount) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
                 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
                 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const two = n => n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
  const three = n => !n ? '' : n < 100 ? two(n) : ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + two(n % 100) : '');

  const rupees = Math.floor(Math.abs(amount));
  const paise  = Math.round((Math.abs(amount) - rupees) * 100);

  if (!rupees && !paise) return 'Zero Rupees Only';

  const crore   = Math.floor(rupees / 10000000);
  const lakh    = Math.floor((rupees % 10000000) / 100000);
  const thousand= Math.floor((rupees % 100000)   / 1000);
  const rem     = rupees % 1000;

  let w = '';
  if (crore)    w += three(crore)    + ' Crore ';
  if (lakh)     w += two(lakh)       + ' Lakh ';
  if (thousand) w += two(thousand)   + ' Thousand ';
  if (rem)      w += three(rem);
  w = w.trim();

  let result = (w ? w + ' Rupees' : '');
  if (paise)  result += (result ? ' and ' : '') + two(paise) + ' Paise';
  return result + ' Only';
}

function escapeHTML(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Normalize a product's category value to a canonical name.
// Old data may have 2-letter codes like "HT"; map to the full name.
function canonicalCategory(raw) {
  if (!raw) return 'General';
  const s = String(raw).trim();
  if (LEGACY_CAT_CODE[s.toUpperCase()]) return LEGACY_CAT_CODE[s.toUpperCase()];
  return s;
}

// Human-readable, single-line QR payload. Example:
//   P-0001|Hydraulic Jack 2 Ton|₹1800
function makeQRPayload(p) {
  const name = (p.name || '').replace(/[|\r\n]/g, ' ').trim();
  return `${p.shortCode}|${name}|₹${p.sellingPrice}`;
}

function parseScannedPayload(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      if (j && j.code) return { code: String(j.code), name: j.name || '', price: Number(j.price) || 0 };
    } catch {}
  }
  if (s.includes('|')) {
    const parts = s.split('|').map(x => x.trim());
    const code = parts[0];
    const name = parts[1] || '';
    const priceStr = (parts[2] || '').replace(/[^0-9.]/g, '');
    const price = priceStr ? parseFloat(priceStr) : 0;
    if (code) return { code, name, price };
  }
  return null;
}

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.className = 'show ' + kind;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', 2400);
}

function openModal(id) {
  $('#' + id).classList.remove('hidden');
  document.body.classList.add('no-scroll');
}
function closeModal(id) {
  $('#' + id).classList.add('hidden');
  document.body.classList.remove('no-scroll');
}
function closeAnyModal() {
  $$('.modal-backdrop').forEach(m => m.classList.add('hidden'));
  document.body.classList.remove('no-scroll');
  closeCameraScanner();   // always stop camera stream when any modal closes
}

function debounce(fn, ms = 120) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Compress an image File to a base64 JPEG at max 480px, quality 0.75
function compressImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 480;
        const ratio = Math.min(MAX / img.width, MAX / img.height, 1);
        const canvas = document.createElement('canvas');
        canvas.width  = Math.round(img.width  * ratio);
        canvas.height = Math.round(img.height * ratio);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

let _productModalImage = null; // tracks current image while product modal is open

// ========== Initialization ==========
async function init() {
  // Load settings
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    const val = await db.getSetting(k, v);
    state.settings[k] = val;
  }
  applySettingsToForm();

  // Load + seed categories
  await refreshCategories();
  if (!state.categories.length) {
    for (const name of DEFAULT_CATEGORIES) {
      await db.add('categories', { name, createdAt: nowISO() });
    }
    await refreshCategories();
  }

  // Load products + migrate legacy category codes
  await refreshProducts();
  await migrateLegacyProductCategories();

  // Load drafts
  await refreshDrafts();

  // Build customer autocomplete list
  await buildCustomerList();

  // Populate category <select> elements
  populateCategorySelects();

  // Wire up UI
  wireTabs();
  wireBilling();
  wireDrafts();
  wireProducts();
  wireInventory();
  wireDaily();
  wireLabels();
  wireReports();
  wireVoidBills();
  wireSettings();
  wireCategoryManager();
  wireHotkeys();
  wireModalClose();
  wireDateInputs();
  wireGlobalScanner();
  wireAdmin();
  applyUserState();
  wireCameraScanner();

  switchTab('billing');
}

async function refreshCategories() {
  state.categories = await db.all('categories');
  state.categories.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

async function refreshProducts() {
  state.products = await db.all('products');
  state.products.sort((a, b) => (a.shortCode || '').localeCompare(b.shortCode || ''));
}

async function refreshDrafts() {
  state.drafts = await db.all('drafts');
  state.drafts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// One-time migration: old products used 2-letter codes like "HT" in
// their `category` field. Convert them to full names.
async function migrateLegacyProductCategories() {
  let changed = 0;
  for (const p of state.products) {
    const canonical = canonicalCategory(p.category);
    if (p.category !== canonical) {
      p.category = canonical;
      p.updatedAt = nowISO();
      await db.put('products', p);
      changed++;
    }
  }
  if (changed) {
    // If any migrated name isn't in categories, auto-add it
    const known = new Set(state.categories.map(c => c.name));
    for (const p of state.products) {
      if (p.category && !known.has(p.category)) {
        await db.add('categories', { name: p.category, createdAt: nowISO() });
        known.add(p.category);
      }
    }
    await refreshCategories();
    await refreshProducts();
  }
}

function populateCategorySelects() {
  const optHTML = state.categories.map(c =>
    `<option value="${escapeHTML(c.name)}">${escapeHTML(c.name)}</option>`
  ).join('');

  const pmCat = $('#pm-category');
  if (pmCat) pmCat.innerHTML = optHTML || `<option value="General">General</option>`;

  const filterHTML = `<option value="">All</option>` + optHTML;
  const lbl = $('#labels-category');
  if (lbl) lbl.innerHTML = filterHTML;
}

// ========== Tabs ==========
function switchTab(name) {
  $$('.tab-btn').forEach(b => b.setAttribute('data-active', b.dataset.tab === name ? 'true' : 'false'));
  $$('.tab-content').forEach(s => s.setAttribute('data-active', s.id === 'tab-' + name ? 'true' : 'false'));
  if (name === 'billing') {
    renderDrafts();
    renderSellPane();
    setTimeout(() => $('#bill-search').focus(), 50);
  }
  if (name === 'products') renderProductsCategoryView();
  if (name === 'inventory') renderInventoryCategoryView();
  if (name === 'daily') renderDaily();
  if (name === 'labels') renderLabels();
  if (name === 'reports') renderReports();
  if (name === 'settings') applySettingsToForm();
}

function wireTabs() {
  $$('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#btn-home').addEventListener('click', () => {
    switchTab('billing');
    $('#bill-search').focus();
  });
}

function wireHotkeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F2') { e.preventDefault(); switchTab('billing'); $('#bill-search').focus(); }
    if (e.key === 'F9') {
      e.preventDefault();
      if (state.cart.length) saveAndPrintBill();
    }
    if (e.key === 'F7') {
      e.preventDefault();
      if (state.cart.length) saveDraftFromCart();
    }
    if (e.key === 'Escape') closeAnyModal();
  });
}

// ========== GLOBAL BARCODE SCANNER LISTENER ==========
// Barcode scanners act as keyboards — they send characters very fast (< 50 ms apart)
// and end with Enter. This listener captures that pattern anywhere on the page so
// the user never has to manually click the search box before scanning.
function wireGlobalScanner() {
  let buffer = '';
  let lastKeyTime = 0;
  const MAX_GAP_MS = 50;   // characters arriving faster than this = scanner, not human
  const MIN_LEN    = 3;    // ignore accidental single-key presses

  document.addEventListener('keypress', (e) => {
    const active = document.activeElement;
    const tag    = active ? active.tagName : '';

    // If user is typing inside ANY input/textarea that is NOT the bill-search, leave it alone
    if ((tag === 'INPUT' || tag === 'TEXTAREA') && active.id !== 'bill-search') {
      buffer = ''; return;
    }

    const now = Date.now();
    const gap = now - lastKeyTime;
    lastKeyTime = now;

    // Long pause = human key press, not a scan — reset buffer
    if (gap > MAX_GAP_MS * 3 && buffer.length === 0 && e.key !== 'Enter') {
      // Just starting to type — let normal search handle it if focused on bill-search
      if (active && active.id === 'bill-search') return;
    }

    if (e.key === 'Enter') {
      if (buffer.length >= MIN_LEN) {
        // Looks like a completed scan — process it
        e.preventDefault();
        switchTab('billing');
        const searchEl = $('#bill-search');
        searchEl.value = buffer;
        handleEnterInBillSearch();
        searchEl.value = '';
        buffer = '';
      }
      return;
    }

    if (e.key.length === 1) {
      // Only accumulate if arriving fast (scanner) OR buffer already building
      if (gap <= MAX_GAP_MS || buffer.length > 0) {
        buffer += e.key;
      }
    }
  });
}

function wireModalClose() {
  $$('.modal-close').forEach(el => el.addEventListener('click', () => closeAnyModal()));
  $$('.modal-backdrop').forEach(m => m.addEventListener('click', (e) => {
    if (e.target === m) closeAnyModal();
  }));
}

// ========== PRODUCTS ==========
function wireProducts() {
  $('#products-cat-search').addEventListener('input', debounce(renderProductsCategoryView, 100));
  $('#btn-manage-categories').addEventListener('click', () => openCategoryManager());
  $('#btn-add-product').addEventListener('click', () => openProductModal(null));
  $('#btn-add-product-2').addEventListener('click', () => openProductModal(null));
  $('#btn-bulk-add').addEventListener('click', () => openBulkModal());
  $('#pm-save').addEventListener('click', saveProductFromModal);
  $('#bulk-parse').addEventListener('click', parseBulk);
  $('#bulk-save').addEventListener('click', saveBulk);

  $('#product-search').addEventListener('input', debounce(renderProductsList, 100));
  $('#btn-products-back').addEventListener('click', () => {
    state.currentProductsCategory = null;
    $('#products-list-view').classList.add('hidden');
    $('#products-cat-view').classList.remove('hidden');
    renderProductsCategoryView();
  });
}

function productCountsByCategory() {
  const counts = {};
  for (const c of state.categories) counts[c.name] = 0;
  for (const p of state.products) {
    const n = canonicalCategory(p.category);
    counts[n] = (counts[n] || 0) + 1;
  }
  return counts;
}

function renderProductsCategoryView() {
  $('#products-list-view').classList.add('hidden');
  $('#products-cat-view').classList.remove('hidden');
  const q = $('#products-cat-search').value.trim().toLowerCase();
  const counts = productCountsByCategory();
  const cats = state.categories
    .map(c => ({ ...c, count: counts[c.name] || 0 }))
    .filter(c => !q || c.name.toLowerCase().includes(q));

  const grid = $('#products-cat-grid');
  if (!cats.length) {
    grid.innerHTML = `<div class="col-span-full text-center py-8 text-gray-400">No categories. Click "+ New Category" to add one.</div>`;
    return;
  }
  grid.innerHTML = cats.map(c => `
    <button class="cat-card text-left" data-cat="${escapeHTML(c.name)}">
      ${c.image ? `<img src="${escapeHTML(c.image)}" class="w-full h-20 object-cover rounded mb-2 -mx-0" style="margin:-0" />` : ''}
      <div class="font-semibold text-gray-800 truncate">${escapeHTML(c.name)}</div>
      <div class="text-xs text-gray-500 mt-1">${fmtInt(c.count)} ${c.count === 1 ? 'item' : 'items'}</div>
    </button>
  `).join('');
  grid.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => {
    state.currentProductsCategory = b.dataset.cat;
    $('#products-list-title').textContent = b.dataset.cat;
    $('#products-cat-view').classList.add('hidden');
    $('#products-list-view').classList.remove('hidden');
    $('#product-search').value = '';
    renderProductsList();
    setTimeout(() => $('#product-search').focus(), 30);
  }));
}

function productsFilteredForList() {
  const q = $('#product-search').value.trim().toLowerCase();
  const cat = state.currentProductsCategory;
  return state.products.filter(p => {
    if (cat && canonicalCategory(p.category) !== cat) return false;
    if (!q) return true;
    return (p.name || '').toLowerCase().includes(q) || (p.shortCode || '').toLowerCase().includes(q);
  });
}

function renderProductsList() {
  const list = productsFilteredForList();
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
      </tr>
    `).join('');
  }
  $('#product-count').textContent = `${list.length} of ${state.products.length} products`;

  body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openProductModal(+b.dataset.edit)));
  body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteProduct(+b.dataset.del)));
  body.querySelectorAll('[data-label]').forEach(b => b.addEventListener('click', () => showSingleLabel(+b.dataset.label)));
}

function openProductModal(id) {
  const editing = id ? state.products.find(p => p.id === id) : null;
  $('#product-modal-title').textContent = editing ? 'Edit product' : 'Add product';
  $('#pm-name').value = editing?.name || '';
  const defaultCat = editing?.category
    ? canonicalCategory(editing.category)
    : (state.currentProductsCategory || state.categories[0]?.name || 'General');
  $('#pm-category').value = defaultCat;
  $('#pm-unit').value = editing?.unit || 'piece';
  $('#pm-price').value = editing?.sellingPrice ?? '';
  $('#pm-stock').value = editing?.stockQty ?? 0;
  $('#pm-reorder').value = editing?.reorderLevel ?? 5;
  $('#pm-hsn').value = editing?.hsn || '';
  $('#pm-shortcode').value = editing?.shortCode || '';
  $('#pm-save').dataset.editingId = editing?.id || '';

  // Image preview
  _productModalImage = editing?.image || null;
  setProductModalImagePreview(_productModalImage);

  // Wire image upload (replace listener each open to avoid duplicates)
  const imgInput = $('#pm-img-input');
  const newInput = imgInput.cloneNode(true);
  imgInput.replaceWith(newInput);
  newInput.addEventListener('change', async () => {
    if (!newInput.files[0]) return;
    _productModalImage = await compressImage(newInput.files[0]);
    setProductModalImagePreview(_productModalImage);
  });
  $('#pm-img-clear').addEventListener('click', () => {
    _productModalImage = null;
    setProductModalImagePreview(null);
  }, { once: true });

  if (!editing) updatePendingShortCode();
  openModal('modal-product');
  setTimeout(() => $('#pm-name').focus(), 50);
}

function setProductModalImagePreview(src) {
  const preview = $('#pm-img-preview');
  const placeholder = $('#pm-img-placeholder');
  const clearBtn = $('#pm-img-clear');
  if (src) {
    preview.src = src;
    preview.style.display = '';
    placeholder.style.display = 'none';
    clearBtn.style.display = '';
  } else {
    preview.style.display = 'none';
    placeholder.style.display = '';
    clearBtn.style.display = 'none';
  }
}

async function updatePendingShortCode() {
  const id = $('#pm-save').dataset.editingId;
  if (id) return;
  const code = await db.nextShortCode();
  $('#pm-shortcode').value = code;
}

async function saveProductFromModal() {
  const name = $('#pm-name').value.trim();
  const category = $('#pm-category').value;
  const unit = $('#pm-unit').value;
  const price = parseFloat($('#pm-price').value);
  const stock = parseInt($('#pm-stock').value || '0', 10);
  const reorder = parseInt($('#pm-reorder').value || '0', 10);
  const hsn = $('#pm-hsn').value.trim();
  const editingId = $('#pm-save').dataset.editingId;

  if (!name) return toast('Name required', 'error');
  if (!category) return toast('Pick a category', 'error');
  if (!(price >= 0)) return toast('Valid price required', 'error');

  try {
    if (editingId) {
      const p = await db.get('products', +editingId);
      p.name = name;
      p.category = category;
      p.unit = unit;
      p.sellingPrice = price;
      p.reorderLevel = reorder;
      p.hsn = hsn;
      p.image = _productModalImage;
      p.updatedAt = nowISO();
      if (stock !== p.stockQty) {
        const diff = stock - p.stockQty;
        await db.add('stockMovements', {
          productId: p.id, type: 'adjust', qty: diff,
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
        image: _productModalImage,
        gstRate: 18,
        createdAt: nowISO(), updatedAt: nowISO(),
      };
      const id = await db.add('products', prod);
      if (stock > 0) {
        await db.add('stockMovements', {
          productId: id, type: 'receipt', qty: stock,
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

async function deleteProduct(id) {
  const p = state.products.find(x => x.id === id);
  if (!p) return;
  if (!confirm(`Delete ${p.shortCode} — ${p.name}?\nThis removes it from the master list. Past bills are kept.`)) return;
  await db.del('products', id);
  await refreshProducts();
  renderProductsList();
  toast('Deleted', 'success');
}

// ----- Bulk add -----
function openBulkModal() {
  $('#bulk-text').value = '';
  $('#bulk-parse-summary').textContent = '';
  $('#bulk-save').disabled = true;
  state.bulkPreview = null;
  openModal('modal-bulk');
}

function parseBulk() {
  const text = $('#bulk-text').value.trim();
  if (!text) { toast('Paste some rows first', 'error'); return; }
  const rows = text.split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  const parsed = [];
  const errors = [];
  const catByLower = Object.fromEntries(state.categories.map(c => [c.name.toLowerCase(), c.name]));
  rows.forEach((r, i) => {
    const parts = r.includes('\t') ? r.split('\t') : r.split(',');
    const [name, cat, price, unit, stock, reorder] = parts.map(s => (s || '').trim());
    if (!name) { errors.push(`Row ${i+1}: missing name`); return; }
    let catName = catByLower[(cat || '').toLowerCase()];
    if (!catName) {
      // legacy 2-letter code?
      const legacy = LEGACY_CAT_CODE[(cat || '').toUpperCase()];
      if (legacy && catByLower[legacy.toLowerCase()]) catName = legacy;
    }
    if (!catName) { errors.push(`Row ${i+1}: unknown category "${cat}"`); return; }
    const priceNum = parseFloat(price);
    if (!(priceNum >= 0)) { errors.push(`Row ${i+1}: invalid price`); return; }
    parsed.push({
      name,
      category: catName,
      sellingPrice: priceNum,
      unit: unit || 'piece',
      stockQty: parseInt(stock || '0', 10) || 0,
      reorderLevel: parseInt(reorder || '5', 10) || 0,
    });
  });
  state.bulkPreview = parsed;
  const summary = `Parsed ${parsed.length} row(s)` + (errors.length ? ` — ${errors.length} error(s): ` + errors.slice(0,3).join(' | ') : '');
  $('#bulk-parse-summary').textContent = summary;
  $('#bulk-save').disabled = parsed.length === 0;
}

async function saveBulk() {
  if (!state.bulkPreview || !state.bulkPreview.length) return;
  let saved = 0;
  for (const row of state.bulkPreview) {
    const shortCode = await db.nextShortCode();
    const prod = {
      ...row,
      shortCode,
      gstRate: 18,
      hsn: '',
      createdAt: nowISO(), updatedAt: nowISO(),
    };
    const id = await db.add('products', prod);
    if (prod.stockQty > 0) {
      await db.add('stockMovements', {
        productId: id, type: 'receipt', qty: prod.stockQty,
        reason: 'Opening stock (bulk)', date: nowISO(),
      });
    }
    saved++;
  }
  closeModal('modal-bulk');
  toast(`Saved ${saved} product(s)`, 'success');
  await refreshProducts();
  renderProductsCategoryView();
}

// ========== CATEGORY MANAGER ==========
function wireCategoryManager() {
  $('#cat-add-btn').addEventListener('click', addCategoryFromInput);
  $('#cat-new-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addCategoryFromInput(); }
  });
}

function openCategoryManager() {
  renderCategoryManager();
  openModal('modal-category');
  setTimeout(() => $('#cat-new-name').focus(), 50);
}

function renderCategoryManager() {
  const counts = productCountsByCategory();
  const box = $('#cat-list');
  if (!state.categories.length) {
    box.innerHTML = `<div class="text-sm text-gray-500">No categories yet.</div>`;
    return;
  }
  box.innerHTML = state.categories.map(c => {
    const n = counts[c.name] || 0;
    const canDelete = n === 0;
    return `
      <div class="flex items-center gap-2 p-2 border rounded">
        <label class="cursor-pointer flex-shrink-0" title="Click to upload image">
          ${c.image
            ? `<img src="${escapeHTML(c.image)}" class="w-10 h-10 object-cover rounded border border-gray-200" />`
            : `<div class="w-10 h-10 rounded border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-400 text-xs text-center leading-tight">Add<br/>img</div>`}
          <input type="file" accept="image/*" class="hidden" data-cat-img="${c.id}" />
        </label>
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
      </div>
    `;
  }).join('');
  box.querySelectorAll('[data-cat-save]').forEach(b => b.addEventListener('click', async () => {
    const id = +b.dataset.catSave;
    const input = box.querySelector(`[data-cat-edit="${id}"]`);
    const newName = (input.value || '').trim();
    if (!newName) return toast('Name required', 'error');
    const cat = state.categories.find(x => x.id === id);
    if (!cat) return;
    if (cat.name === newName) return;
    if (state.categories.some(x => x.id !== id && x.name.toLowerCase() === newName.toLowerCase())) {
      return toast('Category with that name already exists', 'error');
    }
    const oldName = cat.name;
    cat.name = newName;
    await db.put('categories', cat);
    // Update all products pointing to the old name
    for (const p of state.products) {
      if (canonicalCategory(p.category) === oldName) {
        p.category = newName;
        p.updatedAt = nowISO();
        await db.put('products', p);
      }
    }
    await refreshCategories();
    await refreshProducts();
    populateCategorySelects();
    renderCategoryManager();
    if (state.currentProductsCategory === oldName) state.currentProductsCategory = newName;
    toast('Category renamed', 'success');
  }));
  box.querySelectorAll('[data-cat-del]').forEach(b => b.addEventListener('click', async () => {
    if (b.disabled) return;
    const id = +b.dataset.catDel;
    const cat = state.categories.find(x => x.id === id);
    if (!cat) return;
    if (!confirm(`Delete category "${cat.name}"?`)) return;
    await db.del('categories', id);
    await refreshCategories();
    populateCategorySelects();
    renderCategoryManager();
    toast('Deleted', 'success');
  }));
  box.querySelectorAll('[data-cat-img]').forEach(input => {
    input.addEventListener('change', async () => {
      if (!input.files[0]) return;
      const id = +input.dataset.catImg;
      const cat = state.categories.find(x => x.id === id);
      if (!cat) return;
      cat.image = await compressImage(input.files[0]);
      await db.put('categories', cat);
      await refreshCategories();
      renderCategoryManager();
      renderProductsCategoryView();
      renderInventoryCategoryView();
      renderSellPane();
      toast('Image updated', 'success');
    });
  });
}

async function addCategoryFromInput() {
  const input = $('#cat-new-name');
  const name = (input.value || '').trim();
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
  renderInventoryCategoryView();
  toast(`Added "${name}"`, 'success');
}

// ========== BILLING / SELL ==========
function wireBilling() {
  const input = $('#bill-search');
  const dd = $('#search-dropdown');

  input.addEventListener('input', () => runBillSearch(input.value));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleEnterInBillSearch();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSearchActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSearchActive(-1);
    } else if (e.key === 'Escape') {
      dd.classList.add('hidden');
      state.searchResults = [];
    }
  });

  // Customer type toggle
  $('#btn-cust-walkin').addEventListener('click', () => setCustomerType('walkin'));
  $('#btn-cust-gst').addEventListener('click', () => setCustomerType('gst'));

  $('#btn-clear-cart').addEventListener('click', () => {
    if (!state.cart.length) return;
    if (confirm('Clear cart?')) {
      state.cart = [];
      detachActiveDraft();
      renderCart();
    }
  });
  $('#btn-save-print').addEventListener('click', saveAndPrintBill);
  $('#btn-save-draft').addEventListener('click', saveDraftFromCart);
  wireCustomerAutocomplete();
  $('#btn-active-draft-detach').addEventListener('click', () => {
    detachActiveDraft();
    toast('Detached — changes will become a new draft or bill', '');
  });

  // Sell-tab picker pane (categories <-> products)
  $('#sell-pane-search').addEventListener('input', debounce(renderSellPane, 80));
  $('#btn-sell-back').addEventListener('click', () => {
    state.sellPickerCategory = null;
    $('#sell-pane-search').value = '';
    renderSellPane();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-dropdown') && e.target !== input) {
      dd.classList.add('hidden');
    }
  });
}

function setCustomerType(type) {
  state.customerType = type;
  const isGst = type === 'gst';
  $('#btn-cust-walkin').className = `flex-1 py-2 font-semibold transition-colors ${!isGst ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`;
  $('#btn-cust-gst').className   = `flex-1 py-2 font-semibold transition-colors ${isGst  ? 'bg-green-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`;
  $('#gst-customer-row').classList.toggle('hidden', !isGst);
  if (isGst) setTimeout(() => $('#customer-gst').focus(), 50);
}

// ========== CUSTOMER AUTOCOMPLETE ==========
let _customerList = []; // deduplicated past customers [{name, phone, gst, type}]

async function buildCustomerList() {
  // Customers store is the primary source; invoices fill in historical data
  const [customers, invoices] = await Promise.all([db.all('customers'), db.all('invoices')]);
  const seen = new Map();

  // Dedicated customer records take priority
  for (const c of customers) {
    const key = (c.phone || c.gst || c.name || '').toLowerCase();
    if (key) seen.set(key, { name: c.name || '', phone: c.phone || '', gst: c.gst || '', type: c.type || 'walkin' });
  }

  // Back-fill from invoices (history before the customers store existed)
  for (const inv of [...invoices].sort((a, b) => (b.date || '').localeCompare(a.date || ''))) {
    const name  = (inv.customerName  || '').trim();
    const phone = (inv.customerPhone || '').trim();
    const gst   = (inv.customerGst   || '').trim().toUpperCase();
    if (!name && !phone && !gst) continue;
    const key = (phone || gst || name).toLowerCase();
    if (!seen.has(key)) seen.set(key, { name, phone, gst, type: inv.customerType || (gst ? 'gst' : 'walkin') });
  }

  _customerList = Array.from(seen.values());
}

async function upsertCustomer(name, phone, gst, type) {
  if (!name && !phone && !gst) return;
  const customers = await db.all('customers');
  // Match by phone first, then GST, then name
  const existing = customers.find(c =>
    (phone && c.phone === phone) ||
    (gst   && c.gst   === gst)   ||
    (!phone && !gst && c.name === name)
  );
  const now = nowISO();
  if (existing) {
    if (name)  existing.name  = name;
    if (phone) existing.phone = phone;
    if (gst)   existing.gst   = gst;
    existing.type = type || existing.type;
    existing.updatedAt = now;
    await db.put('customers', existing);
  } else {
    await db.add('customers', { name, phone, gst, type: type || 'walkin', createdAt: now, updatedAt: now });
  }
}

function wireCustomerAutocomplete() {
  // Create a single shared dropdown positioned with fixed coords
  const dd = document.createElement('div');
  dd.id = 'customer-dropdown';
  dd.className = 'fixed z-50 bg-white border border-gray-200 rounded-lg shadow-xl overflow-y-auto hidden';
  dd.style.maxHeight = '220px';
  document.body.appendChild(dd);

  const fieldIds = ['customer-name', 'customer-phone', 'customer-gst'];

  fieldIds.forEach(fieldId => {
    const el = $('#' + fieldId);
    if (!el) return;
    el.addEventListener('input', () => showCustomerSuggestions(el, dd, fieldId));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') dd.classList.add('hidden');
      if (e.key === 'ArrowDown') { e.preventDefault(); dd.querySelector('.cust-s')?.focus(); }
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#customer-dropdown') && !fieldIds.includes(e.target.id)) {
      dd.classList.add('hidden');
    }
  });
}

function showCustomerSuggestions(inputEl, dd, fieldId) {
  const q = inputEl.value.trim().toLowerCase();
  if (!q || q.length < 1) { dd.classList.add('hidden'); return; }

  const matches = _customerList.filter(c => {
    if (fieldId === 'customer-name')  return (c.name  || '').toLowerCase().includes(q);
    if (fieldId === 'customer-phone') return (c.phone || '').toLowerCase().includes(q);
    if (fieldId === 'customer-gst')   return (c.gst   || '').toLowerCase().includes(q);
    return false;
  }).slice(0, 8);

  if (!matches.length) { dd.classList.add('hidden'); return; }

  // Position below the input
  const rect = inputEl.getBoundingClientRect();
  dd.style.top   = (rect.bottom + window.scrollY + 4) + 'px';
  dd.style.left  = rect.left + 'px';
  dd.style.width = Math.max(rect.width, 240) + 'px';

  dd.innerHTML = matches.map((c, i) => `
    <div class="cust-s flex items-center gap-2 px-3 py-2 hover:bg-blue-50 cursor-pointer outline-none" tabindex="0" data-i="${i}">
      <div class="min-w-0 flex-1">
        <div class="font-medium text-sm text-gray-800 truncate">${escapeHTML(c.name || '—')}</div>
        <div class="text-xs text-gray-400 truncate">${c.phone ? escapeHTML(c.phone) : ''}${c.gst ? (c.phone ? ' · ' : '') + escapeHTML(c.gst) : ''}</div>
      </div>
      ${c.gst ? `<span class="text-xs bg-green-100 text-green-700 px-1 rounded flex-shrink-0">GST</span>` : ''}
    </div>
  `).join('');

  dd.classList.remove('hidden');
  dd.querySelectorAll('.cust-s').forEach((el, i) => {
    const pick = () => { fillCustomer(matches[i]); dd.classList.add('hidden'); };
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') pick();
      if (e.key === 'Escape') dd.classList.add('hidden');
      if (e.key === 'ArrowDown') { e.preventDefault(); el.nextElementSibling?.focus(); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); el.previousElementSibling?.focus() || inputEl.focus(); }
    });
  });
}

function fillCustomer(c) {
  $('#customer-name').value  = c.name  || '';
  $('#customer-phone').value = c.phone || '';
  if (c.gst) {
    setCustomerType('gst');
    $('#customer-gst').value = c.gst;
  } else {
    setCustomerType(c.type || 'walkin');
    $('#customer-gst').value = '';
  }
}

// Render the right-hand picker: either category tiles or product tiles
function renderSellPane() {
  const title = $('#sell-pane-title');
  const body = $('#sell-pane-body');
  const back = $('#btn-sell-back');
  const q = $('#sell-pane-search').value.trim().toLowerCase();

  if (!state.sellPickerCategory) {
    // Category grid
    title.textContent = 'Categories';
    back.classList.add('hidden');
    $('#sell-pane-search').placeholder = 'Filter categories...';
    const counts = productCountsByCategory();
    const cats = state.categories
      .map(c => ({ ...c, count: counts[c.name] || 0 }))
      .filter(c => !q || c.name.toLowerCase().includes(q));
    if (!cats.length) {
      body.innerHTML = `<div class="text-center py-10 text-gray-400 text-sm">No categories match</div>`;
      return;
    }
    body.innerHTML = `<div class="sell-tiles">` + cats.map(c => `
      <button class="sell-cat-tile" data-sell-cat="${escapeHTML(c.name)}">
        ${c.image ? `<img src="${escapeHTML(c.image)}" class="w-full h-16 object-cover rounded mb-1" />` : ''}
        <div class="sell-cat-tile-name">${escapeHTML(c.name)}</div>
        <div class="sell-cat-tile-meta">${fmtInt(c.count)} ${c.count === 1 ? 'item' : 'items'}</div>
      </button>
    `).join('') + `</div>`;
    body.querySelectorAll('[data-sell-cat]').forEach(b => b.addEventListener('click', () => {
      state.sellPickerCategory = b.dataset.sellCat;
      $('#sell-pane-search').value = '';
      renderSellPane();
    }));
  } else {
    // Product grid for the chosen category
    title.textContent = state.sellPickerCategory;
    back.classList.remove('hidden');
    $('#sell-pane-search').placeholder = 'Filter products in this category...';
    const cartQty = new Map(state.cart.filter(l => l.productId).map(l => [l.productId, l.qty]));
    let items = state.products.filter(p => canonicalCategory(p.category) === state.sellPickerCategory);
    if (q) items = items.filter(p => (p.name || '').toLowerCase().includes(q) || (p.shortCode || '').toLowerCase().includes(q));
    items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!items.length) {
      body.innerHTML = `<div class="text-center py-10 text-gray-400 text-sm">No products match</div>`;
      return;
    }
    body.innerHTML = `<div class="sell-tiles">` + items.map(p => {
      const inCart = cartQty.get(p.id) || 0;
      const low = (p.stockQty || 0) <= (p.reorderLevel || 0);
      const outOfStock = (p.stockQty || 0) <= 0;
      return `
        <button class="sell-prod-tile ${outOfStock ? 'oos' : ''}" data-sell-prod="${p.id}">
          ${inCart > 0 ? `<span class="sell-prod-badge">${inCart}</span>` : ''}
          ${p.image ? `<img src="${escapeHTML(p.image)}" class="w-full h-16 object-cover rounded mb-1" />` : ''}
          <div class="sell-prod-name">${escapeHTML(p.name)}</div>
          <div class="sell-prod-code mono">${escapeHTML(p.shortCode)}</div>
          <div class="sell-prod-footer">
            <span class="sell-prod-price">${fmtMoney(p.sellingPrice)}</span>
            <span class="sell-prod-stock ${low ? 'low' : ''}">${outOfStock ? 'Out of stock' : p.stockQty + ' left'}</span>
          </div>
        </button>
      `;
    }).join('') + `</div>`;
    body.querySelectorAll('[data-sell-prod]').forEach(b => b.addEventListener('click', () => {
      const p = state.products.find(x => x.id === +b.dataset.sellProd);
      if (!p) return;
      addToCart(p, 1);
      renderSellPane();  // refresh badges
    }));
  }
}

function runBillSearch(raw) {
  const dd = $('#search-dropdown');
  const q = (raw || '').trim();
  if (!q) { dd.classList.add('hidden'); state.searchResults = []; return; }
  if (q.startsWith('{')) { dd.classList.add('hidden'); return; }
  if (/^\d+\*/.test(q)) { dd.classList.add('hidden'); return; }
  if (/^[A-Z]+-\d+$/i.test(q)) { dd.classList.add('hidden'); return; }

  const ql = q.toLowerCase();
  const matches = state.products
    .filter(p => (p.name || '').toLowerCase().includes(ql) || (p.shortCode || '').toLowerCase().includes(ql))
    .slice(0, 10);
  state.searchResults = matches;
  state.searchActive = matches.length ? 0 : -1;
  renderSearchDropdown();
}

function renderSearchDropdown() {
  const dd = $('#search-dropdown');
  if (!state.searchResults.length) { dd.classList.add('hidden'); return; }
  dd.innerHTML = state.searchResults.map((p, i) => `
    <div class="item ${i === state.searchActive ? 'active' : ''}" data-idx="${i}">
      <div>
        <div class="font-medium">${escapeHTML(p.name)}</div>
        <div class="text-xs text-gray-500 mono">${escapeHTML(p.shortCode)} · ${escapeHTML(canonicalCategory(p.category))}</div>
      </div>
      <div class="text-right">
        <div class="font-semibold">${fmtMoney(p.sellingPrice)}</div>
        <div class="text-xs ${p.stockQty <= 0 ? 'text-red-600' : 'text-gray-500'}">${fmtInt(p.stockQty)} in stock</div>
      </div>
    </div>
  `).join('');
  dd.classList.remove('hidden');
  dd.querySelectorAll('[data-idx]').forEach(el => {
    el.addEventListener('click', () => {
      const p = state.searchResults[+el.dataset.idx];
      addToCart(p, 1);
      $('#bill-search').value = '';
      dd.classList.add('hidden');
      state.searchResults = [];
      $('#bill-search').focus();
    });
  });
}

function moveSearchActive(delta) {
  if (!state.searchResults.length) return;
  state.searchActive = (state.searchActive + delta + state.searchResults.length) % state.searchResults.length;
  renderSearchDropdown();
}

function handleEnterInBillSearch() {
  const input = $('#bill-search');
  const raw = input.value.trim();
  if (!raw) return;

  const parsed = parseScannedPayload(raw);
  if (parsed) {
    const p = state.products.find(x => x.shortCode.toUpperCase() === parsed.code.toUpperCase());
    if (p) {
      addToCart(p, 1);
      toast(`Added: ${p.name} — ${fmtMoney(p.sellingPrice)}`, 'success');
    } else {
      addEphemeralFromQR({ code: parsed.code, name: parsed.name, price: parsed.price });
      toast(`Added from QR (not in DB): ${parsed.name} — ${fmtMoney(parsed.price)}`, '');
    }
    input.value = '';
    return;
  }

  const m = raw.match(/^(\d+)\s*\*\s*(.+)$/);
  if (m) {
    const qty = parseInt(m[1], 10);
    const rest = m[2].trim();
    const pp = parseScannedPayload(rest);
    const code = pp ? pp.code : rest;
    const p = state.products.find(x => x.shortCode.toUpperCase() === code.toUpperCase());
    if (p) {
      addToCart(p, qty);
      toast(`Added ${qty} × ${p.name} — ${fmtMoney(p.sellingPrice * qty)}`, 'success');
      input.value = ''; return;
    }
    toast('Code not found: ' + code, 'error');
    return;
  }

  if (/^[A-Z]+-\d+$/i.test(raw)) {
    const p = state.products.find(x => x.shortCode.toUpperCase() === raw.toUpperCase());
    if (p) {
      addToCart(p, 1);
      toast(`Added: ${p.name} — ${fmtMoney(p.sellingPrice)}`, 'success');
      input.value = ''; return;
    }
    toast('Code not found: ' + raw, 'error');
    return;
  }

  if (state.searchActive >= 0 && state.searchResults[state.searchActive]) {
    const p = state.searchResults[state.searchActive];
    addToCart(p, 1);
    toast(`Added: ${p.name} — ${fmtMoney(p.sellingPrice)}`, 'success');
    input.value = '';
    state.searchResults = [];
    $('#search-dropdown').classList.add('hidden');
    return;
  }

  toast('No match', 'error');
}

function addEphemeralFromQR(j) {
  state.cart.push({
    productId: null,
    shortCode: j.code,
    name: j.name || '(Unknown)',
    price: Number(j.price) || 0,
    qty: 1,
    unit: 'piece',
    ephemeral: true,
  });
  renderCart();
}

function addToCart(p, qty) {
  if (qty <= 0) return;
  const existing = state.cart.find(l => l.productId === p.id);
  if (existing) existing.qty += qty;
  else state.cart.push({
    productId: p.id,
    shortCode: p.shortCode,
    name: p.name,
    price: p.sellingPrice,
    qty,
    unit: p.unit || 'piece',
  });
  renderCart();
  // If the picker is open, refresh the product-tile badges
  if (state.sellPickerCategory) renderSellPane();
}

function renderCart() {
  const body = $('#cart-body');
  if (!state.cart.length) {
    body.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-gray-400">Cart is empty — scan or search to add items</td></tr>`;
    $('#cart-count').textContent = '0';
    $('#cart-qty').textContent = '0';
    $('#cart-total').textContent = fmtMoney(0);
    return;
  }
  body.innerHTML = state.cart.map((l, i) => `
    <tr data-row="${i}">
      <td style="width:auto">${escapeHTML(l.name)}${l.ephemeral ? ' <span class="text-xs text-yellow-700">(from QR)</span>' : ''}</td>
      <td style="width:72px;padding-left:4px;padding-right:4px"><input type="number" min="1" step="1" value="${l.qty}" data-qty="${i}" class="cart-input" /></td>
      <td style="width:150px;padding-left:4px;padding-right:4px"><input type="number" min="0" step="0.01" value="${l.price}" data-price="${i}" class="cart-input text-right" title="Edit price for this bill only" /></td>
      <td style="width:110px" class="text-right font-semibold" data-line-total="${i}">${fmtMoney(l.price * l.qty)}</td>
      <td style="width:32px" class="text-center"><button class="cart-rm-btn" data-rm="${i}" title="Remove"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button></td>
    </tr>
  `).join('');

  const updateLine = (i) => {
    const cell = body.querySelector(`[data-line-total="${i}"]`);
    if (cell) cell.textContent = fmtMoney(state.cart[i].qty * state.cart[i].price);
    updateCartTotals();
  };

  body.querySelectorAll('[data-qty]').forEach(el => {
    el.addEventListener('input', () => {
      const i = +el.dataset.qty;
      const raw = el.value.trim();
      const n = raw === '' ? state.cart[i].qty : Math.max(1, parseInt(raw, 10) || 1);
      state.cart[i].qty = n;
      updateLine(i);
    });
    el.addEventListener('blur', () => {
      const i = +el.dataset.qty;
      const raw = el.value.trim();
      if (raw === '' || !(parseInt(raw, 10) >= 1)) el.value = state.cart[i].qty;
    });
    el.addEventListener('focus', () => el.select());
  });

  body.querySelectorAll('[data-price]').forEach(el => {
    el.addEventListener('input', () => {
      const i = +el.dataset.price;
      const raw = el.value.trim();
      const n = raw === '' ? state.cart[i].price : Math.max(0, parseFloat(raw) || 0);
      state.cart[i].price = n;
      updateLine(i);
    });
    el.addEventListener('blur', () => {
      const i = +el.dataset.price;
      const raw = el.value.trim();
      if (raw === '' || !(parseFloat(raw) >= 0)) el.value = state.cart[i].price;
    });
    el.addEventListener('focus', () => el.select());
  });

  body.querySelectorAll('[data-rm]').forEach(el => el.addEventListener('click', () => {
    state.cart.splice(+el.dataset.rm, 1);
    renderCart();
    if (state.sellPickerCategory) renderSellPane();
  }));

  updateCartTotals();
}

function updateCartTotals() {
  const totalQty = state.cart.reduce((s, l) => s + l.qty, 0);
  const total = state.cart.reduce((s, l) => s + l.qty * l.price, 0);
  $('#cart-count').textContent = state.cart.length;
  $('#cart-qty').textContent = totalQty;
  $('#cart-total').textContent = fmtMoney(total);
  const badge = $('#cart-count-badge');
  if (badge) badge.textContent = `${state.cart.length} ${state.cart.length === 1 ? 'item' : 'items'}`;
}

// ----- Drafts -----
function wireDrafts() {
  $('#btn-open-drafts').addEventListener('click', async () => {
    await refreshDrafts();
    renderDrafts();
    openModal('modal-drafts');
  });
}

function detachActiveDraft() {
  state.activeDraftId = null;
  $('#active-draft-banner').classList.add('hidden');
  $('#active-draft-chip').classList.add('hidden');
  $('#active-draft-label').textContent = '';
  $('#active-draft-banner-label').textContent = '';
}
function setActiveDraft(id, label) {
  state.activeDraftId = id;
  const txt = label || `#${id}`;
  $('#active-draft-banner').classList.remove('hidden');
  $('#active-draft-chip').classList.remove('hidden');
  $('#active-draft-label').textContent = txt;
  $('#active-draft-banner-label').textContent = txt;
}

async function saveDraftFromCart() {
  if (!state.cart.length) return toast('Cart is empty', 'error');
  const customerName = $('#customer-name').value.trim();
  const customerPhone = $('#customer-phone').value.trim();
  const customerGst = $('#customer-gst').value.trim().toUpperCase();
  const amountPaidRaw = $('#amount-paid').value.trim();
  const amountPaid = amountPaidRaw === '' ? null : parseFloat(amountPaidRaw);
  const notes = $('#bill-notes').value.trim();
  const payload = {
    date: nowISO(),
    items: state.cart.map(l => ({ ...l })),
    customerType: state.customerType,
    customerName: customerName || null,
    customerPhone: customerPhone || null,
    customerGst: customerGst || null,
    amountPaid,
    notes: notes || '',
  };
  try {
    if (state.activeDraftId) {
      const existing = await db.get('drafts', state.activeDraftId);
      if (existing) {
        payload.id = state.activeDraftId;
        payload.createdAt = existing.createdAt || existing.date;
        await db.put('drafts', payload);
        toast(`Draft #${state.activeDraftId} updated`, 'success');
      } else {
        const id = await db.add('drafts', { ...payload, createdAt: nowISO() });
        setActiveDraft(id, `#${id}`);
        toast(`Draft #${id} saved`, 'success');
      }
    } else {
      const id = await db.add('drafts', { ...payload, createdAt: nowISO() });
      setActiveDraft(id, `#${id}`);
      toast(`Draft #${id} saved`, 'success');
    }
    await refreshDrafts();
    renderDrafts();
  } catch (e) {
    console.error(e);
    toast('Save failed: ' + e.message, 'error');
  }
}

function renderDrafts() {
  const box = $('#drafts-list');
  $('#drafts-count').textContent = String(state.drafts.length);
  if (!state.drafts.length) {
    if (box) box.innerHTML = `<div class="text-sm text-gray-400">No saved drafts</div>`;
    return;
  }
  box.innerHTML = state.drafts.map(d => {
    const when = new Date(d.date || d.createdAt || Date.now());
    const itemCount = (d.items || []).length;
    const qty = (d.items || []).reduce((s, l) => s + (l.qty || 0), 0);
    const total = (d.items || []).reduce((s, l) => s + (l.qty * l.price || 0), 0);
    const isActive = state.activeDraftId === d.id;
    return `
      <div class="flex flex-wrap items-center gap-2 p-2 border rounded ${isActive ? 'border-amber-400 bg-amber-50' : ''}">
        <div class="flex-1 min-w-[180px]">
          <div class="font-medium">${escapeHTML(d.customerName || 'Walk-in')} <span class="text-xs text-gray-500 mono">#${d.id}</span></div>
          <div class="text-xs text-gray-500">${when.toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })} · ${itemCount} items · qty ${qty}</div>
        </div>
        <div class="font-semibold">${fmtMoney(total)}</div>
        <button class="text-blue-600 hover:underline text-sm" data-draft-load="${d.id}">Load</button>
        <button class="text-red-600 hover:underline text-sm" data-draft-del="${d.id}">Delete</button>
      </div>
    `;
  }).join('');
  box.querySelectorAll('[data-draft-load]').forEach(b => b.addEventListener('click', () => loadDraft(+b.dataset.draftLoad)));
  box.querySelectorAll('[data-draft-del]').forEach(b => b.addEventListener('click', () => deleteDraft(+b.dataset.draftDel)));
}

async function loadDraft(id) {
  const d = state.drafts.find(x => x.id === id);
  if (!d) return;
  if (state.cart.length && !confirm('Cart has items. Replace with this draft?')) return;
  state.cart = (d.items || []).map(l => ({ ...l }));
  setCustomerType(d.customerType || (d.customerGst ? 'gst' : 'walkin'));
  $('#customer-name').value = d.customerName || '';
  $('#customer-phone').value = d.customerPhone || '';
  $('#customer-gst').value = d.customerGst || '';
  $('#amount-paid').value = d.amountPaid != null ? String(d.amountPaid) : '';
  $('#bill-notes').value = d.notes || '';
  setActiveDraft(d.id, `#${d.id}`);
  renderCart();
  renderSellPane();
  closeModal('modal-drafts');
  toast(`Loaded draft #${id}`, '');
}

async function deleteDraft(id) {
  if (!confirm(`Delete draft #${id}?`)) return;
  await db.del('drafts', id);
  if (state.activeDraftId === id) detachActiveDraft();
  await refreshDrafts();
  renderDrafts();
}

// ----- Save & Print -----
let _saving = false;
async function saveAndPrintBill() {
  if (_saving) return;           // prevent double-click duplicates
  if (!state.cart.length) return toast('Cart is empty', 'error');
  _saving = true;

  const s = state.settings;
  const invoiceNo = `${s.invoicePrefix}${String(s.nextInvoiceNo).padStart(4, '0')}`;
  const total = state.cart.reduce((sum, l) => sum + l.qty * l.price, 0);
  const customerName = $('#customer-name').value.trim();
  const customerPhone = $('#customer-phone').value.trim();
  const customerGst = $('#customer-gst').value.trim().toUpperCase();
  const amountPaidRaw = $('#amount-paid').value.trim();
  const amountPaid = amountPaidRaw === '' ? null : parseFloat(amountPaidRaw);
  const notes = $('#bill-notes').value.trim();

  const invoice = {
    invoiceNo,
    date: nowISO(),
    customerType: state.customerType,
    customerName: customerName || null,
    customerPhone: customerPhone || null,
    customerGst: customerGst || null,
    items: state.cart.map(l => ({ ...l })),
    subtotal: total,
    total,
    amountPaid,
    notes: notes || '',
    printedAt: nowISO(),
  };

  try {
    const id = await db.add('invoices', invoice);
    invoice.id = id;

    for (const line of state.cart) {
      if (!line.productId) continue;
      const p = await db.get('products', line.productId);
      if (!p) continue;
      p.stockQty = (p.stockQty || 0) - line.qty;
      p.updatedAt = nowISO();
      await db.put('products', p);
      await db.add('stockMovements', {
        productId: p.id, type: 'sale', qty: -line.qty,
        reason: 'Bill ' + invoiceNo, refId: id, date: nowISO(),
      });
    }

    state.settings.nextInvoiceNo = (s.nextInvoiceNo || 1) + 1;
    await db.setSetting('nextInvoiceNo', state.settings.nextInvoiceNo);

    // If this bill was made from a draft, delete the draft
    if (state.activeDraftId) {
      try { await db.del('drafts', state.activeDraftId); } catch {}
    }

    await refreshProducts();
    await refreshDrafts();

    renderBillToPrintArea(invoice);
    window.print();

    state.cart = [];
    detachActiveDraft();
    setCustomerType('walkin');
    $('#customer-name').value = '';
    $('#customer-phone').value = '';
    $('#customer-gst').value = '';
    $('#amount-paid').value = '';
    $('#bill-notes').value = '';
    renderCart();
    renderDrafts();
    renderSellPane();
    if (customerName || customerPhone || customerGst) {
      await upsertCustomer(customerName, customerPhone, customerGst, state.customerType);
    }
    buildCustomerList();
    toast('Bill ' + invoiceNo + ' saved', 'success');
    $('#bill-search').focus();
  } catch (e) {
    console.error(e);
    toast('Save failed: ' + e.message, 'error');
  } finally {
    _saving = false;
  }
}

function renderBillToPrintArea(invoice) {
  const s = state.settings;
  const d = new Date(invoice.date);
  const dateStr = d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  const itemsHTML = invoice.items.map(l => `
    <tr>
      <td>${escapeHTML(l.name)}</td>
      <td style="text-align:right">${l.qty}</td>
      <td style="text-align:right">${fmtMoney(l.price)}</td>
      <td style="text-align:right">${fmtMoney(l.price * l.qty)}</td>
    </tr>
  `).join('');

  const area = $('#print-area');
  area.innerHTML = `
    <div class="print-receipt">
      <h1>${escapeHTML(s.shopName || 'Shop')}</h1>
      ${s.address ? `<div class="meta">${escapeHTML(s.address)}</div>` : ''}
      ${s.phone ? `<div class="meta">Ph: ${escapeHTML(s.phone)}</div>` : ''}
      ${s.gstin ? `<div class="meta">GSTIN: ${escapeHTML(s.gstin)}</div>` : ''}
      <div class="meta" style="border-top:1px dashed #000;border-bottom:1px dashed #000;padding:2px 0;margin:4px 0">
        Bill: <b>${escapeHTML(invoice.invoiceNo)}</b><br/>
        ${dateStr}${invoice.customerName ? '<br/>Cust: ' + escapeHTML(invoice.customerName) : ''}${invoice.customerPhone ? '<br/>Ph: ' + escapeHTML(invoice.customerPhone) : ''}${invoice.customerGst ? '<br/>GSTIN: ' + escapeHTML(invoice.customerGst) : ''}
      </div>
      <table>
        <thead>
          <tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amt</th></tr>
        </thead>
        <tbody>${itemsHTML}</tbody>
      </table>
      <div class="totals">
        <div class="row"><span>Items</span><span>${invoice.items.length}</span></div>
        <div class="row"><span>Total qty</span><span>${invoice.items.reduce((x,l)=>x+l.qty,0)}</span></div>
        <div class="row" style="font-size:13px;font-weight:bold;margin-top:4px"><span>TOTAL</span><span>${fmtMoney(invoice.total)}</span></div>
        <div style="font-size:9px;font-style:italic;margin-top:3px;border-top:1px dashed #000;padding-top:3px">${amountInWords(invoice.total)}</div>
      </div>
      ${invoice.notes ? `<div class="footer">Note: ${escapeHTML(invoice.notes)}</div>` : ''}
      ${s.footer ? `<div class="footer">${escapeHTML(s.footer)}</div>` : ''}
    </div>
  `;
}

// ========== LABELS ==========
function wireLabels() {
  $('#labels-search').addEventListener('input', debounce(renderLabels, 100));
  $('#labels-category').addEventListener('change', renderLabels);
  $('#btn-labels-select-all').addEventListener('click', () => {
    labelsList().forEach(p => state.selectedLabels.add(p.id));
    renderLabels();
  });
  $('#btn-labels-select-none').addEventListener('click', () => {
    state.selectedLabels.clear();
    renderLabels();
  });
  $('#btn-labels-print').addEventListener('click', () => printSelectedLabels());
  $('#btn-labels-pdf').addEventListener('click', () => downloadLabelsPDF());
  $('#label-print').addEventListener('click', async () => {
    const id = +$('#label-preview').dataset.productId;
    if (!id) return;
    await renderLabelsToPrintArea([id]);
    window.print();
  });
  $('#label-pdf').addEventListener('click', async () => {
    const id = +$('#label-preview').dataset.productId;
    if (id) await downloadLabelsPDF([id]);
  });
}

// Printable HTML with barcodes + QR + MRP baked in as PNG data URLs.
async function renderLabelsToPrintArea(ids) {
  const items = ids.map(id => state.products.find(p => p.id === id)).filter(Boolean);
  const blocks = await Promise.all(items.map(async (p) => {
    let bcImg = '';
    try {
      const c = document.createElement('canvas');
      JsBarcode(c, p.shortCode, { format: 'CODE128', displayValue: false, margin: 0, height: 50, width: 2 });
      bcImg = c.toDataURL('image/png');
    } catch {}
    let qrImg = '';
    try {
      qrImg = await QRCode.toDataURL(makeQRPayload(p), { width: 220, margin: 1 });
    } catch {}
    return `
      <div class="label-card">
        <div class="name">${escapeHTML(p.name)}</div>
        <div class="codes">
          ${bcImg ? `<img src="${bcImg}" alt="barcode" style="height:44px;width:auto;"/>` : ''}
          ${qrImg ? `<img src="${qrImg}" alt="qr" style="height:72px;width:72px;"/>` : ''}
        </div>
        <div class="shortcode">${escapeHTML(p.shortCode)}</div>
        <div class="mrp">MRP ${fmtMoney(p.sellingPrice)}</div>
      </div>
    `;
  }));
  $('#print-area').innerHTML = `<div class="print-labels">${blocks.join('')}</div>`;
}

function labelsList() {
  const q = $('#labels-search').value.trim().toLowerCase();
  const cat = $('#labels-category').value;
  return state.products.filter(p => {
    if (cat && canonicalCategory(p.category) !== cat) return false;
    if (!q) return true;
    return (p.name || '').toLowerCase().includes(q) || (p.shortCode || '').toLowerCase().includes(q);
  });
}

function renderLabels() {
  const list = labelsList();
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
      </div>
    `;
  }).join('');

  list.forEach(p => {
    const bc = grid.querySelector(`[data-barcode="${p.id}"]`);
    const qc = grid.querySelector(`[data-qr="${p.id}"]`);
    try { if (bc && window.JsBarcode) JsBarcode(bc, p.shortCode, { format: 'CODE128', displayValue: false, margin: 0, height: 35, width: 1.4 }); } catch(e){}
    try {
      if (qc && window.QRCode) {
        const payload = makeQRPayload(p);
        QRCode.toCanvas(qc, payload, { width: 70, margin: 1 });
      }
    } catch(e){}
  });

  grid.querySelectorAll('[data-check]').forEach(cb => cb.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = +cb.dataset.check;
    if (cb.checked) state.selectedLabels.add(id); else state.selectedLabels.delete(id);
    updateLabelsSelectedCount();
  }));
  grid.querySelectorAll('[data-toggle]').forEach(card => card.addEventListener('click', (e) => {
    if (e.target.matches('input,label')) return;
    const id = +card.dataset.toggle;
    if (state.selectedLabels.has(id)) state.selectedLabels.delete(id); else state.selectedLabels.add(id);
    renderLabels();
  }));
  updateLabelsSelectedCount();
}

function updateLabelsSelectedCount() {
  $('#labels-selected-count').textContent = `${state.selectedLabels.size} selected`;
}

async function showSingleLabel(productId) {
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
    </div>
  `;
  openModal('modal-label');
  setTimeout(() => {
    try { JsBarcode('#lbl-bc', p.shortCode, { format: 'CODE128', displayValue: false, margin: 0, height: 45, width: 1.8 }); } catch {}
    try { QRCode.toCanvas($('#lbl-qr'), makeQRPayload(p), { width: 90, margin: 1 }); } catch {}
  }, 50);
}

async function printSelectedLabels() {
  const ids = Array.from(state.selectedLabels);
  if (!ids.length) return toast('Select labels first', 'error');
  await renderLabelsToPrintArea(ids);
  setTimeout(() => window.print(), 80);
}

async function downloadLabelsPDF(ids) {
  ids = ids || Array.from(state.selectedLabels);
  if (!ids.length) return toast('Select labels first', 'error');
  const items = ids.map(id => state.products.find(p => p.id === id)).filter(Boolean);
  if (!items.length) return;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const marginX = 7, marginY = 10;
  const cols = 3, rows = 10;
  const cellW = (210 - marginX * 2) / cols;
  const cellH = (297 - marginY * 2) / rows;

  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    const slot = i % (cols * rows);
    if (i > 0 && slot === 0) doc.addPage();
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    const x = marginX + col * cellW;
    const y = marginY + row * cellH;

    const name = p.name || '';
    doc.setFontSize(8);
    const lines = doc.splitTextToSize(name, cellW - 4);
    doc.text(lines.slice(0, 2).join('\n'), x + cellW / 2, y + 4, { align: 'center' });

    try {
      const bcCanvas = document.createElement('canvas');
      JsBarcode(bcCanvas, p.shortCode, { format: 'CODE128', displayValue: false, margin: 0, height: 40, width: 1.5 });
      const bcData = bcCanvas.toDataURL('image/png');
      doc.addImage(bcData, 'PNG', x + 2, y + 9, cellW * 0.55 - 4, cellH - 22);
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

// ========== INVENTORY ==========
function wireInventory() {
  $('#btn-grn').addEventListener('click', openGRNModal);
  $('#btn-adjust').addEventListener('click', openAdjModal);
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

  wireProductPicker($('#grn-search'), $('#grn-dropdown'), (p) => {
    state.grnTarget = p;
    const box = $('#grn-selected');
    box.classList.remove('hidden');
    box.innerHTML = `Selected: <b>${escapeHTML(p.shortCode)}</b> — ${escapeHTML(p.name)} (current stock: ${p.stockQty})`;
  });
  wireProductPicker($('#adj-search'), $('#adj-dropdown'), (p) => {
    state.adjTarget = p;
    const box = $('#adj-selected');
    box.classList.remove('hidden');
    box.innerHTML = `Selected: <b>${escapeHTML(p.shortCode)}</b> — ${escapeHTML(p.name)} (current stock: ${p.stockQty})`;
    $('#adj-qty').value = p.stockQty;
  });
  $('#grn-save').addEventListener('click', saveGRN);
  $('#adj-save').addEventListener('click', saveAdj);
}

function openGRNModal() {
  state.grnTarget = null;
  $('#grn-search').value = '';
  $('#grn-qty').value = '';
  $('#grn-ref').value = '';
  $('#grn-selected').classList.add('hidden');
  openModal('modal-grn');
  setTimeout(() => $('#grn-search').focus(), 50);
}
function openAdjModal() {
  state.adjTarget = null;
  $('#adj-search').value = '';
  $('#adj-qty').value = '';
  $('#adj-selected').classList.add('hidden');
  openModal('modal-adjust');
  setTimeout(() => $('#adj-search').focus(), 50);
}

function wireProductPicker(input, dd, onPick) {
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
    dd.innerHTML = matches.map((p) => `
      <div class="item" data-pid="${p.id}">
        <div><div class="font-medium">${escapeHTML(p.name)}</div><div class="text-xs text-gray-500 mono">${escapeHTML(p.shortCode)}</div></div>
        <div class="text-right text-sm">${p.stockQty} in stock</div>
      </div>
    `).join('');
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

async function saveGRN() {
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
    reason: 'GRN' + (ref ? ' · ' + ref : ''),
    date: nowISO(),
  });
  closeModal('modal-grn');
  toast(`Added ${qty} to ${p.shortCode}`, 'success');
  await refreshProducts();
  renderInventoryCategoryView();
  if (state.currentInvCategory) renderInventoryList();
}

async function saveAdj() {
  if (!state.adjTarget) return toast('Pick a product', 'error');
  const newQty = parseInt($('#adj-qty').value, 10);
  const reason = $('#adj-reason').value;
  if (!(newQty >= 0)) return toast('Enter a valid quantity', 'error');
  const p = await db.get('products', state.adjTarget.id);
  const diff = newQty - (p.stockQty || 0);
  if (diff === 0) { closeModal('modal-adjust'); return; }
  p.stockQty = newQty;
  p.updatedAt = nowISO();
  await db.put('products', p);
  await db.add('stockMovements', {
    productId: p.id, type: 'adjust', qty: diff,
    reason, date: nowISO(),
  });
  closeModal('modal-adjust');
  toast(`Stock updated to ${newQty}`, 'success');
  await refreshProducts();
  renderInventoryCategoryView();
  if (state.currentInvCategory) renderInventoryList();
}

function inventoryCountsByCategory() {
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

function renderInventoryCategoryView() {
  $('#inv-list-view').classList.add('hidden');
  $('#inv-cat-view').classList.remove('hidden');

  const totalSKUs = state.products.length;
  const totalStock = state.products.reduce((s, p) => s + (p.stockQty || 0), 0);
  const low = state.products.filter(p => (p.stockQty || 0) <= (p.reorderLevel || 0));
  $('#inv-total-skus').textContent = fmtInt(totalSKUs);
  $('#inv-total-stock').textContent = fmtInt(totalStock);
  $('#inv-low-count').textContent = fmtInt(low.length);

  const agg = inventoryCountsByCategory();
  const q = $('#inv-cat-search').value.trim().toLowerCase();
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

function renderInventoryList() {
  const cat = state.currentInvCategory;
  const q = $('#inv-search').value.trim().toLowerCase();
  let list = state.products.filter(p => canonicalCategory(p.category) === cat);
  if (q) list = list.filter(p => (p.name || '').toLowerCase().includes(q) || (p.shortCode || '').toLowerCase().includes(q));
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

// ========== DAILY SALES ==========
function wireDaily() {
  $('#daily-date').addEventListener('change', (e) => {
    state.dailySelectedDate = e.target.value;
    renderDaily();
  });
  $('#btn-daily-today').addEventListener('click', () => {
    state.dailySelectedDate = todayISO();
    $('#daily-date').value = state.dailySelectedDate;
    renderDaily();
  });
  $('#daily-search').addEventListener('input', debounce(renderDaily, 100));
}

async function renderDaily() {
  const invoices = await db.all('invoices');
  // Group by day
  const byDay = {};
  for (const inv of invoices) {
    const day = (inv.date || '').slice(0, 10);
    if (!day) continue;
    if (!byDay[day]) byDay[day] = { date: day, invoices: [], bills: 0, items: 0, total: 0, qty: 0 };
    byDay[day].invoices.push(inv);
    byDay[day].bills++;
    byDay[day].total += (inv.adjustedTotal ?? inv.total) || 0;
    byDay[day].items += (inv.items || []).length;
    byDay[day].qty += (inv.items || []).reduce((s, l) => s + (l.qty || 0), 0);
  }
  const days = Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date));

  // Auto-pick most recent day if none selected
  if (!state.dailySelectedDate && days.length) {
    state.dailySelectedDate = days[0].date;
    $('#daily-date').value = state.dailySelectedDate;
  }

  // Days list (filterable by date or customer name)
  const q = $('#daily-search').value.trim().toLowerCase();
  const filteredDays = days.filter(d => {
    if (!q) return true;
    if (d.date.includes(q)) return true;
    // Match if any invoice in this day has the customer name matching
    return d.invoices.some(inv => (inv.customerName || '').toLowerCase().includes(q));
  });
  const daysBox = $('#daily-days-list');
  if (!filteredDays.length) {
    daysBox.innerHTML = `<div class="p-4 text-sm text-gray-400 text-center">No sales yet</div>`;
  } else {
    daysBox.innerHTML = filteredDays.map(d => {
      const active = d.date === state.dailySelectedDate;
      const dt = new Date(d.date + 'T00:00:00');
      const label = dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      return `
        <button class="w-full text-left p-3 border-b hover:bg-gray-50 ${active ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''}" data-day="${d.date}">
          <div class="flex justify-between items-baseline gap-2">
            <div class="font-medium text-sm">${escapeHTML(label)}</div>
            <div class="font-semibold text-sm">${fmtMoney(d.total)}</div>
          </div>
          <div class="text-xs text-gray-500">${d.bills} bills · ${d.qty} units</div>
        </button>
      `;
    }).join('');
    daysBox.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => {
      state.dailySelectedDate = b.dataset.day;
      $('#daily-date').value = b.dataset.day;
      renderDaily();
    }));
  }

  // Day details
  const sel = state.dailySelectedDate;
  const body = $('#daily-items-body');
  const title = $('#daily-day-title');
  const stats = $('#daily-day-stats');
  if (!sel || !byDay[sel]) {
    title.textContent = sel ? sel : 'Select a day';
    stats.textContent = sel ? 'No sales that day' : '';
    body.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-gray-400">${sel ? 'No sales on ' + sel : 'No day selected'}</td></tr>`;
    return;
  }
  const d = byDay[sel];
  const dt = new Date(sel + 'T00:00:00');
  title.textContent = dt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  stats.textContent = `${d.bills} bills · ${d.qty} units · ${fmtMoney(d.total)}`;

  // Flatten line items
  const lines = [];
  for (const inv of d.invoices) {
    for (const l of (inv.items || [])) {
      lines.push({
        time: inv.date,
        invoiceNo: inv.invoiceNo,
        customer: inv.customerName || '',
        customerGst: inv.customerGst || '',
        adjusted: inv.adjustedTotal != null,
        name: l.name,
        qty: l.qty,
        price: l.price,
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
    const t = new Date(l.time);
    const custBadge = l.customerGst
      ? ` <span class="text-xs bg-green-100 text-green-700 px-1 rounded" title="Customer has GST: ${escapeHTML(l.customerGst)}">GST</span>`
      : '';
    const adjBadge = l.adjusted
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

// ========== REPORTS ==========
// User2 sees actual (pre-scale) totals; User1 sees filed (post-scale) totals
function getActualTotal(inv) {
  if (inv._gstOriginalItems) {
    return inv._gstOriginalItems.reduce((s, l) => s + (l.price || 0) * (l.qty || 0), 0);
  }
  return inv.total || 0;
}
function getDisplayTotal(inv) {
  return state.currentUser === 'user2' ? getActualTotal(inv) : (inv.total || 0);
}

function wireReports() {
  $('#btn-rep-filter').addEventListener('click', renderReports);
  $('#btn-rep-today').addEventListener('click', () => {
    $('#rep-date-from').value = todayISO();
    $('#rep-date-to').value = todayISO();
    renderReports();
  });
  $('#btn-rep-export').addEventListener('click', exportBillsCSV);
  $$('.rep-cust-filter-btn').forEach(btn => btn.addEventListener('click', () => {
    state.repCustFilter = btn.dataset.filter;
    $$('.rep-cust-filter-btn').forEach(b => {
      b.className = `rep-cust-filter-btn px-3 py-1.5 font-medium ${b.dataset.filter === state.repCustFilter ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`;
    });
    renderReports();
  }));
}

async function renderReports() {
  const invoices = await db.all('invoices');
  invoices.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const today = todayISO();
  const monthPrefix = today.slice(0, 7);

  const todayInv = invoices.filter(i => (i.date || '').slice(0, 10) === today);
  const monthInv = invoices.filter(i => (i.date || '').slice(0, 7) === monthPrefix);
  const monthGst    = monthInv.filter(i => i.customerGst);
  const monthWalkin = monthInv.filter(i => !i.customerGst);

  $('#rep-today-sales').textContent = fmtMoney(todayInv.reduce((s, i) => s + getDisplayTotal(i), 0));
  $('#rep-today-bills').textContent = `${todayInv.length} bills`;
  $('#rep-month-sales').textContent = fmtMoney(monthInv.reduce((s, i) => s + getDisplayTotal(i), 0));
  $('#rep-month-bills').textContent = `${monthInv.length} bills`;
  $('#rep-month-gst-sales').textContent = fmtMoney(monthGst.reduce((s, i) => s + getDisplayTotal(i), 0));
  $('#rep-month-gst-bills').textContent = `${monthGst.length} bills`;
  $('#rep-month-walkin-sales').textContent = fmtMoney(monthWalkin.reduce((s, i) => s + getDisplayTotal(i), 0));
  $('#rep-month-walkin-bills').textContent = `${monthWalkin.length} bills`;
  $('#rep-alltime-sales').textContent = fmtMoney(invoices.reduce((s, i) => s + getDisplayTotal(i), 0));
  $('#rep-alltime-bills').textContent = `${invoices.length} bills`;

  const from = $('#rep-date-from').value;
  const to = $('#rep-date-to').value;
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
      const d = new Date(i.date);
      const itemCount = (i.items || []).reduce((s, l) => s + l.qty, 0);
      const gstBadge = i.customerGst
        ? ` <span class="text-xs bg-green-100 text-green-700 px-1 rounded" title="GSTIN: ${escapeHTML(i.customerGst)}">GST</span>`
        : '';
      const reportedTotal = getDisplayTotal(i);
      const adjBadge = i._gstOriginalItems
        ? ` <span class="text-xs bg-orange-100 text-orange-700 px-1 rounded" title="${state.currentUser === 'user2' ? 'Filed: ' + fmtMoney(i.total) : 'Scaled'}">adj</span>`
        : '';
      return `<tr>
        <td class="mono">${escapeHTML(i.invoiceNo)}</td>
        <td class="text-xs">${d.toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td>${escapeHTML(i.customerName || '')}${gstBadge}</td>
        <td class="text-right">${itemCount}</td>
        <td class="text-right font-semibold">${fmtMoney(reportedTotal)}${adjBadge}</td>
        <td class="text-right">${i.amountPaid != null ? fmtMoney(i.amountPaid) : '—'}</td>
        <td><button class="text-blue-600 hover:underline text-sm" data-reprint="${i.id}">Reprint</button></td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-reprint]').forEach(b => b.addEventListener('click', () => reprintInvoice(+b.dataset.reprint)));
  }

  const counter = {};
  for (const inv of invoices) {
    for (const l of inv.items || []) {
      const k = l.shortCode || '__' + l.name;
      if (!counter[k]) counter[k] = { name: l.name, shortCode: l.shortCode, qty: 0, rev: 0 };
      counter[k].qty += l.qty;
      counter[k].rev += l.qty * l.price;
    }
  }
  const top = Object.values(counter).sort((a, b) => b.qty - a.qty).slice(0, 20);
  const tBody = $('#top-items-body');
  if (!top.length) {
    tBody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-gray-400">No sales yet</td></tr>`;
  } else {
    tBody.innerHTML = top.map(t => `<tr>
      <td class="mono">${escapeHTML(t.shortCode || '—')}</td>
      <td>${escapeHTML(t.name)}</td>
      <td class="text-right">${fmtInt(t.qty)}</td>
      <td class="text-right">${fmtMoney(t.rev)}</td>
    </tr>`).join('');
  }
}

async function reprintInvoice(id) {
  const inv = await db.get('invoices', id);
  if (!inv) return;
  renderBillToPrintArea(inv);
  window.print();
}

async function exportBillsCSV() {
  const invoices = await db.all('invoices');
  const from = $('#rep-date-from').value;
  const to = $('#rep-date-to').value;
  let list = invoices;
  if (from) list = list.filter(i => (i.date || '').slice(0, 10) >= from);
  if (to) list = list.filter(i => (i.date || '').slice(0, 10) <= to);

  const rows = [['Invoice', 'Date', 'Customer', 'CustomerPhone', 'CustomerGST', 'ItemCode', 'ItemName', 'Qty', 'Price', 'LineTotal', 'InvoiceTotal', 'AdjustedTotal', 'AmountPaid', 'Notes']];
  for (const inv of list) {
    const date = (inv.date || '').slice(0, 10);
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

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ========== VOID BILLS ==========
function wireVoidBills() {
  $('#btn-scale-down').addEventListener('click', openVoidBillsModal);
  $('#void-month').addEventListener('change', renderVoidBillsList);
  $('#btn-void-enter').addEventListener('click', applyVoidBills);
  $('#btn-void-restore').addEventListener('click', restoreVoidBills);
  $('#btn-void-pdf').addEventListener('click', downloadVoidBillsPDF);
}

async function openVoidBillsModal() {
  $('#void-month').value = new Date().toISOString().slice(0, 7);
  $('#void-target').value = '';
  await renderVoidBillsList();
  openModal('modal-void-bills');
}

async function renderVoidBillsList() {
  const month = $('#void-month').value;
  const body = $('#void-bills-list');
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
    const d = new Date(i.date);
    const modified = !!i._gstOriginalItems;
    return `<div class="flex items-center gap-3 px-3 py-2 border-b last:border-0 ${modified ? 'bg-orange-50' : ''}">
      <span class="mono text-xs text-gray-500">${escapeHTML(i.invoiceNo)}</span>
      <span class="text-xs text-gray-400">${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
      <span class="flex-1 text-xs truncate">${escapeHTML(i.customerName || '')}</span>
      <span class="font-semibold text-sm">${fmtMoney(i.total)}</span>
      ${modified ? `<span class="text-xs text-orange-400">●</span>` : ''}
    </div>`;
  }).join('');

  const total = monthInv.reduce((s, i) => s + (i.total || 0), 0);
  body.innerHTML = rows + `<div class="flex justify-between px-3 py-2 bg-gray-50 font-semibold text-sm">
    <span>Total</span><span>${fmtMoney(total)}</span>
  </div>`;
}

async function applyVoidBills() {
  const month = $('#void-month').value;
  const target = parseFloat($('#void-target').value);
  if (!month || isNaN(target) || target < 0) return;

  const invoices = await db.all('invoices');
  const monthInv = invoices.filter(i => (i.date || '').slice(0, 7) === month);
  const protectedInv = monthInv.filter(i => i.customerGst);
  const adjustableInv = monthInv.filter(i => !i.customerGst);

  const protectedTotal = protectedInv.reduce((s, i) => s + (i.total || 0), 0);
  const adjustableTotal = adjustableInv.reduce((s, i) => s + (i.total || 0), 0);

  if (!adjustableInv.length || target < protectedTotal || !adjustableTotal) return;

  const adjustableTarget = target - protectedTotal;
  const reductionNeeded = adjustableTotal - adjustableTarget;

  // Mutable item copies + original snapshot per invoice
  const billItems    = new Map(adjustableInv.map(inv => [inv.id, (inv.items || []).map(it => ({ ...it }))]));
  const origSnapshot = new Map(adjustableInv.map(inv => [inv.id, (inv.items || []).map(it => ({ ...it }))]));
  // Track total units remaining per bill (so we never empty a bill)
  const billQty = new Map(adjustableInv.map(inv => [inv.id, (inv.items || []).reduce((s, l) => s + (l.qty || 0), 0)]));

  // Expand every unit as a separate entry, sorted cheapest unit price first
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
    if ((billQty.get(invId) || 0) <= 1) continue; // keep at least 1 unit per bill
    if ((item.qty || 0) <= 0) continue;
    item.qty--;
    billQty.set(invId, billQty.get(invId) - 1);
    reducedSoFar += item.unitPrice;
  }

  for (const inv of adjustableInv) {
    const updatedItems = billItems.get(inv.id).filter(i => (i.qty || 0) > 0);
    const newTotal = updatedItems.reduce((s, l) => s + (l.price || 0) * (l.qty || 0), 0);
    await db.put('invoices', {
      ...inv,
      items: updatedItems,
      subtotal: newTotal,
      total: newTotal,
      _gstOriginalItems: origSnapshot.get(inv.id), // full snapshot for restore
    });
  }

  toast('Done', 'success');
  $('#void-target').value = '';
  await renderVoidBillsList();
  await renderReports();
}

async function downloadVoidBillsPDF() {
  const month = $('#void-month').value;
  if (!month) return;

  const invoices = await db.all('invoices');
  const monthInv = invoices
    .filter(i => (i.date || '').slice(0, 7) === month)
    .sort((a, b) => (a.invoiceNo || '').localeCompare(b.invoiceNo || ''));

  if (!monthInv.length) { toast('No bills this month', 'error'); return; }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const s = state.settings;
  const pageW = 210, pageH = 297, mg = 12;
  const colW = pageW - mg * 2;
  let y = mg, pageNum = 1;

  const addPageHeader = () => {
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(150);
    doc.text(`${s.shopName || ''} — ${month}`, mg, 8);
    doc.text(`Page ${pageNum}`, pageW - mg, 8, { align: 'right' });
    doc.setTextColor(0);
    y = mg + 4;
  };
  addPageHeader();

  for (const inv of monthInv) {
    const items = inv.items || [];
    const billH = 20 + items.length * 5 + 8;

    if (y + billH > pageH - mg) {
      doc.addPage();
      pageNum++;
      addPageHeader();
    }

    const d = new Date(inv.date);
    const dateStr = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

    // Invoice header row
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
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

    // Column headers
    doc.setFontSize(6.5);
    doc.setTextColor(120);
    doc.text('Item', mg, y);
    doc.text('Qty', mg + colW * 0.62, y);
    doc.text('Rate', mg + colW * 0.75, y);
    doc.text('Amount', pageW - mg, y, { align: 'right' });
    doc.setTextColor(0);
    y += 1.5;
    doc.setDrawColor(180);
    doc.line(mg, y, pageW - mg, y);
    y += 3;

    // Line items
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    for (const item of items) {
      const name = (item.name || '').length > 30 ? item.name.slice(0, 29) + '…' : item.name;
      doc.text(name, mg, y);
      doc.text(String(item.qty || 0), mg + colW * 0.62, y);
      doc.text(fmtMoney(item.price || 0), mg + colW * 0.75, y);
      doc.text(fmtMoney((item.price || 0) * (item.qty || 0)), pageW - mg, y, { align: 'right' });
      y += 5;
    }

    // Total
    doc.setDrawColor(180);
    doc.line(mg, y, pageW - mg, y);
    y += 3;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text('Total', mg, y);
    doc.text(fmtMoney(inv.total), pageW - mg, y, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    y += 4;

    // Bill separator
    doc.setDrawColor(210);
    doc.setLineDashPattern([2, 2], 0);
    doc.line(mg, y, pageW - mg, y);
    doc.setLineDashPattern([], 0);
    doc.setDrawColor(0);
    y += 5;
  }

  // Grand total summary
  if (y + 10 > pageH - mg) { doc.addPage(); pageNum++; addPageHeader(); }
  const grandTotal = monthInv.reduce((s, i) => s + (i.total || 0), 0);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text(`${monthInv.length} bills   Grand Total: ${fmtMoney(grandTotal)}`, mg, y);

  doc.save(`bills-${month}.pdf`);
  toast('PDF downloaded', 'success');
}

async function restoreVoidBills() {
  const month = $('#void-month').value;
  if (!month) return;
  const invoices = await db.all('invoices');
  const monthInv = invoices.filter(i => (i.date || '').slice(0, 7) === month);

  for (const inv of monthInv) {
    if (!inv._gstOriginalItems) continue;
    const restoredItems = inv._gstOriginalItems;
    const newTotal = restoredItems.reduce((s, l) => s + (l.price || 0) * (l.qty || 0), 0);
    const updated = { ...inv, items: restoredItems, subtotal: newTotal, total: newTotal };
    delete updated._gstOriginalItems;
    await db.put('invoices', updated);
  }

  toast('Restored', 'success');
  await renderVoidBillsList();
  await renderReports();
}

// ========== SETTINGS ==========
function wireSettings() {
  $('#btn-save-settings').addEventListener('click', saveSettings);
  $('#btn-export').addEventListener('click', exportBackup);
  $('#import-file').addEventListener('change', importBackup);
  $('#btn-reset').addEventListener('click', resetAllData);
}

function applySettingsToForm() {
  const s = state.settings;
  $('#set-shop-name').value = s.shopName || '';
  $('#set-address').value = s.address || '';
  $('#set-phone').value = s.phone || '';
  $('#set-gstin').value = s.gstin || '';
  $('#set-inv-prefix').value = s.invoicePrefix || '';
  $('#set-inv-next').value = s.nextInvoiceNo || 1;
  $('#set-footer').value = s.footer || '';
  $('#set-user1-name').value = s.user1Name || 'accounts';
  $('#set-user1-pass').value = s.user1Pass || '';
  $('#set-user2-name').value = s.user2Name || 'admin';
  $('#set-user2-pass').value = s.user2Pass || '';
}

async function saveSettings() {
  const s = state.settings;
  s.shopName = $('#set-shop-name').value.trim() || 'Shop';
  s.address = $('#set-address').value.trim();
  s.phone = $('#set-phone').value.trim();
  s.gstin = $('#set-gstin').value.trim();
  s.invoicePrefix = $('#set-inv-prefix').value.trim() || 'INV-';
  s.nextInvoiceNo = Math.max(1, parseInt($('#set-inv-next').value || '1', 10));
  s.footer = $('#set-footer').value.trim();
  const u1Name = $('#set-user1-name').value.trim();
  const u1Pass = $('#set-user1-pass').value;
  const u2Name = $('#set-user2-name').value.trim();
  const u2Pass = $('#set-user2-pass').value;
  if (u1Name) s.user1Name = u1Name;
  if (u1Pass) s.user1Pass = u1Pass;
  if (u2Name) s.user2Name = u2Name;
  if (u2Pass) s.user2Pass = u2Pass;
  for (const [k, v] of Object.entries(s)) await db.setSetting(k, v);
  toast('Settings saved', 'success');
}

async function exportBackup() {
  const data = await db.exportAll();
  const json = JSON.stringify(data, null, 2);
  downloadBlob(new Blob([json], { type: 'application/json' }), `toolbill-backup-${todayISO()}.json`);
  toast('Backup downloaded', 'success');
}
window.exportBackup = exportBackup; // Exposed so the update banner can trigger it

async function importBackup(e) {
  const f = e.target.files[0];
  if (!f) return;
  if (!confirm('This replaces ALL current data (products, invoices, stock, settings, categories, drafts). Continue?')) {
    e.target.value = ''; return;
  }
  const text = await f.text();
  try {
    const data = JSON.parse(text);
    await db.importAll(data);
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      state.settings[k] = await db.getSetting(k, v);
    }
    await refreshCategories();
    await refreshProducts();
    await refreshDrafts();
    await migrateLegacyProductCategories();
    populateCategorySelects();
    applySettingsToForm();
    renderProductsCategoryView();
    renderInventoryCategoryView();
    renderReports();
    renderDrafts();
    toast('Backup restored', 'success');
  } catch (err) {
    console.error(err); toast('Import failed: ' + err.message, 'error');
  } finally {
    e.target.value = '';
  }
}

async function resetAllData() {
  if (!confirm('ERASE all products, bills, stock, categories, drafts and settings?\nThis cannot be undone. Export a backup first.')) return;
  if (!confirm('Last chance. Really erase everything?')) return;
  await db.wipe();
  state.settings = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await db.setSetting(k, v);
  // Re-seed default categories
  for (const name of DEFAULT_CATEGORIES) {
    await db.add('categories', { name, createdAt: nowISO() });
  }
  await refreshCategories();
  await refreshProducts();
  await refreshDrafts();
  populateCategorySelects();
  applySettingsToForm();
  renderProductsCategoryView();
  renderInventoryCategoryView();
  renderReports();
  renderDrafts();
  toast('All data erased', 'success');
}

// ========== Date input digit enforcement ==========
function wireDateInputs() {
  document.querySelectorAll('input[type="date"]').forEach(el => {

    // Truncate year to 4 digits the moment a 5th digit is entered
    el.addEventListener('input', () => {
      if (!el.value) return;
      const parts = el.value.split('-');           // ['YYYY', 'MM', 'DD']
      if (parts[0] && parts[0].length > 4) {
        parts[0] = parts[0].slice(0, 4);
        el.value = parts.join('-');
      }
    });

    // On leaving the field, clamp month/day to valid ranges
    el.addEventListener('blur', () => {
      if (!el.value) return;
      const [y, m, d] = el.value.split('-').map(Number);
      if (!y) return;
      const mo = String(Math.max(1, Math.min(12, m || 1))).padStart(2, '0');
      const dy = String(Math.max(1, Math.min(31, d || 1))).padStart(2, '0');
      const corrected = `${y}-${mo}-${dy}`;
      if (el.value !== corrected) {
        el.value = corrected;
        el.dispatchEvent(new Event('change'));
      }
    });
  });
}

// ========== CAMERA BARCODE SCANNER (ZXing — works on all browsers) ==========
let _zxingReader = null;
let _lastScannedCode = '';
let _lastScannedTime = 0;

function wireCameraScanner() {
  const btn = $('#btn-camera-scan');
  if (!btn) return;
  btn.addEventListener('click', openCameraScanner);
  $('#btn-camera-close').addEventListener('click', closeCameraScanner);
}

async function openCameraScanner() {
  const modal   = $('#modal-camera');
  const video   = $('#camera-preview');
  const status  = $('#cam-status');

  modal.classList.remove('hidden');
  status.textContent = 'Starting camera…';
  status.style.background = '';
  $('#cam-last-scan').textContent = '';

  if (!window.ZXing) {
    status.textContent = 'Scanner library not loaded — check internet connection';
    return;
  }

  try {
    _zxingReader = new ZXing.BrowserMultiFormatReader();

    // Pass null → ZXing picks default/only camera automatically (no device enumeration needed)
    await _zxingReader.decodeFromVideoDevice(null, 'camera-preview', (result, err) => {
      if (!result) return;
      const code = result.getText();
      const now  = Date.now();

      // Debounce — ignore same code within 2 s
      if (code === _lastScannedCode && now - _lastScannedTime < 2000) return;
      _lastScannedCode = code;
      _lastScannedTime = now;

      // Green flash
      status.textContent = '✓ ' + code;
      status.style.background = 'rgba(22,163,74,0.85)';
      setTimeout(() => {
        if (status) { status.textContent = 'Point camera at a barcode…'; status.style.background = ''; }
      }, 900);

      // Normalize common camera misreads: '-' sometimes scanned as '%'
      const normalised = code.replace(/%/g, '-');

      // Add item to cart
      const searchEl = $('#bill-search');
      searchEl.value = normalised;
      handleEnterInBillSearch();
      searchEl.value = '';
      $('#cam-last-scan').textContent = 'Last scanned: ' + normalised;
    });

    status.textContent = 'Point camera at a barcode…';
  } catch (err) {
    status.textContent = err.name === 'NotAllowedError'
      ? '⚠ Camera access denied — allow camera in browser settings'
      : '⚠ Could not start camera: ' + err.message;
  }
}

function closeCameraScanner() {
  if (_zxingReader) {
    _zxingReader.reset();
    _zxingReader = null;
  }
  $('#modal-camera').classList.add('hidden');
  _lastScannedCode = '';
}

// ========== ADMIN AUTH (two-user) ==========
function applyUserState() {
  const u = state.currentUser;

  // Tab visibility:
  //   public (null): Sell, Products, Labels
  //   user1 (accounts): + Reports
  //   user2 (admin): + Inventory, Daily Sales, Reports, Settings
  $$('.tab-btn').forEach(btn => {
    const tab = btn.dataset.tab;
    const always = ['billing', 'products', 'labels'].includes(tab);
    const anyUser = tab === 'reports';
    const user2Only = ['inventory', 'daily', 'settings'].includes(tab);
    if (always) {
      btn.style.display = '';
    } else if (anyUser) {
      btn.style.display = u ? '' : 'none';
    } else if (user2Only) {
      btn.style.display = u === 'user2' ? '' : 'none';
    }
  });

  // Admin button label / colour
  const label = $('#admin-btn-label');
  const btn = $('#btn-admin-login');
  if (u) {
    const name = u === 'user1'
      ? (state.settings.user1Name || 'accounts')
      : (state.settings.user2Name || 'admin');
    if (label) label.textContent = name + ' ✓';
    if (btn) { btn.style.background = '#dcfce7'; btn.style.color = '#15803d'; }
  } else {
    if (label) label.textContent = 'Admin';
    if (btn) { btn.style.background = ''; btn.style.color = ''; }
  }

  // Scale Down button: only for user2
  const scaleBtn = $('#btn-scale-down');
  if (scaleBtn) scaleBtn.classList.toggle('hidden', u !== 'user2');

  // User credentials section in Settings: only for user2
  const userCredsSection = $('#user-creds-section');
  if (userCredsSection) userCredsSection.classList.toggle('hidden', u !== 'user2');
}

function openAdminModal() {
  const loggedIn = !!state.currentUser;
  $('#admin-login-form').classList.toggle('hidden', loggedIn);
  $('#admin-logout-form').classList.toggle('hidden', !loggedIn);
  if (loggedIn) {
    const name = state.currentUser === 'user1'
      ? (state.settings.user1Name || 'accounts')
      : (state.settings.user2Name || 'admin');
    $('#admin-logged-user').textContent = name;
  } else {
    $('#admin-username').value = '';
    $('#admin-password').value = '';
    $('#admin-login-error').classList.add('hidden');
  }
  openModal('modal-admin');
  if (!loggedIn) setTimeout(() => $('#admin-username').focus(), 50);
}

function wireAdmin() {
  $('#btn-admin-login').addEventListener('click', openAdminModal);
  $('#btn-admin-submit').addEventListener('click', attemptAdminLogin);
  $('#admin-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptAdminLogin(); });
  $('#btn-admin-logout').addEventListener('click', () => {
    state.currentUser = null;
    applyUserState();
    const active = document.querySelector('.tab-btn[data-active="true"]');
    if (active && !['billing','products','labels'].includes(active.dataset.tab)) switchTab('billing');
    closeAnyModal();
    toast('Logged out', '');
  });
}

function attemptAdminLogin() {
  const user = $('#admin-username').value.trim().toLowerCase();
  const pass = $('#admin-password').value;
  const u1 = (state.settings.user1Name || 'accounts').toLowerCase();
  const u1p = state.settings.user1Pass || '1234';
  const u2 = (state.settings.user2Name || 'admin').toLowerCase();
  const u2p = state.settings.user2Pass || 'admin123';

  if (user === u1 && pass === u1p) {
    state.currentUser = 'user1';
  } else if (user === u2 && pass === u2p) {
    state.currentUser = 'user2';
  } else {
    $('#admin-login-error').classList.remove('hidden');
    $('#admin-password').value = '';
    $('#admin-password').focus();
    return;
  }
  applyUserState();
  closeAnyModal();
  if (state.currentUser === 'user1') switchTab('reports');
  toast('Welcome', 'success');
}

// ========== Boot ==========
document.addEventListener('DOMContentLoaded', init);
