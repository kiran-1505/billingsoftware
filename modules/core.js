// modules/core.js — shared state, utilities, data refresh, tab routing
import { db } from '../db.js';

// ---- Constants ----
export const DEFAULT_CATEGORIES = [
  'Hand Tools', 'Power Tools', 'Fasteners', 'Lubricants',
  'Chemicals', 'Abrasives', 'Electrical', 'Auto Spares', 'General',
];

export const LEGACY_CAT_CODE = {
  HT: 'Hand Tools', PT: 'Power Tools', FS: 'Fasteners',
  LB: 'Lubricants', CH: 'Chemicals',   AB: 'Abrasives',
  EL: 'Electrical', AS: 'Auto Spares', GN: 'General',
};

export const DEFAULT_SETTINGS = {
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

// ---- State ----
export const state = {
  products: [],
  categories: [],
  drafts: [],
  activeDraftId: null,
  settings: { ...DEFAULT_SETTINGS },
  cart: [],
  searchResults: [],
  searchActive: -1,
  currentUser: null,
  selectedLabels: new Set(),
  showLowOnly: false,
  bulkPreview: null,
  grnTarget: null,
  adjTarget: null,
  currentProductsCategory: null,
  currentInvCategory: null,
  sellPickerCategory: null,
  dailySelectedDate: null,
  customerType: 'walkin',
  repCustFilter: 'all',
};

// ---- DOM helpers ----
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---- Formatters ----
export const fmtMoney = (n) => '₹' + (Number(n) || 0).toFixed(2);
export const fmtInt   = (n) => (Number(n) || 0).toLocaleString('en-IN');
export const todayISO = () => new Date().toISOString().slice(0, 10);
export const nowISO   = () => new Date().toISOString();

export function escapeHTML(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function canonicalCategory(raw) {
  if (!raw) return 'General';
  const s = String(raw).trim();
  return LEGACY_CAT_CODE[s.toUpperCase()] || s;
}

export function makeQRPayload(p) {
  const name = (p.name || '').replace(/[|\r\n]/g, ' ').trim();
  return `${p.shortCode}|${name}|₹${p.sellingPrice}`;
}

export function parseScannedPayload(raw) {
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

export function amountInWords(amount) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two   = n => n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
  const three = n => !n ? '' : n < 100 ? two(n) : ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + two(n % 100) : '');
  const rupees = Math.floor(Math.abs(amount));
  const paise  = Math.round((Math.abs(amount) - rupees) * 100);
  if (!rupees && !paise) return 'Zero Rupees Only';
  const crore    = Math.floor(rupees / 10000000);
  const lakh     = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const rem      = rupees % 1000;
  let w = '';
  if (crore)    w += three(crore)    + ' Crore ';
  if (lakh)     w += two(lakh)       + ' Lakh ';
  if (thousand) w += two(thousand)   + ' Thousand ';
  if (rem)      w += three(rem);
  w = w.trim();
  let result = w ? w + ' Rupees' : '';
  if (paise) result += (result ? ' and ' : '') + two(paise) + ' Paise';
  return result + ' Only';
}

export function debounce(fn, ms = 120) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function compressImage(file) {
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

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Toast ----
let toastTimer = null;
export function toast(msg, kind = '') {
  const el = $('#toast');
  el.className = 'show ' + kind;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', 2400);
}

// ---- Modals ----
export function openModal(id) {
  $('#' + id).classList.remove('hidden');
  document.body.classList.add('no-scroll');
}
export function closeModal(id) {
  $('#' + id).classList.add('hidden');
  document.body.classList.remove('no-scroll');
}
// Dispatches 'toolbill:modal-closed' so scanner.js can stop the camera without a circular import
export function closeAnyModal() {
  $$('.modal-backdrop').forEach(m => m.classList.add('hidden'));
  document.body.classList.remove('no-scroll');
  document.dispatchEvent(new CustomEvent('toolbill:modal-closed'));
}

export function wireModalClose() {
  $$('.modal-close').forEach(el => el.addEventListener('click', () => closeAnyModal()));
  $$('.modal-backdrop').forEach(m => m.addEventListener('click', (e) => {
    if (e.target === m) closeAnyModal();
  }));
}

export function wireDateInputs() {
  document.querySelectorAll('input[type="date"]').forEach(el => {
    el.addEventListener('input', () => {
      if (!el.value) return;
      const parts = el.value.split('-');
      if (parts[0] && parts[0].length > 4) {
        parts[0] = parts[0].slice(0, 4);
        el.value = parts.join('-');
      }
    });
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

// ---- Tab routing (registration pattern avoids circular imports) ----
const _tabRenderers = {};
export function registerTabRenderer(tab, fn) { _tabRenderers[tab] = fn; }

export function switchTab(name) {
  $$('.tab-btn').forEach(b => b.setAttribute('data-active', b.dataset.tab === name ? 'true' : 'false'));
  $$('.tab-content').forEach(s => s.setAttribute('data-active', s.id === 'tab-' + name ? 'true' : 'false'));
  if (_tabRenderers[name]) _tabRenderers[name]();
}

export function wireTabs() {
  $$('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#btn-home').addEventListener('click', () => {
    switchTab('billing');
    $('#bill-search').focus();
  });
}

// ---- Data refresh ----
export async function refreshCategories() {
  state.categories = await db.all('categories');
  state.categories.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export async function refreshProducts() {
  state.products = await db.all('products');
  state.products.sort((a, b) => (a.shortCode || '').localeCompare(b.shortCode || ''));
}

export async function refreshDrafts() {
  state.drafts = await db.all('drafts');
  state.drafts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

export async function migrateLegacyProductCategories() {
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

export function populateCategorySelects() {
  const optHTML = state.categories.map(c =>
    `<option value="${escapeHTML(c.name)}">${escapeHTML(c.name)}</option>`
  ).join('');
  const pmCat = $('#pm-category');
  if (pmCat) pmCat.innerHTML = optHTML || `<option value="General">General</option>`;
  const filterHTML = `<option value="">All</option>` + optHTML;
  const lbl = $('#labels-category');
  if (lbl) lbl.innerHTML = filterHTML;
}
