// modules/billing.js — sell pane, cart, customer autocomplete, drafts, save & print
import { db } from '../db.js';
import {
  state, $, $$, fmtMoney, fmtInt, nowISO, escapeHTML, toast,
  openModal, closeModal, canonicalCategory, debounce, amountInWords,
  parseScannedPayload, refreshProducts, refreshDrafts,
  registerTabRenderer,
} from './core.js';

// ---- Customer autocomplete ----
let _customerList = [];

export async function buildCustomerList() {
  const [customers, invoices] = await Promise.all([db.all('customers'), db.all('invoices')]);
  const seen = new Map();
  for (const c of customers) {
    const key = (c.phone || c.gst || c.name || '').toLowerCase();
    if (key) seen.set(key, { name: c.name || '', phone: c.phone || '', gst: c.gst || '', type: c.type || 'walkin' });
  }
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

export async function upsertCustomer(name, phone, gst, type) {
  if (!name && !phone && !gst) return;
  const customers = await db.all('customers');
  const existing = customers.find(c =>
    (phone && c.phone === phone) ||
    (gst   && c.gst   === gst)  ||
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

export function setCustomerType(type) {
  state.customerType = type;
  const isGst = type === 'gst';
  $('#btn-cust-walkin').className = `flex-1 py-2 font-semibold transition-colors ${!isGst ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`;
  $('#btn-cust-gst').className    = `flex-1 py-2 font-semibold transition-colors ${isGst  ? 'bg-green-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`;
  $('#gst-customer-row').classList.toggle('hidden', !isGst);
  if (isGst) setTimeout(() => $('#customer-gst').focus(), 50);
}

function wireCustomerAutocomplete() {
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
      if (e.key === 'Escape')    dd.classList.add('hidden');
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
  if (!q) { dd.classList.add('hidden'); return; }
  const matches = _customerList.filter(c => {
    if (fieldId === 'customer-name')  return (c.name  || '').toLowerCase().includes(q);
    if (fieldId === 'customer-phone') return (c.phone || '').toLowerCase().includes(q);
    if (fieldId === 'customer-gst')   return (c.gst   || '').toLowerCase().includes(q);
    return false;
  }).slice(0, 8);
  if (!matches.length) { dd.classList.add('hidden'); return; }

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
      if (e.key === 'Enter')     pick();
      if (e.key === 'Escape')    dd.classList.add('hidden');
      if (e.key === 'ArrowDown') { e.preventDefault(); el.nextElementSibling?.focus(); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); (el.previousElementSibling || inputEl).focus(); }
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

// ---- Bill search ----
export function runBillSearch(raw) {
  const dd = $('#search-dropdown');
  const q  = (raw || '').trim();
  if (!q || q.startsWith('{') || /^\d+\*/.test(q) || /^[A-Z]+-\d+$/i.test(q)) {
    dd.classList.add('hidden'); state.searchResults = []; return;
  }
  const ql = q.toLowerCase();
  const matches = state.products
    .filter(p => (p.name || '').toLowerCase().includes(ql) || (p.shortCode || '').toLowerCase().includes(ql))
    .slice(0, 10);
  state.searchResults = matches;
  state.searchActive  = matches.length ? 0 : -1;
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
      addToCart(state.searchResults[+el.dataset.idx], 1);
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

export function handleEnterInBillSearch() {
  const input = $('#bill-search');
  const raw   = input.value.trim();
  if (!raw) return;

  const parsed = parseScannedPayload(raw);
  if (parsed) {
    const p = state.products.find(x => x.shortCode.toUpperCase() === parsed.code.toUpperCase());
    if (p) {
      addToCart(p, 1);
      toast(`Added: ${p.name} — ${fmtMoney(p.sellingPrice)}`, 'success');
    } else {
      _addEphemeralFromQR({ code: parsed.code, name: parsed.name, price: parsed.price });
      toast(`Added from QR (not in DB): ${parsed.name} — ${fmtMoney(parsed.price)}`, '');
    }
    input.value = '';
    return;
  }

  const m = raw.match(/^(\d+)\s*\*\s*(.+)$/);
  if (m) {
    const qty  = parseInt(m[1], 10);
    const rest = m[2].trim();
    const pp   = parseScannedPayload(rest);
    const code = pp ? pp.code : rest;
    const p    = state.products.find(x => x.shortCode.toUpperCase() === code.toUpperCase());
    if (p) { addToCart(p, qty); toast(`Added ${qty} × ${p.name} — ${fmtMoney(p.sellingPrice * qty)}`, 'success'); input.value = ''; return; }
    toast('Code not found: ' + code, 'error');
    return;
  }

  if (/^[A-Z]+-\d+$/i.test(raw)) {
    const p = state.products.find(x => x.shortCode.toUpperCase() === raw.toUpperCase());
    if (p) { addToCart(p, 1); toast(`Added: ${p.name} — ${fmtMoney(p.sellingPrice)}`, 'success'); input.value = ''; return; }
    toast('Code not found: ' + raw, 'error');
    return;
  }

  if (state.searchActive >= 0 && state.searchResults[state.searchActive]) {
    addToCart(state.searchResults[state.searchActive], 1);
    toast(`Added: ${state.searchResults[state.searchActive].name}`, 'success');
    input.value = '';
    state.searchResults = [];
    $('#search-dropdown').classList.add('hidden');
    return;
  }
  toast('No match', 'error');
}

// ---- Cart ----
function _addEphemeralFromQR(j) {
  state.cart.push({
    productId: null, shortCode: j.code,
    name: j.name || '(Unknown)', price: Number(j.price) || 0,
    qty: 1, unit: 'piece', ephemeral: true,
  });
  renderCart();
}

export function addToCart(p, qty) {
  if (qty <= 0) return;
  const existing = state.cart.find(l => l.productId === p.id);
  if (existing) existing.qty += qty;
  else state.cart.push({ productId: p.id, shortCode: p.shortCode, name: p.name, price: p.sellingPrice, qty, unit: p.unit || 'piece' });
  renderCart();
  if (state.sellPickerCategory) renderSellPane();
}

export function renderCart() {
  const body = $('#cart-body');
  if (!state.cart.length) {
    body.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-gray-400">Cart is empty — scan or search to add items</td></tr>`;
    $('#cart-count').textContent = '0';
    $('#cart-qty').textContent   = '0';
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
    _updateCartTotals();
  };

  body.querySelectorAll('[data-qty]').forEach(el => {
    el.addEventListener('input', () => {
      const i = +el.dataset.qty;
      state.cart[i].qty = Math.max(1, parseInt(el.value.trim(), 10) || 1);
      updateLine(i);
    });
    el.addEventListener('blur', () => {
      const i = +el.dataset.qty;
      if (!(parseInt(el.value.trim(), 10) >= 1)) el.value = state.cart[i].qty;
    });
    el.addEventListener('focus', () => el.select());
  });

  body.querySelectorAll('[data-price]').forEach(el => {
    el.addEventListener('input', () => {
      const i = +el.dataset.price;
      state.cart[i].price = Math.max(0, parseFloat(el.value.trim()) || 0);
      updateLine(i);
    });
    el.addEventListener('blur', () => {
      const i = +el.dataset.price;
      if (!(parseFloat(el.value.trim()) >= 0)) el.value = state.cart[i].price;
    });
    el.addEventListener('focus', () => el.select());
  });

  body.querySelectorAll('[data-rm]').forEach(el => el.addEventListener('click', () => {
    state.cart.splice(+el.dataset.rm, 1);
    renderCart();
    if (state.sellPickerCategory) renderSellPane();
  }));

  _updateCartTotals();
}

function _updateCartTotals() {
  const totalQty = state.cart.reduce((s, l) => s + l.qty, 0);
  const total    = state.cart.reduce((s, l) => s + l.qty * l.price, 0);
  $('#cart-count').textContent = state.cart.length;
  $('#cart-qty').textContent   = totalQty;
  $('#cart-total').textContent = fmtMoney(total);
  const badge = $('#cart-count-badge');
  if (badge) badge.textContent = `${state.cart.length} ${state.cart.length === 1 ? 'item' : 'items'}`;
}

// ---- Sell pane ----
function _productCountsByCategory() {
  const counts = {};
  for (const c of state.categories) counts[c.name] = 0;
  for (const p of state.products) {
    const n = canonicalCategory(p.category);
    counts[n] = (counts[n] || 0) + 1;
  }
  return counts;
}

export function renderSellPane() {
  const title = $('#sell-pane-title');
  const body  = $('#sell-pane-body');
  const back  = $('#btn-sell-back');
  const q     = $('#sell-pane-search').value.trim().toLowerCase();

  if (!state.sellPickerCategory) {
    title.textContent = 'Categories';
    back.classList.add('hidden');
    $('#sell-pane-search').placeholder = 'Filter categories...';
    const counts = _productCountsByCategory();
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
      const inCart     = cartQty.get(p.id) || 0;
      const low        = (p.stockQty || 0) <= (p.reorderLevel || 0);
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
        </button>`;
    }).join('') + `</div>`;
    body.querySelectorAll('[data-sell-prod]').forEach(b => b.addEventListener('click', () => {
      const p = state.products.find(x => x.id === +b.dataset.sellProd);
      if (p) { addToCart(p, 1); renderSellPane(); }
    }));
  }
}

// ---- Drafts ----
export function detachActiveDraft() {
  state.activeDraftId = null;
  $('#active-draft-banner').classList.add('hidden');
  $('#active-draft-chip').classList.add('hidden');
  $('#active-draft-label').textContent = '';
  $('#active-draft-banner-label').textContent = '';
}

export function setActiveDraft(id, label) {
  state.activeDraftId = id;
  const txt = label || `#${id}`;
  $('#active-draft-banner').classList.remove('hidden');
  $('#active-draft-chip').classList.remove('hidden');
  $('#active-draft-label').textContent       = txt;
  $('#active-draft-banner-label').textContent = txt;
}

export async function saveDraftFromCart() {
  if (!state.cart.length) return toast('Cart is empty', 'error');
  const customerName  = $('#customer-name').value.trim();
  const customerPhone = $('#customer-phone').value.trim();
  const customerGst   = $('#customer-gst').value.trim().toUpperCase();
  const amountPaidRaw = $('#amount-paid').value.trim();
  const amountPaid    = amountPaidRaw === '' ? null : parseFloat(amountPaidRaw);
  const notes = $('#bill-notes').value.trim();
  const payload = {
    date: nowISO(), items: state.cart.map(l => ({ ...l })),
    customerType: state.customerType,
    customerName: customerName || null, customerPhone: customerPhone || null,
    customerGst: customerGst || null, amountPaid, notes: notes || '',
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

export function renderDrafts() {
  const box = $('#drafts-list');
  $('#drafts-count').textContent = String(state.drafts.length);
  if (!state.drafts.length) {
    if (box) box.innerHTML = `<div class="text-sm text-gray-400">No saved drafts</div>`;
    return;
  }
  box.innerHTML = state.drafts.map(d => {
    const when      = new Date(d.date || d.createdAt || Date.now());
    const itemCount = (d.items || []).length;
    const qty       = (d.items || []).reduce((s, l) => s + (l.qty || 0), 0);
    const total     = (d.items || []).reduce((s, l) => s + (l.qty * l.price || 0), 0);
    const isActive  = state.activeDraftId === d.id;
    return `
      <div class="flex flex-wrap items-center gap-2 p-2 border rounded ${isActive ? 'border-amber-400 bg-amber-50' : ''}">
        <div class="flex-1 min-w-[180px]">
          <div class="font-medium">${escapeHTML(d.customerName || 'Walk-in')} <span class="text-xs text-gray-500 mono">#${d.id}</span></div>
          <div class="text-xs text-gray-500">${when.toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })} · ${itemCount} items · qty ${qty}</div>
        </div>
        <div class="font-semibold">${fmtMoney(total)}</div>
        <button class="text-blue-600 hover:underline text-sm" data-draft-load="${d.id}">Load</button>
        <button class="text-red-600 hover:underline text-sm" data-draft-del="${d.id}">Delete</button>
      </div>`;
  }).join('');
  box.querySelectorAll('[data-draft-load]').forEach(b => b.addEventListener('click', () => _loadDraft(+b.dataset.draftLoad)));
  box.querySelectorAll('[data-draft-del]').forEach(b => b.addEventListener('click', () => _deleteDraft(+b.dataset.draftDel)));
}

async function _loadDraft(id) {
  const d = state.drafts.find(x => x.id === id);
  if (!d) return;
  if (state.cart.length && !confirm('Cart has items. Replace with this draft?')) return;
  state.cart = (d.items || []).map(l => ({ ...l }));
  setCustomerType(d.customerType || (d.customerGst ? 'gst' : 'walkin'));
  $('#customer-name').value  = d.customerName  || '';
  $('#customer-phone').value = d.customerPhone || '';
  $('#customer-gst').value   = d.customerGst   || '';
  $('#amount-paid').value    = d.amountPaid != null ? String(d.amountPaid) : '';
  $('#bill-notes').value     = d.notes || '';
  setActiveDraft(d.id, `#${d.id}`);
  renderCart();
  renderSellPane();
  closeModal('modal-drafts');
  toast(`Loaded draft #${id}`, '');
}

async function _deleteDraft(id) {
  if (!confirm(`Delete draft #${id}?`)) return;
  await db.del('drafts', id);
  if (state.activeDraftId === id) detachActiveDraft();
  await refreshDrafts();
  renderDrafts();
}

// ---- Save & Print ----
let _saving = false;
export async function saveAndPrintBill() {
  if (_saving) return;
  if (!state.cart.length) return toast('Cart is empty', 'error');
  _saving = true;
  const s = state.settings;
  const invoiceNo     = `${s.invoicePrefix}${String(s.nextInvoiceNo).padStart(4, '0')}`;
  const total         = state.cart.reduce((sum, l) => sum + l.qty * l.price, 0);
  const customerName  = $('#customer-name').value.trim();
  const customerPhone = $('#customer-phone').value.trim();
  const customerGst   = $('#customer-gst').value.trim().toUpperCase();
  const amountPaidRaw = $('#amount-paid').value.trim();
  const amountPaid    = amountPaidRaw === '' ? null : parseFloat(amountPaidRaw);
  const notes         = $('#bill-notes').value.trim();
  const invoice = {
    invoiceNo, date: nowISO(),
    customerType: state.customerType,
    customerName: customerName || null, customerPhone: customerPhone || null,
    customerGst: customerGst || null,
    items: state.cart.map(l => ({ ...l })),
    subtotal: total, total, amountPaid,
    notes: notes || '', printedAt: nowISO(),
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
    if (state.activeDraftId) { try { await db.del('drafts', state.activeDraftId); } catch {} }
    await refreshProducts();
    await refreshDrafts();
    renderBillToPrintArea(invoice);
    window.print();
    state.cart = [];
    detachActiveDraft();
    setCustomerType('walkin');
    $('#customer-name').value  = '';
    $('#customer-phone').value = '';
    $('#customer-gst').value   = '';
    $('#amount-paid').value    = '';
    $('#bill-notes').value     = '';
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

export function renderBillToPrintArea(invoice) {
  const s = state.settings;
  const d = new Date(invoice.date);
  const dateStr   = d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  const itemsHTML = invoice.items.map(l => `
    <tr>
      <td>${escapeHTML(l.name)}</td>
      <td style="text-align:right">${l.qty}</td>
      <td style="text-align:right">${fmtMoney(l.price)}</td>
      <td style="text-align:right">${fmtMoney(l.price * l.qty)}</td>
    </tr>`).join('');
  $('#print-area').innerHTML = `
    <div class="print-receipt">
      <h1>${escapeHTML(s.shopName || 'Shop')}</h1>
      ${s.address ? `<div class="meta">${escapeHTML(s.address)}</div>` : ''}
      ${s.phone   ? `<div class="meta">Ph: ${escapeHTML(s.phone)}</div>` : ''}
      ${s.gstin   ? `<div class="meta">GSTIN: ${escapeHTML(s.gstin)}</div>` : ''}
      <div class="meta" style="border-top:1px dashed #000;border-bottom:1px dashed #000;padding:2px 0;margin:4px 0">
        Bill: <b>${escapeHTML(invoice.invoiceNo)}</b><br/>
        ${dateStr}${invoice.customerName ? '<br/>Cust: ' + escapeHTML(invoice.customerName) : ''}${invoice.customerPhone ? '<br/>Ph: ' + escapeHTML(invoice.customerPhone) : ''}${invoice.customerGst ? '<br/>GSTIN: ' + escapeHTML(invoice.customerGst) : ''}
      </div>
      <table>
        <thead><tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amt</th></tr></thead>
        <tbody>${itemsHTML}</tbody>
      </table>
      <div class="totals">
        <div class="row"><span>Items</span><span>${invoice.items.length}</span></div>
        <div class="row"><span>Total qty</span><span>${invoice.items.reduce((x, l) => x + l.qty, 0)}</span></div>
        <div class="row" style="font-size:13px;font-weight:bold;margin-top:4px"><span>TOTAL</span><span>${fmtMoney(invoice.total)}</span></div>
        <div style="font-size:9px;font-style:italic;margin-top:3px;border-top:1px dashed #000;padding-top:3px">${amountInWords(invoice.total)}</div>
      </div>
      ${invoice.notes  ? `<div class="footer">Note: ${escapeHTML(invoice.notes)}</div>` : ''}
      ${s.footer ? `<div class="footer">${escapeHTML(s.footer)}</div>` : ''}
    </div>`;
}

// ---- Wire ----
export function wireBilling() {
  const input = $('#bill-search');
  const dd    = $('#search-dropdown');

  input.addEventListener('input',   () => runBillSearch(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')     { e.preventDefault(); handleEnterInBillSearch(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSearchActive(1); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveSearchActive(-1); }
    if (e.key === 'Escape')    { dd.classList.add('hidden'); state.searchResults = []; }
  });

  $('#btn-cust-walkin').addEventListener('click', () => setCustomerType('walkin'));
  $('#btn-cust-gst').addEventListener('click',   () => setCustomerType('gst'));
  $('#btn-clear-cart').addEventListener('click', () => {
    if (!state.cart.length) return;
    if (confirm('Clear cart?')) { state.cart = []; detachActiveDraft(); renderCart(); }
  });
  $('#btn-save-print').addEventListener('click', saveAndPrintBill);
  $('#btn-save-draft').addEventListener('click', saveDraftFromCart);
  $('#btn-active-draft-detach').addEventListener('click', () => {
    detachActiveDraft();
    toast('Detached — changes will become a new draft or bill', '');
  });
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

  wireCustomerAutocomplete();

  // Re-render sell pane when categories or products data changes
  document.addEventListener('toolbill:categories-changed', renderSellPane);
  document.addEventListener('toolbill:data-restored', () => { renderDrafts(); renderSellPane(); });

  registerTabRenderer('billing', () => {
    renderDrafts();
    renderSellPane();
    setTimeout(() => $('#bill-search').focus(), 50);
  });
}

export function wireDrafts() {
  $('#btn-open-drafts').addEventListener('click', async () => {
    await refreshDrafts();
    renderDrafts();
    openModal('modal-drafts');
  });
}
