// app.js — ToolBill main application
import { db } from './db.js';

// ========== Constants ==========
const CATEGORIES = [
  { code: 'HT', name: 'Hand Tools' },
  { code: 'PT', name: 'Power Tools' },
  { code: 'FS', name: 'Fasteners' },
  { code: 'LB', name: 'Lubricants' },
  { code: 'CH', name: 'Chemicals' },
  { code: 'AB', name: 'Abrasives' },
  { code: 'EL', name: 'Electrical' },
  { code: 'AS', name: 'Auto Spares' },
  { code: 'GN', name: 'General' },
];
const CAT_NAME = Object.fromEntries(CATEGORIES.map(c => [c.code, c.name]));

const DEFAULT_SETTINGS = {
  shopName: 'My Tools Shop',
  address: '',
  phone: '',
  gstin: '',
  invoicePrefix: 'INV-',
  nextInvoiceNo: 1,
  footer: 'Thank you! Visit again.',
};

// ========== State ==========
const state = {
  products: [],      // cached from DB
  settings: { ...DEFAULT_SETTINGS },
  cart: [],          // [{productId, shortCode, name, price, qty, unit}]
  searchResults: [],
  searchActive: -1,
  selectedLabels: new Set(),
  showLowOnly: false,
  bulkPreview: null,
  grnTarget: null,
  adjTarget: null,
  filters: {
    products: { q: '', category: '' },
    labels: { q: '', category: '' },
    reports: { from: '', to: '' },
  },
};

// ========== Utils ==========
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmtMoney = (n) => '₹' + (Number(n) || 0).toFixed(2);
const fmtInt = (n) => (Number(n) || 0).toLocaleString('en-IN');
const todayISO = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();

function escapeHTML(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Human-readable, single-line QR payload so a phone scanner shows the
// code, name and price in plain text. Example:
//   HT-0001|Hydraulic Jack 2 Ton|₹1800
// Kept on one line so keyboard-wedge scanners (which send Enter at the
// end) don't trigger mid-scan.
function makeQRPayload(p) {
  const name = (p.name || '').replace(/[|\r\n]/g, ' ').trim();
  return `${p.shortCode}|${name}|₹${p.sellingPrice}`;
}

// Parse either the new pipe format or the legacy JSON format.
// Returns { code, name, price } or null.
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
}

function debounce(fn, ms = 120) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ========== Initialization ==========
async function init() {
  // Populate category dropdowns
  populateCategorySelects();

  // Load settings
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    const val = await db.getSetting(k, v);
    state.settings[k] = val;
  }
  applySettingsToForm();

  // Load products
  await refreshProducts();

  // Wire up UI
  wireTabs();
  wireBilling();
  wireProducts();
  wireInventory();
  wireLabels();
  wireReports();
  wireSettings();
  wireHotkeys();
  wireModalClose();

  // Default tab
  switchTab('billing');
}

function populateCategorySelects() {
  const optHTML = CATEGORIES.map(c => `<option value="${c.code}">${c.code} — ${c.name}</option>`).join('');
  const pmCat = $('#pm-category');
  if (pmCat) pmCat.innerHTML = optHTML;

  const filterHTML = `<option value="">All categories</option>` + optHTML;
  $('#product-category-filter').innerHTML = filterHTML;
  $('#labels-category').innerHTML = filterHTML;
}

async function refreshProducts() {
  state.products = await db.all('products');
  state.products.sort((a, b) => (a.shortCode || '').localeCompare(b.shortCode || ''));
}

// ========== Tabs ==========
function switchTab(name) {
  $$('.tab-btn').forEach(b => b.setAttribute('data-active', b.dataset.tab === name ? 'true' : 'false'));
  $$('.tab-content').forEach(s => s.setAttribute('data-active', s.id === 'tab-' + name ? 'true' : 'false'));
  // Refresh per-tab data
  if (name === 'billing') setTimeout(() => $('#bill-search').focus(), 50);
  if (name === 'products') renderProducts();
  if (name === 'inventory') renderInventory();
  if (name === 'labels') renderLabels();
  if (name === 'reports') renderReports();
  if (name === 'settings') applySettingsToForm();
}

function wireTabs() {
  $$('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
}

function wireHotkeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F2') { e.preventDefault(); switchTab('billing'); $('#bill-search').focus(); }
    if (e.key === 'F9') {
      e.preventDefault();
      if (state.cart.length) saveAndPrintBill();
    }
    if (e.key === 'Escape') closeAnyModal();
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
  $('#product-search').addEventListener('input', debounce(renderProducts, 100));
  $('#product-category-filter').addEventListener('change', renderProducts);
  $('#btn-add-product').addEventListener('click', () => openProductModal(null));
  $('#btn-bulk-add').addEventListener('click', () => openBulkModal());
  $('#pm-save').addEventListener('click', saveProductFromModal);
  $('#pm-category').addEventListener('change', updatePendingShortCode);
  $('#bulk-parse').addEventListener('click', parseBulk);
  $('#bulk-save').addEventListener('click', saveBulk);
}

function productsFiltered() {
  const q = $('#product-search').value.trim().toLowerCase();
  const cat = $('#product-category-filter').value;
  return state.products.filter(p => {
    if (cat && p.category !== cat) return false;
    if (!q) return true;
    return (p.name || '').toLowerCase().includes(q) || (p.shortCode || '').toLowerCase().includes(q);
  });
}

function renderProducts() {
  const list = productsFiltered();
  const body = $('#products-body');
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-gray-400">No products yet. Click "+ Add Product" or "Bulk Add".</td></tr>`;
  } else {
    body.innerHTML = list.map(p => `
      <tr>
        <td class="mono">${escapeHTML(p.shortCode)}</td>
        <td>${escapeHTML(p.name)}</td>
        <td>${escapeHTML(CAT_NAME[p.category] || p.category || '')}</td>
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
  $('#product-count').textContent = `${state.products.length} products`;

  body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openProductModal(+b.dataset.edit)));
  body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteProduct(+b.dataset.del)));
  body.querySelectorAll('[data-label]').forEach(b => b.addEventListener('click', () => showSingleLabel(+b.dataset.label)));
}

function openProductModal(id) {
  const editing = id ? state.products.find(p => p.id === id) : null;
  $('#product-modal-title').textContent = editing ? 'Edit product' : 'Add product';
  $('#pm-name').value = editing?.name || '';
  $('#pm-category').value = editing?.category || 'GN';
  $('#pm-unit').value = editing?.unit || 'piece';
  $('#pm-price').value = editing?.sellingPrice ?? '';
  $('#pm-stock').value = editing?.stockQty ?? 0;
  $('#pm-reorder').value = editing?.reorderLevel ?? 5;
  $('#pm-hsn').value = editing?.hsn || '';
  $('#pm-shortcode').value = editing?.shortCode || '';
  $('#pm-save').dataset.editingId = editing?.id || '';
  if (!editing) updatePendingShortCode();
  openModal('modal-product');
  setTimeout(() => $('#pm-name').focus(), 50);
}

async function updatePendingShortCode() {
  const id = $('#pm-save').dataset.editingId;
  if (id) return; // don't change code on edit
  const cat = $('#pm-category').value || 'GN';
  const code = await db.nextShortCode(cat);
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
      p.updatedAt = nowISO();
      // preserve stockQty — changes go through GRN/adjust
      // but allow direct change if it differs from current
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
      const shortCode = await db.nextShortCode(category);
      const prod = {
        shortCode, name, category, unit,
        sellingPrice: price, stockQty: stock, reorderLevel: reorder, hsn,
        gstRate: 18, // for future use
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
    renderProducts();
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
  renderProducts();
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
  rows.forEach((r, i) => {
    // split by tab OR comma (prefer tab)
    const parts = r.includes('\t') ? r.split('\t') : r.split(',');
    const [name, cat, price, unit, stock, reorder] = parts.map(s => (s || '').trim());
    const catCode = (cat || 'GN').toUpperCase();
    if (!name) { errors.push(`Row ${i+1}: missing name`); return; }
    if (!CAT_NAME[catCode]) { errors.push(`Row ${i+1}: unknown category "${cat}"`); return; }
    const priceNum = parseFloat(price);
    if (!(priceNum >= 0)) { errors.push(`Row ${i+1}: invalid price`); return; }
    parsed.push({
      name,
      category: catCode,
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
    const shortCode = await db.nextShortCode(row.category);
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
  renderProducts();
}

// ========== BILLING ==========
function wireBilling() {
  const input = $('#bill-search');
  const dd = $('#search-dropdown');

  input.addEventListener('input', () => {
    const q = input.value;
    runBillSearch(q);
  });

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

  $('#btn-clear-cart').addEventListener('click', () => {
    if (!state.cart.length) return;
    if (confirm('Clear cart?')) { state.cart = []; renderCart(); }
  });
  $('#btn-save-print').addEventListener('click', saveAndPrintBill);

  // Click outside dropdown closes it
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-dropdown') && e.target !== input) {
      dd.classList.add('hidden');
    }
  });
}

function runBillSearch(raw) {
  const dd = $('#search-dropdown');
  const q = (raw || '').trim();
  if (!q) { dd.classList.add('hidden'); state.searchResults = []; return; }
  // If it looks like a scanned QR JSON, don't show dropdown — Enter will handle
  if (q.startsWith('{')) { dd.classList.add('hidden'); return; }
  // N*CODE pattern — hide dropdown
  if (/^\d+\*/.test(q)) { dd.classList.add('hidden'); return; }
  // Exact shortCode pattern — hide
  if (/^[A-Z]{2}-\d{4}$/i.test(q)) { dd.classList.add('hidden'); return; }

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
        <div class="text-xs text-gray-500 mono">${escapeHTML(p.shortCode)} · ${escapeHTML(CAT_NAME[p.category] || '')}</div>
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

  // 1) Scanned QR payload — JSON or pipe-delimited
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

  // 2) N*CODE  (e.g. "5*HT-0042"  or  "5*HT-0042|Name|₹100")
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

  // 3) Direct shortCode
  if (/^[A-Z]{2}-\d{4}$/i.test(raw)) {
    const p = state.products.find(x => x.shortCode.toUpperCase() === raw.toUpperCase());
    if (p) {
      addToCart(p, 1);
      toast(`Added: ${p.name} — ${fmtMoney(p.sellingPrice)}`, 'success');
      input.value = ''; return;
    }
    toast('Code not found: ' + raw, 'error');
    return;
  }

  // 4) Active search result
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
  toast(`Added from QR (not in DB): ${j.code}`, '');
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
}

function renderCart() {
  const body = $('#cart-body');
  if (!state.cart.length) {
    body.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-gray-400">Cart is empty — scan or search to add items</td></tr>`;
    $('#cart-count').textContent = '0';
    $('#cart-qty').textContent = '0';
    $('#cart-total').textContent = fmtMoney(0);
    return;
  }
  body.innerHTML = state.cart.map((l, i) => `
    <tr data-row="${i}">
      <td>${escapeHTML(l.name)}${l.ephemeral ? ' <span class="text-xs text-yellow-700">(from QR)</span>' : ''}</td>
      <td class="mono text-sm">${escapeHTML(l.shortCode)}</td>
      <td><input type="number" min="1" step="1" value="${l.qty}" data-qty="${i}" class="w-20 p-1 border rounded" /></td>
      <td class="text-right"><input type="number" min="0" step="0.01" value="${l.price}" data-price="${i}" class="w-24 p-1 border rounded text-right" title="Bill-only price (DB master price is unchanged)" /></td>
      <td class="text-right font-semibold" data-line-total="${i}">${fmtMoney(l.price * l.qty)}</td>
      <td><button class="text-red-600 hover:underline text-sm" data-rm="${i}">Remove</button></td>
    </tr>
  `).join('');

  // Shared in-place update helper so both qty and price edits update the
  // line total + grand total without destroying the input (which would
  // kick the cursor out mid-typing).
  const updateLine = (i) => {
    const cell = body.querySelector(`[data-line-total="${i}"]`);
    if (cell) cell.textContent = fmtMoney(state.cart[i].qty * state.cart[i].price);
    updateCartTotals();
  };

  // Qty input
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

  // Price input — editable per-line for bargaining. Does NOT write back
  // to the Products DB; only affects this bill.
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
    state.cart.splice(+el.dataset.rm, 1); renderCart();
  }));

  updateCartTotals();
}

function updateCartTotals() {
  const totalQty = state.cart.reduce((s, l) => s + l.qty, 0);
  const total = state.cart.reduce((s, l) => s + l.qty * l.price, 0);
  $('#cart-count').textContent = state.cart.length;
  $('#cart-qty').textContent = totalQty;
  $('#cart-total').textContent = fmtMoney(total);
}

async function saveAndPrintBill() {
  if (!state.cart.length) return toast('Cart is empty', 'error');

  const s = state.settings;
  const invoiceNo = `${s.invoicePrefix}${String(s.nextInvoiceNo).padStart(4, '0')}`;
  const total = state.cart.reduce((sum, l) => sum + l.qty * l.price, 0);
  const customerName = $('#customer-name').value.trim();
  const amountPaidRaw = $('#amount-paid').value.trim();
  const amountPaid = amountPaidRaw === '' ? null : parseFloat(amountPaidRaw);
  const notes = $('#bill-notes').value.trim();

  const invoice = {
    invoiceNo,
    date: nowISO(),
    customerName: customerName || null,
    items: state.cart.map(l => ({ ...l })),
    subtotal: total,
    total,
    amountPaid,         // recorded silently
    notes: notes || '',
    printedAt: nowISO(),
  };

  try {
    const id = await db.add('invoices', invoice);
    invoice.id = id;

    // Deduct stock + log movements (only for DB products)
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

    // Bump invoice number
    state.settings.nextInvoiceNo = (s.nextInvoiceNo || 1) + 1;
    await db.setSetting('nextInvoiceNo', state.settings.nextInvoiceNo);

    await refreshProducts();

    // Render + print
    renderBillToPrintArea(invoice);
    window.print();

    // Reset form
    state.cart = [];
    $('#customer-name').value = '';
    $('#amount-paid').value = '';
    $('#bill-notes').value = '';
    renderCart();
    toast('Bill ' + invoiceNo + ' saved', 'success');
    $('#bill-search').focus();
  } catch (e) {
    console.error(e);
    toast('Save failed: ' + e.message, 'error');
  }
}

function renderBillToPrintArea(invoice) {
  const s = state.settings;
  const d = new Date(invoice.date);
  const dateStr = d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  const itemsHTML = invoice.items.map(l => `
    <tr>
      <td>
        ${escapeHTML(l.name)}
        <div style="font-size:9px;color:#555">${escapeHTML(l.shortCode)}</div>
      </td>
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
        ${dateStr}${invoice.customerName ? '<br/>Cust: ' + escapeHTML(invoice.customerName) : ''}
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

// Build printable HTML with barcodes + QR baked in as PNG data URLs.
// Canvas-in-DOM doesn't survive well during @media print, but <img> with
// data: URLs does. The PDF path uses the same approach and works reliably.
async function renderLabelsToPrintArea(ids) {
  const items = ids.map(id => state.products.find(p => p.id === id)).filter(Boolean);
  const blocks = await Promise.all(items.map(async (p) => {
    // Barcode via JsBarcode on offscreen canvas, then toDataURL
    let bcImg = '';
    try {
      const c = document.createElement('canvas');
      JsBarcode(c, p.shortCode, { format: 'CODE128', displayValue: false, margin: 0, height: 50, width: 2 });
      bcImg = c.toDataURL('image/png');
    } catch {}
    // QR via QRCode.toDataURL (async, returns Promise)
    let qrImg = '';
    try {
      qrImg = await QRCode.toDataURL(
        makeQRPayload(p),
        { width: 220, margin: 1 }
      );
    } catch {}
    return `
      <div class="label-card">
        <div class="name">${escapeHTML(p.name)}</div>
        <div class="codes">
          ${bcImg ? `<img src="${bcImg}" alt="barcode" style="height:44px;width:auto;"/>` : ''}
          ${qrImg ? `<img src="${qrImg}" alt="qr" style="height:72px;width:72px;"/>` : ''}
        </div>
        <div class="shortcode">${escapeHTML(p.shortCode)}</div>
      </div>
    `;
  }));
  $('#print-area').innerHTML = `<div class="print-labels">${blocks.join('')}</div>`;
}

function labelsList() {
  const q = $('#labels-search').value.trim().toLowerCase();
  const cat = $('#labels-category').value;
  return state.products.filter(p => {
    if (cat && p.category !== cat) return false;
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
      </div>
    `;
  }).join('');

  // Render codes
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

  // Clicks
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
  // Give the browser a beat to paint the images, then print
  setTimeout(() => window.print(), 80);
}

async function downloadLabelsPDF(ids) {
  ids = ids || Array.from(state.selectedLabels);
  if (!ids.length) return toast('Select labels first', 'error');
  const items = ids.map(id => state.products.find(p => p.id === id)).filter(Boolean);
  if (!items.length) return;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  // 3 cols x 10 rows, 210mm wide, each cell ~63mm, margin 5mm
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

    // Name (clip)
    const name = p.name || '';
    doc.setFontSize(8);
    const lines = doc.splitTextToSize(name, cellW - 4);
    doc.text(lines.slice(0, 2).join('\n'), x + cellW / 2, y + 4, { align: 'center' });

    // Generate barcode as image
    try {
      const bcCanvas = document.createElement('canvas');
      JsBarcode(bcCanvas, p.shortCode, { format: 'CODE128', displayValue: false, margin: 0, height: 40, width: 1.5 });
      const bcData = bcCanvas.toDataURL('image/png');
      doc.addImage(bcData, 'PNG', x + 2, y + 9, cellW * 0.55 - 4, cellH - 18);
    } catch {}

    // QR
    try {
      const qrData = await QRCode.toDataURL(makeQRPayload(p), { width: 200, margin: 0 });
      const qrSize = Math.min(cellW * 0.45 - 4, cellH - 18);
      doc.addImage(qrData, 'PNG', x + cellW * 0.55, y + 9, qrSize, qrSize);
    } catch {}

    // Shortcode text
    doc.setFontSize(9);
    doc.text(p.shortCode, x + cellW / 2, y + cellH - 2, { align: 'center' });
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
    renderInventory();
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
    // direct code?
    if (/^[A-Z]{2}-\d{4}$/i.test(q)) {
      const p = state.products.find(x => x.shortCode.toUpperCase() === q.toUpperCase());
      if (p) { onPick(p); dd.classList.add('hidden'); return; }
    }
    const matches = state.products
      .filter(p => (p.name || '').toLowerCase().includes(q) || (p.shortCode || '').toLowerCase().includes(q))
      .slice(0, 8);
    if (!matches.length) { dd.classList.add('hidden'); return; }
    dd.innerHTML = matches.map((p, i) => `
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
      // Try direct code
      const q = input.value.trim();
      if (/^[A-Z]{2}-\d{4}$/i.test(q)) {
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
  renderInventory();
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
  renderInventory();
}

async function renderInventory() {
  const totalSKUs = state.products.length;
  const totalStock = state.products.reduce((s, p) => s + (p.stockQty || 0), 0);
  const low = state.products.filter(p => (p.stockQty || 0) <= (p.reorderLevel || 0));
  $('#inv-total-skus').textContent = fmtInt(totalSKUs);
  $('#inv-total-stock').textContent = fmtInt(totalStock);
  $('#inv-low-count').textContent = fmtInt(low.length);

  const list = state.showLowOnly ? low : state.products;
  const body = $('#inventory-body');
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-gray-400">${state.showLowOnly ? 'No low-stock items' : 'No products yet'}</td></tr>`;
  } else {
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

  // Recent movements (last 30)
  const movs = await db.all('stockMovements');
  movs.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const recent = movs.slice(0, 30);
  const mBody = $('#movements-body');
  if (!recent.length) {
    mBody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-gray-400">No movements yet</td></tr>`;
  } else {
    mBody.innerHTML = recent.map(m => {
      const p = state.products.find(x => x.id === m.productId);
      const d = new Date(m.date);
      return `<tr>
        <td class="text-xs">${d.toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td class="mono text-sm">${escapeHTML(p?.shortCode || '—')}</td>
        <td>${escapeHTML(p?.name || '(deleted)')}</td>
        <td>${escapeHTML(m.type)}</td>
        <td class="text-right ${m.qty < 0 ? 'text-red-600' : 'text-green-700'}">${m.qty > 0 ? '+' : ''}${m.qty}</td>
        <td class="text-sm">${escapeHTML(m.reason || '')}</td>
      </tr>`;
    }).join('');
  }
}

// ========== REPORTS ==========
function wireReports() {
  $('#btn-rep-filter').addEventListener('click', renderReports);
  $('#btn-rep-today').addEventListener('click', () => {
    $('#rep-date-from').value = todayISO();
    $('#rep-date-to').value = todayISO();
    renderReports();
  });
  $('#btn-rep-export').addEventListener('click', exportBillsCSV);
}

async function renderReports() {
  const invoices = await db.all('invoices');
  invoices.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const today = todayISO();
  const monthPrefix = today.slice(0, 7);

  const todayInv = invoices.filter(i => (i.date || '').slice(0, 10) === today);
  const monthInv = invoices.filter(i => (i.date || '').slice(0, 7) === monthPrefix);

  $('#rep-today-sales').textContent = fmtMoney(todayInv.reduce((s, i) => s + (i.total || 0), 0));
  $('#rep-today-bills').textContent = `${todayInv.length} bills`;
  $('#rep-month-sales').textContent = fmtMoney(monthInv.reduce((s, i) => s + (i.total || 0), 0));
  $('#rep-month-bills').textContent = `${monthInv.length} bills`;
  $('#rep-alltime-sales').textContent = fmtMoney(invoices.reduce((s, i) => s + (i.total || 0), 0));
  $('#rep-alltime-bills').textContent = `${invoices.length} bills`;

  // filtered bills
  const from = $('#rep-date-from').value;
  const to = $('#rep-date-to').value;
  let filtered = invoices;
  if (from) filtered = filtered.filter(i => (i.date || '').slice(0, 10) >= from);
  if (to) filtered = filtered.filter(i => (i.date || '').slice(0, 10) <= to);

  const body = $('#bills-body');
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-gray-400">No bills in range</td></tr>`;
  } else {
    body.innerHTML = filtered.slice(0, 200).map(i => {
      const d = new Date(i.date);
      const itemCount = (i.items || []).reduce((s, l) => s + l.qty, 0);
      return `<tr>
        <td class="mono">${escapeHTML(i.invoiceNo)}</td>
        <td class="text-xs">${d.toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td>${escapeHTML(i.customerName || '')}</td>
        <td class="text-right">${itemCount}</td>
        <td class="text-right font-semibold">${fmtMoney(i.total)}</td>
        <td class="text-right">${i.amountPaid != null ? fmtMoney(i.amountPaid) : '—'}</td>
        <td><button class="text-blue-600 hover:underline text-sm" data-reprint="${i.id}">Reprint</button></td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-reprint]').forEach(b => b.addEventListener('click', () => reprintInvoice(+b.dataset.reprint)));
  }

  // Top items
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

  const rows = [['Invoice', 'Date', 'Customer', 'ItemCode', 'ItemName', 'Qty', 'Price', 'LineTotal', 'InvoiceTotal', 'AmountPaid', 'Notes']];
  for (const inv of list) {
    const date = (inv.date || '').slice(0, 10);
    for (const l of inv.items || []) {
      rows.push([inv.invoiceNo, date, inv.customerName || '', l.shortCode || '', l.name, l.qty, l.price, l.qty * l.price, inv.total, inv.amountPaid ?? '', inv.notes || '']);
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
  for (const [k, v] of Object.entries(s)) await db.setSetting(k, v);
  toast('Settings saved', 'success');
}

async function exportBackup() {
  const data = await db.exportAll();
  const json = JSON.stringify(data, null, 2);
  downloadBlob(new Blob([json], { type: 'application/json' }), `toolbill-backup-${todayISO()}.json`);
  toast('Backup downloaded', 'success');
}

async function importBackup(e) {
  const f = e.target.files[0];
  if (!f) return;
  if (!confirm('This replaces ALL current data (products, invoices, stock, settings). Continue?')) {
    e.target.value = ''; return;
  }
  const text = await f.text();
  try {
    const data = JSON.parse(text);
    await db.importAll(data);
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      state.settings[k] = await db.getSetting(k, v);
    }
    await refreshProducts();
    applySettingsToForm();
    renderProducts(); renderInventory(); renderReports();
    toast('Backup restored', 'success');
  } catch (err) {
    console.error(err); toast('Import failed: ' + err.message, 'error');
  } finally {
    e.target.value = '';
  }
}

async function resetAllData() {
  if (!confirm('ERASE all products, bills, stock, and settings?\nThis cannot be undone. Export a backup first.')) return;
  if (!confirm('Last chance. Really erase everything?')) return;
  await db.wipe();
  state.settings = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await db.setSetting(k, v);
  await refreshProducts();
  applySettingsToForm();
  renderProducts(); renderInventory(); renderReports();
  toast('All data erased', 'success');
}

// ========== Boot ==========
document.addEventListener('DOMContentLoaded', init);
