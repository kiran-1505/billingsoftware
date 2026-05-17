// modules/billing.js — sell pane, cart, customer autocomplete, drafts, save & print
import { db } from '../db.js';
import {
  state, $, $$, fmtMoney, fmtInt, nowISO, escapeHTML, toast,
  openModal, closeModal, canonicalCategory, debounce, amountInWords,
  parseScannedPayload, refreshProducts, refreshDrafts,
  registerTabRenderer, decodeCostCode, encodeCostCode,
} from './core.js';

// ---- Customer autocomplete ----
let _customerList = [];

export async function buildCustomerList() {
  const [customers, invoices] = await Promise.all([db.all('customers'), db.all('invoices')]);
  const seen = new Map();
  for (const c of customers) {
    const key = (c.phone || c.gst || c.name || '').toLowerCase();
    if (key) seen.set(key, {
      name: c.name || '', phone: c.phone || '', gst: c.gst || '',
      stateCode: c.stateCode || (c.gst ? c.gst.slice(0, 2) : ''),
      type: c.type || 'walkin',
    });
  }
  for (const inv of [...invoices].sort((a, b) => (b.date || '').localeCompare(a.date || ''))) {
    const name  = (inv.customerName  || '').trim();
    const phone = (inv.customerPhone || '').trim();
    const gst   = (inv.customerGst   || '').trim().toUpperCase();
    const stateCode = inv.customerStateCode || (gst ? gst.slice(0, 2) : '');
    if (!name && !phone && !gst) continue;
    const key = (phone || gst || name).toLowerCase();
    if (!seen.has(key)) seen.set(key, { name, phone, gst, stateCode, type: inv.customerType || (gst ? 'gst' : 'walkin') });
  }
  _customerList = Array.from(seen.values());
}

export async function upsertCustomer(name, phone, gst, type, stateCode) {
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
    if (stateCode) existing.stateCode = stateCode;
    existing.type = type || existing.type;
    existing.updatedAt = now;
    await db.put('customers', existing);
  } else {
    await db.add('customers', {
      name, phone, gst, stateCode: stateCode || null,
      type: type || 'walkin', createdAt: now, updatedAt: now,
    });
  }
}

// Detect GST customer from the GST field value:
// - any non-whitespace content → GST customer
// - 2 or more spaces → GST customer (quick marker when number not available)
export function isGstFromField() {
  const raw = $('#customer-gst').value;
  return raw.trim().length > 0 || (raw.match(/ /g) || []).length >= 2;
}

export function setCustomerType(type) {
  state.customerType = type;
  // Visual cue on GST field border
  const el = $('#customer-gst');
  if (!el) return;
  const isGst = type === 'gst';
  el.classList.toggle('border-green-500', isGst);
  el.classList.toggle('bg-green-50', isGst);
  el.classList.toggle('border-gray-200', !isGst);
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
  $('#customer-gst').value   = c.gst   || '';
  if ($('#customer-state')) {
    $('#customer-state').value = c.stateCode || (c.gst ? c.gst.slice(0, 2) : '');
  }
  // Update type from field
  const type = c.gst ? 'gst' : (c.type || 'walkin');
  setCustomerType(type);
  state.customerType = type;
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
  // Show "Code" column to anyone except the accounts (user1) role
  const showCostCol = state.currentUser !== 'user1';
  document.querySelectorAll('.cart-cost-col').forEach(el => el.classList.toggle('hidden', !showCostCol));

  if (!state.cart.length) {
    body.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-gray-400">Cart is empty — scan or search to add items</td></tr>`;
    $('#cart-count').textContent = '0';
    $('#cart-qty').textContent   = '0';
    $('#cart-total').textContent = fmtMoney(0);
    _updateCartTotals();
    return;
  }
  body.innerHTML = state.cart.map((l, i) => {
    let codeCell = '';
    if (showCostCol) {
      const prod = l.productId ? state.products.find(p => p.id === l.productId) : null;
      const cost = prod?.costCode ? decodeCostCode(prod.costCode) : null;
      codeCell = `<td class="cart-cost-col mono text-purple-700 text-xs" style="width:80px;padding-left:4px;padding-right:4px" title="${cost != null ? `Cost ₹${cost}` : ''}">${prod?.costCode ? escapeHTML(prod.costCode.toUpperCase()) : '—'}</td>`;
    } else {
      codeCell = `<td class="cart-cost-col hidden"></td>`;
    }
    return `
    <tr data-row="${i}">
      <td style="width:auto">${escapeHTML(l.name)}${l.ephemeral ? ' <span class="text-xs text-yellow-700">(from QR)</span>' : ''}</td>
      ${codeCell}
      <td style="width:72px;padding-left:4px;padding-right:4px"><input type="number" min="1" step="1" value="${l.qty}" data-qty="${i}" class="cart-input" /></td>
      <td style="width:150px;padding-left:4px;padding-right:4px"><input type="number" min="0" step="0.01" value="${l.price}" data-price="${i}" class="cart-input text-right" title="Edit price for this bill only" /></td>
      <td style="width:110px" class="text-right font-semibold" data-line-total="${i}">${fmtMoney(l.price * l.qty)}</td>
      <td style="width:32px" class="text-center"><button class="cart-rm-btn" data-rm="${i}" title="Remove"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button></td>
    </tr>`;
  }).join('');

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

  // Show encoded total cost (screen-only, never printed) — hidden from accounts user
  const costEl = $('#cart-cost-code');
  if (costEl && state.currentUser !== 'user1' && (state.settings.costCodeAlphabet || '').length === 10) {
    let totalCost = 0;
    let allHaveCost = true;
    for (const l of state.cart) {
      const prod = l.productId ? state.products.find(p => p.id === l.productId) : null;
      const cost = prod?.costCode ? decodeCostCode(prod.costCode) : null;
      if (cost != null) totalCost += cost * l.qty;
      else allHaveCost = false;
    }
    const encoded = encodeCostCode(totalCost);
    if (encoded && state.cart.length) {
      costEl.textContent = encoded.toUpperCase() + (allHaveCost ? '' : '*');
      costEl.title = allHaveCost
        ? 'Total cost (secret)'
        : 'Total cost — * means some items have no cost code';
      costEl.classList.remove('hidden');
    } else {
      costEl.classList.add('hidden');
    }
  } else if (costEl) {
    costEl.classList.add('hidden');
  }
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
    back.classList.add('hidden');
    if (q) {
      // Search mode: show matching products across all categories
      title.textContent = 'Search results';
      const cartQty = new Map(state.cart.filter(l => l.productId).map(l => [l.productId, l.qty]));
      const items = state.products.filter(p =>
        (p.name || '').toLowerCase().includes(q) || (p.shortCode || '').toLowerCase().includes(q)
      ).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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
            ${p.image
              ? `<img src="${escapeHTML(p.image)}" class="w-full h-16 object-cover rounded mb-1" />`
              : `<div class="w-full h-16 rounded mb-1 bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-xl">${escapeHTML((p.name || '??').slice(0, 2).toUpperCase())}</div>`}
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
    } else {
      // Category view
      title.textContent = 'Categories';
      const counts = _productCountsByCategory();
      const cats = state.categories.map(c => ({ ...c, count: counts[c.name] || 0 }));
      if (!cats.length) {
        body.innerHTML = `<div class="text-center py-10 text-gray-400 text-sm">No categories match</div>`;
        return;
      }
      body.innerHTML = `<div class="sell-tiles">` + cats.map(c => `
        <button class="sell-cat-tile" data-sell-cat="${escapeHTML(c.name)}">
          ${c.image
            ? `<img src="${escapeHTML(c.image)}" class="w-full h-16 object-cover rounded mb-1" />`
            : `<div class="w-full h-16 rounded mb-1 bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-2xl">${escapeHTML(c.name.slice(0, 2).toUpperCase())}</div>`}
          <div class="sell-cat-tile-name">${escapeHTML(c.name)}</div>
          <div class="sell-cat-tile-meta">${fmtInt(c.count)} ${c.count === 1 ? 'item' : 'items'}</div>
        </button>
      `).join('') + `</div>`;
      body.querySelectorAll('[data-sell-cat]').forEach(b => b.addEventListener('click', () => {
        state.sellPickerCategory = b.dataset.sellCat;
        $('#sell-pane-search').value = '';
        renderSellPane();
      }));
    }
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
          ${p.image
            ? `<img src="${escapeHTML(p.image)}" class="w-full h-16 object-cover rounded mb-1" />`
            : `<div class="w-full h-16 rounded mb-1 bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-xl">${escapeHTML((p.name || '??').slice(0, 2).toUpperCase())}</div>`}
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
  const customerStateCode = $('#customer-state')?.value || '';
  const amountPaidRaw = $('#amount-paid').value.trim();
  const amountPaid    = amountPaidRaw === '' ? null : parseFloat(amountPaidRaw);
  const notes = $('#bill-notes').value.trim();
  const payload = {
    date: nowISO(), items: state.cart.map(l => ({ ...l })),
    customerType: state.customerType,
    customerName: customerName || null, customerPhone: customerPhone || null,
    customerGst: customerGst || null, customerStateCode: customerStateCode || null,
    amountPaid, notes: notes || '',
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
  if ($('#customer-state')) $('#customer-state').value = d.customerStateCode || (d.customerGst ? d.customerGst.slice(0, 2) : '');
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
  const customerStateCode = $('#customer-state')?.value || '';
  const rawGst        = $('#customer-gst').value;
  const customerGst   = rawGst.trim().toUpperCase();
  const spaceCount    = (rawGst.match(/ /g) || []).length;
  const isGstCustomer = customerGst.length > 0 || spaceCount >= 2;
  const customerType  = isGstCustomer ? 'gst' : 'walkin';
  const amountPaidRaw = $('#amount-paid').value.trim();
  const amountPaid    = amountPaidRaw === '' ? null : parseFloat(amountPaidRaw);
  const notes         = $('#bill-notes').value.trim();
  const noGW          = $('#toggle-no-gw').checked || null;
  const gwOn          = $('#toggle-gw').checked;
  const guaranteeMonths = gwOn ? (parseInt($('#gw-guarantee').value) || null) : null;
  const warrantyMonths  = gwOn ? (parseInt($('#gw-warranty').value)  || null) : null;
  const invoice = {
    invoiceNo, date: nowISO(),
    customerType,
    customerName: customerName || null, customerPhone: customerPhone || null,
    customerGst: customerGst || null,
    customerStateCode: customerStateCode || null,
    items: state.cart.map(l => ({ ...l })),
    subtotal: total, total, amountPaid,
    noGW, guaranteeMonths, warrantyMonths,
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
    state.customerType = 'walkin';
    $('#customer-name').value  = '';
    $('#customer-phone').value = '';
    $('#customer-gst').value   = '';
    if ($('#customer-state')) $('#customer-state').value = '';
    $('#amount-paid').value    = '';
    $('#bill-notes').value     = '';
    $('#toggle-no-gw').checked = false;
    $('#toggle-gw').checked    = false;
    $('#gw-fields').classList.add('hidden');
    $('#gw-guarantee').value   = '';
    $('#gw-warranty').value    = '';
    renderCart();
    renderDrafts();
    renderSellPane();
    if (customerName || customerPhone || customerGst) {
      await upsertCustomer(customerName, customerPhone, customerGst, customerType, customerStateCode);
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

// ---- State code → name (first 2 digits of GSTIN) ----
const STATE_NAMES = {
  '01':'Jammu and Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh',
  '05':'Uttarakhand','06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh',
  '10':'Bihar','11':'Sikkim','12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur',
  '15':'Mizoram','16':'Tripura','17':'Meghalaya','18':'Assam','19':'West Bengal',
  '20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh','24':'Gujarat',
  '27':'Maharashtra','29':'Karnataka','30':'Goa','32':'Kerala','33':'Tamil Nadu',
  '34':'Puducherry','36':'Telangana','37':'Andhra Pradesh','38':'Ladakh',
};
function _stateFromGstin(gstin) {
  if (!gstin || gstin.length < 2) return { code: '', name: '' };
  const code = gstin.slice(0, 2);
  return { code, name: STATE_NAMES[code] || '' };
}

export function renderBillToPrintArea(invoice) {
  const s = state.settings;
  // Bordered Tally-style invoice for every bill — GST rows render only when present
  _renderGSTInvoice(invoice, s);
}

function _renderGSTInvoice(invoice, s) {
  const d = new Date(invoice.date);
  const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-');

  const sellerState  = _stateFromGstin(s.gstin);
  // Use the manually-selected state if present, otherwise derive from buyer GSTIN
  let buyerState = invoice.customerStateCode
    ? { code: invoice.customerStateCode, name: STATE_NAMES[invoice.customerStateCode] || '' }
    : _stateFromGstin(invoice.customerGst);
  const isInterState = sellerState.code && buyerState.code && sellerState.code !== buyerState.code;

  // Per-line tax breakdown using each product's CGST + SGST (fall back to gstRate split)
  const lines = invoice.items.map((l, idx) => {
    const prod = l.productId ? state.products.find(p => p.id === l.productId) : null;
    let cRate = prod?.cgstRate;
    let sRate = prod?.sgstRate;
    if (cRate == null && sRate == null) {
      const legacy = prod?.gstRate ?? 18;
      cRate = legacy / 2;
      sRate = legacy / 2;
    } else {
      cRate = cRate ?? 0;
      sRate = sRate ?? 0;
    }
    const gstRate  = cRate + sRate;
    const hsn      = prod?.hsn || '';
    const unit     = l.unit || prod?.unit || 'No';
    const rateIncl = l.price;
    const rateBase = rateIncl / (1 + gstRate / 100);
    const amount   = rateBase * l.qty;
    return { idx: idx + 1, name: l.name, hsn, qty: l.qty, unit, rateIncl, rateBase, amount, cRate, sRate, gstRate };
  });

  let cgst = 0, sgst = 0, igst = 0;
  for (const l of lines) {
    const cTax = l.amount * l.cRate / 100;
    const sTax = l.amount * l.sRate / 100;
    if (isInterState) igst += cTax + sTax; // IGST = CGST + SGST sum
    else { cgst += cTax; sgst += sTax; }
  }
  const subtotal    = lines.reduce((a, l) => a + l.amount, 0);
  const beforeRound = subtotal + cgst + sgst + igst;
  const finalTotal  = Math.round(beforeRound);
  const roundOff    = finalTotal - beforeRound; // positive = added, negative = less
  const totalQty    = lines.reduce((a, l) => a + l.qty, 0);
  const unitGuess   = lines[0]?.unit || 'No';
  const initials    = (s.shopName || 'S').split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase();

  const itemsHTML = lines.map(l => `
    <tr>
      <td class="c">${l.idx}</td>
      <td>${escapeHTML(l.name)}</td>
      <td class="c">${escapeHTML(l.hsn || '')}</td>
      <td class="r">${l.qty} ${escapeHTML(l.unit)}</td>
      <td class="r">${l.rateIncl.toFixed(2)}</td>
      <td class="r">${l.rateBase.toFixed(2)}</td>
      <td class="c">${escapeHTML(l.unit)}</td>
      <td class="r">${l.amount.toFixed(2)}</td>
    </tr>`).join('');

  // Spacer rows so the items block fills the page nicely
  const spacerCount = Math.max(0, 6 - lines.length);
  const spacerRows  = Array.from({ length: spacerCount })
    .map(() => '<tr class="spacer"><td colspan="8">&nbsp;</td></tr>').join('');

  $('#print-area').innerHTML = `
    <div class="print-gst-invoice">
      <div class="gst-top">
        <div>Tax Invoice</div>
        <div class="italic">(ORIGINAL FOR RECIPIENT)</div>
        <div>&nbsp;</div>
      </div>

      <table class="gst-grid">
        <tr>
          <td class="seller">
            <div class="seller-flex">
              <div class="seller-logo">${escapeHTML(initials)}</div>
              <div class="seller-info">
                <strong>${escapeHTML(s.shopName || 'Shop')}</strong><br/>
                ${s.address ? escapeHTML(s.address) + '<br/>' : ''}
                ${s.phone ? 'Contact ' + escapeHTML(s.phone) + '<br/>' : ''}
                ${s.gstin ? 'GSTIN/UIN: ' + escapeHTML(s.gstin) + '<br/>' : ''}
                ${sellerState.name ? 'State Name: ' + sellerState.name + ', Code: ' + sellerState.code : ''}
              </div>
            </div>
          </td>
          <td class="meta-cell"><small>Invoice No.</small><br/><strong>${escapeHTML(invoice.invoiceNo)}</strong></td>
          <td class="meta-cell"><small>Dated</small><br/><strong>${dateStr}</strong></td>
        </tr>
        <tr>
          <td colspan="3" class="buyer">
            <strong>Buyer (Bill to)</strong><br/>
            ${invoice.customerName ? '<strong>' + escapeHTML(invoice.customerName) + '</strong><br/>' : ''}
            ${invoice.customerGst ? 'GSTIN/UIN: ' + escapeHTML(invoice.customerGst) + '<br/>' : ''}
            ${buyerState.name ? 'State Name: ' + buyerState.name + ', Code: ' + buyerState.code + '<br/>' : ''}
            ${invoice.customerPhone ? 'Contact: ' + escapeHTML(invoice.customerPhone) : ''}
          </td>
        </tr>
      </table>

      <table class="gst-items">
        <thead>
          <tr>
            <th>Sl<br/>No.</th>
            <th>Description of Goods</th>
            <th>HSN/SAC</th>
            <th>Quantity</th>
            <th>Rate<br/>(Incl. of Tax)</th>
            <th>Rate</th>
            <th>per</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHTML}
          ${spacerRows}
          <tr><td colspan="7" class="r"><em>Output ${isInterState ? 'IGST' : 'CGST'}</em></td><td class="r">${(isInterState ? igst : cgst).toFixed(2)}</td></tr>
          ${!isInterState ? `<tr><td colspan="7" class="r"><em>Output SGST</em></td><td class="r">${sgst.toFixed(2)}</td></tr>` : ''}
          ${Math.abs(roundOff) > 0.001 ? `
            <tr><td colspan="7" class="r"><em>${roundOff > 0 ? 'Add:' : 'Less:'} Round Off</em></td><td class="r">${roundOff < 0 ? '(-)' : ''}${Math.abs(roundOff).toFixed(2)}</td></tr>` : ''}
          <tr class="totals">
            <td colspan="3" class="r"><strong>Total</strong></td>
            <td class="r"><strong>${totalQty} ${escapeHTML(unitGuess)}</strong></td>
            <td colspan="3"></td>
            <td class="r"><strong>₹ ${finalTotal.toLocaleString('en-IN')}.00</strong></td>
          </tr>
          ${invoice.amountPaid != null ? `
            <tr><td colspan="7" class="r"><em>Amount Paid</em></td><td class="r">₹ ${Number(invoice.amountPaid).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td></tr>
          ` : ''}
        </tbody>
      </table>

      <div class="gst-eoe">E. &amp; O.E</div>

      <div class="gst-amount-words">
        <strong>Amount Chargeable (in words):</strong>
        ${amountInWords(finalTotal)}
      </div>

      ${invoice.noGW ? '<div class="gst-gw-box no-gw">NO GUARANTEE &nbsp; NO WARRANTY</div>' : ''}
      ${(invoice.guaranteeMonths || invoice.warrantyMonths) ? `
        <div class="gst-gw-box has-gw">
          ${invoice.guaranteeMonths ? `<div>GUARANTEE: ${invoice.guaranteeMonths} MONTH${invoice.guaranteeMonths > 1 ? 'S' : ''}</div>` : ''}
          ${invoice.warrantyMonths ? `<div>WARRANTY: ${invoice.warrantyMonths} MONTH${invoice.warrantyMonths > 1 ? 'S' : ''}</div>` : ''}
        </div>` : ''}

      <table class="gst-footer">
        <tr>
          <td class="declaration">
            Item once sold will not be taken back or exchanged.
          </td>
          <td class="signatory">
            for <strong>${escapeHTML(s.shopName || '')}</strong><br/><br/><br/>
            <em>Authorised Signatory</em>
          </td>
        </tr>
      </table>

      <div class="gst-bottom">This is a Computer Generated Invoice</div>
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

  // Auto-detect GST customer from the GST field as user types
  $('#customer-gst').addEventListener('input', () => {
    const isGst = isGstFromField();
    setCustomerType(isGst ? 'gst' : 'walkin');
    state.customerType = isGst ? 'gst' : 'walkin';
    // Auto-suggest buyer state from GSTIN prefix (only if state not already chosen)
    const stateEl = $('#customer-state');
    if (stateEl && !stateEl.value) {
      const code = ($('#customer-gst').value || '').trim().slice(0, 2);
      if (code && stateEl.querySelector(`option[value="${code}"]`)) {
        stateEl.value = code;
      }
    }
  });
  // G&W toggle shows/hides duration fields
  $('#toggle-gw').addEventListener('change', () => {
    $('#gw-fields').classList.toggle('hidden', !$('#toggle-gw').checked);
  });
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
  document.addEventListener('toolbill:user-changed', () => { renderCart(); renderSellPane(); });

  registerTabRenderer('billing', () => {
    renderDrafts();
    renderSellPane();
    setTimeout(() => $('#sell-pane-search').focus(), 50);
  });
}

export function wireDrafts() {
  $('#btn-open-drafts').addEventListener('click', async () => {
    await refreshDrafts();
    renderDrafts();
    openModal('modal-drafts');
  });
}
