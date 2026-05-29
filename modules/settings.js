// modules/settings.js — settings form, backup, restore, reset
import { db } from '../db.js';
import {
  state, $, DEFAULT_SETTINGS, DEFAULT_CATEGORIES, nowISO, todayISO, toast,
  refreshCategories, refreshProducts, refreshDrafts, migrateLegacyProductCategories,
  populateCategorySelects, downloadBlob, registerTabRenderer, openModal, closeModal,
  switchTab,
} from './core.js';
import { applyUserState } from './auth.js';
import { getActualTotal } from './reports.js';

export function applySettingsToForm() {
  const s = state.settings;
  $('#set-shop-name').value  = s.shopName || '';
  $('#set-address').value    = s.address  || '';
  $('#set-phone').value      = s.phone    || '';
  $('#set-gstin').value      = s.gstin    || '';
  $('#set-inv-prefix').value = s.invoicePrefix || '';
  $('#set-inv-next').value   = s.nextInvoiceNo || 1;
  $('#set-footer').value     = s.footer   || '';
  $('#set-user1-name').value = s.user1Name || 'accounts';
  $('#set-user1-pass').value = s.user1Pass || '';
  $('#set-user2-name').value = s.user2Name || 'admin';
  $('#set-user2-pass').value = s.user2Pass || '';
  if ($('#set-security-birthplace')) $('#set-security-birthplace').value = s.securityBirthplace || '';
  if ($('#set-security-question'))   $('#set-security-question').value   = s.securityQuestion   || '';
  if ($('#set-security-answer'))     $('#set-security-answer').value     = s.securityAnswer     || '';
  _updateCostCodeStatus();
}

async function _saveSecurityQuestions() {
  const s = state.settings;
  s.securityBirthplace = $('#set-security-birthplace').value.trim();
  s.securityQuestion   = $('#set-security-question').value.trim();
  s.securityAnswer     = $('#set-security-answer').value.trim();
  await db.setSetting('securityBirthplace', s.securityBirthplace);
  await db.setSetting('securityQuestion',   s.securityQuestion);
  await db.setSetting('securityAnswer',     s.securityAnswer);
  toast('Recovery questions saved', 'success');
}

function _updateCostCodeStatus() {
  const alpha = state.settings.costCodeAlphabet || '';
  const statusEl = $('#cost-code-status');
  if (statusEl) {
    statusEl.textContent = alpha.length === 10
      ? `Active: ${alpha.toUpperCase()}`
      : 'Not configured';
  }
}

function _openCostCodeModal() {
  const alpha = (state.settings.costCodeAlphabet || '          ').padEnd(10, ' ');
  for (let i = 0; i < 10; i++) {
    const inp = $(`#cc-digit-${i}`);
    if (inp) inp.value = alpha[i].trim();
  }
  $('#cc-error').classList.add('hidden');
  openModal('modal-cost-code');
  setTimeout(() => $('#cc-digit-0')?.focus(), 50);
}

async function _saveCostCode() {
  const letters = [];
  for (let i = 0; i < 10; i++) {
    const val = ($(`#cc-digit-${i}`)?.value || '').trim().toLowerCase();
    if (!val || !/^[a-z]$/.test(val)) {
      const errEl = $('#cc-error');
      errEl.textContent = `Digit ${i} must be a single letter (a–z).`;
      errEl.classList.remove('hidden');
      return;
    }
    letters.push(val);
  }
  // Check uniqueness
  if (new Set(letters).size < 10) {
    const errEl = $('#cc-error');
    errEl.textContent = 'All 10 letters must be unique.';
    errEl.classList.remove('hidden');
    return;
  }
  const alpha = letters.join('');
  state.settings.costCodeAlphabet = alpha;
  await db.setSetting('costCodeAlphabet', alpha);
  closeModal('modal-cost-code');
  _updateCostCodeStatus();
  toast('Cost code saved', 'success');
}

async function _saveSettings() {
  const s = state.settings;

  // Detect credential changes BEFORE applying — so we can confirm with the user
  const u1Name = $('#set-user1-name').value.trim();
  const u1Pass = $('#set-user1-pass').value;
  const u2Name = $('#set-user2-name').value.trim();
  const u2Pass = $('#set-user2-pass').value;
  // Detect any change in either username (including clearing it) or any password edit
  const userChanged =
    u1Name !== (s.user1Name || '') ||
    u2Name !== (s.user2Name || '') ||
    !!u1Pass ||
    !!u2Pass;

  if (userChanged) {
    const ok = confirm(
      'Are you sure you want to change the username and/or password?\n\n' +
      'You will be logged out and must log in again with the new credentials.'
    );
    if (!ok) return;
  }

  s.shopName      = $('#set-shop-name').value.trim() || 'Shop';
  s.address       = $('#set-address').value.trim();
  s.phone         = $('#set-phone').value.trim();
  s.gstin         = $('#set-gstin').value.trim();
  s.invoicePrefix = $('#set-inv-prefix').value.trim() || 'INV-';
  s.nextInvoiceNo = Math.max(1, parseInt($('#set-inv-next').value || '1', 10));
  s.footer        = $('#set-footer').value.trim();
  if (u1Name) s.user1Name = u1Name;
  if (u1Pass) s.user1Pass = u1Pass;
  if (u2Name) s.user2Name = u2Name;
  if (u2Pass) s.user2Pass = u2Pass;
  for (const [k, v] of Object.entries(s)) await db.setSetting(k, v);
  toast('Settings saved', 'success');

  if (userChanged) {
    // Clear password fields and log the user out
    $('#set-user1-pass').value = '';
    $('#set-user2-pass').value = '';
    state.currentUser = null;
    applyUserState();
    switchTab('billing');
    toast('Logged out — please log in with the new credentials', 'success');
  }
}

export async function exportBackup() {
  const data = await db.exportAll();
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `toolbill-backup-${todayISO()}.json`);
  toast('Backup downloaded', 'success');
}

async function _importBackup(e) {
  const f = e.target.files[0];
  if (!f) return;
  if (!confirm('This replaces ALL current data (products, invoices, stock, settings, categories, drafts). Continue?')) {
    e.target.value = ''; return;
  }
  try {
    const data = JSON.parse(await f.text());
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
    document.dispatchEvent(new CustomEvent('toolbill:data-restored'));
    toast('Backup restored', 'success');
  } catch (err) {
    console.error(err);
    toast('Import failed: ' + err.message, 'error');
  } finally {
    e.target.value = '';
  }
}

// ---- Sales Persons ----
function _sortedSalesPersons() {
  return (state.settings.salesPersons || []).slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export function renderSalesPersonsList() {
  const box = $('#sp-list');
  if (!box) return;
  const list = _sortedSalesPersons();
  if (!list.length) {
    box.innerHTML = `<div class="p-4 text-sm text-gray-400 text-center">No sales persons yet. Add one above.</div>`;
    return;
  }
  box.innerHTML = list.map(sp => {
    const active = sp.id === _spSummaryCurrentId;
    return `
      <div class="sp-row flex items-center gap-2 p-3 border-b cursor-pointer ${active ? 'bg-blue-50 border-l-4 border-l-blue-500' : 'hover:bg-gray-50'}" data-sp-view="${escapeAttr(sp.id)}">
        <div class="flex-1 text-sm font-medium ${active ? 'text-blue-800' : 'text-gray-800'}">${escapeAttr(sp.name)}</div>
        <button class="text-red-500 hover:text-red-700 text-xs px-1" data-sp-del="${escapeAttr(sp.id)}" title="Delete">✕</button>
      </div>
    `;
  }).join('');
  box.querySelectorAll('[data-sp-view]').forEach(b => b.addEventListener('click', (e) => {
    if (e.target.closest('[data-sp-del]')) return; // clicking × doesn't open
    _openSalesPersonSummary(b.dataset.spView);
  }));
  box.querySelectorAll('[data-sp-del]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    _deleteSalesPerson(b.dataset.spDel);
  }));
}

function escapeAttr(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

async function _addSalesPerson() {
  const name = ($('#sp-new-name').value || '').trim();
  if (!name) return toast('Enter a name', 'error');
  const list = state.settings.salesPersons || [];
  if (list.some(sp => sp.name.toLowerCase() === name.toLowerCase())) {
    return toast('Already exists', 'error');
  }
  const id = 'sp_' + Date.now().toString(36);
  list.push({ id, name, createdAt: nowISO() });
  state.settings.salesPersons = list;
  await db.setSetting('salesPersons', list);
  $('#sp-new-name').value = '';
  renderSalesPersonsList();
  document.dispatchEvent(new CustomEvent('toolbill:sales-persons-changed'));
  toast(`Added ${name}`, 'success');
}

async function _deleteSalesPerson(id) {
  const list = state.settings.salesPersons || [];
  const sp   = list.find(x => x.id === id);
  if (!sp) return;
  if (!confirm(`Delete ${sp.name}? Past bills still keep the name.`)) return;
  state.settings.salesPersons = list.filter(x => x.id !== id);
  await db.setSetting('salesPersons', state.settings.salesPersons);
  renderSalesPersonsList();
  document.dispatchEvent(new CustomEvent('toolbill:sales-persons-changed'));
  toast('Deleted', 'success');
}

function _todayISO() { return new Date().toISOString().slice(0, 10); }
function _firstOfMonthISO() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); }
function _lastOfMonthISO() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10); }

let _spSummaryCurrentId = null;
let _spSummaryCurrentName = '';

async function _openSalesPersonSummary(id) {
  const sp = (state.settings.salesPersons || []).find(x => x.id === id);
  if (!sp) return;
  _spSummaryCurrentId   = id;
  _spSummaryCurrentName = sp.name;
  $('#sp-summary-title').textContent = `Sales by ${sp.name}`;
  // Default to this month on first selection; keep existing range otherwise
  if (!$('#sp-from').value) $('#sp-from').value = _firstOfMonthISO();
  if (!$('#sp-to').value)   $('#sp-to').value   = _lastOfMonthISO();
  renderSalesPersonsList(); // re-render to highlight the active row
  await _renderSalesPersonSummary();
}

async function _renderSalesPersonSummary() {
  const stats = $('#sp-summary-stats');
  const bills = $('#sp-summary-bills');
  if (!stats || !bills) return;

  if (!_spSummaryCurrentId) {
    stats.innerHTML = '';
    bills.innerHTML = `<div class="p-4 text-center text-gray-400 text-sm">Select a sales person from the list</div>`;
    return;
  }

  const from = $('#sp-from').value;
  const to   = $('#sp-to').value;
  const invoices = await db.all('invoices');
  const list = invoices.filter(inv =>
    inv.salesPersonId === _spSummaryCurrentId &&
    (!from || (inv.date || '').slice(0, 10) >= from) &&
    (!to   || (inv.date || '').slice(0, 10) <= to)
  ).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Always use the ACTUAL (pre-scale-down) bill so worker commissions reflect
  // real revenue — never the filed/scaled values.
  const actualItems = (inv) => inv._gstOriginalItems || inv.items || [];
  const actualPaid  = (inv) => inv._gstOriginalAmountPaid ?? inv.amountPaid;
  const billCount = list.length;
  const totalAmt  = list.reduce((s, i) => s + getActualTotal(i), 0);
  const totalPaid = list.reduce((s, i) => {
    const p = actualPaid(i);
    return s + (p != null ? Number(p) : 0);
  }, 0);
  const itemCount = list.reduce((s, i) => s + actualItems(i).reduce((x, l) => x + (l.qty || 0), 0), 0);

  const fmt = (n) => '₹' + (Number(n) || 0).toFixed(2);
  stats.innerHTML = `
    <div class="bg-gray-50 border rounded p-3">
      <div class="text-[10px] text-gray-500 uppercase tracking-wide">Bills</div>
      <div class="text-xl font-bold">${billCount}</div>
    </div>
    <div class="bg-gray-50 border rounded p-3">
      <div class="text-[10px] text-gray-500 uppercase tracking-wide">Items sold</div>
      <div class="text-xl font-bold">${itemCount}</div>
    </div>
    <div class="bg-blue-50 border border-blue-200 rounded p-3">
      <div class="text-[10px] text-blue-700 uppercase tracking-wide">Total sales</div>
      <div class="text-xl font-bold text-blue-700">${fmt(totalAmt)}</div>
    </div>
    <div class="bg-green-50 border border-green-200 rounded p-3">
      <div class="text-[10px] text-green-700 uppercase tracking-wide">Amount paid</div>
      <div class="text-xl font-bold text-green-700">${fmt(totalPaid)}</div>
    </div>
  `;

  if (!list.length) {
    bills.innerHTML = `<div class="p-4 text-center text-gray-400 text-sm">No bills in this range</div>`;
    return;
  }
  bills.innerHTML = `
    <table class="w-full text-sm">
      <thead class="bg-gray-50 border-b text-xs uppercase text-gray-500 sticky top-0">
        <tr><th class="text-left p-2">Invoice</th><th class="text-left p-2">Date</th><th class="text-left p-2">Customer</th><th class="text-right p-2">Total</th></tr>
      </thead>
      <tbody>
        ${list.map(i => `
          <tr class="border-b hover:bg-gray-50">
            <td class="p-2 mono">${escapeAttr(i.invoiceNo)}</td>
            <td class="p-2 text-xs">${new Date(i.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })}</td>
            <td class="p-2 text-xs">${escapeAttr(i.customerName || '')}</td>
            <td class="p-2 text-right font-semibold">${fmt(getActualTotal(i))}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function _resetAllData() {
  if (!confirm('ERASE all products, bills, stock, categories, drafts and settings?\nThis cannot be undone. Export a backup first.')) return;
  if (!confirm('Last chance. Really erase everything?')) return;
  await db.wipe();
  state.settings = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await db.setSetting(k, v);
  for (const name of DEFAULT_CATEGORIES) {
    await db.add('categories', { name, createdAt: nowISO() });
  }
  await refreshCategories();
  await refreshProducts();
  await refreshDrafts();
  populateCategorySelects();
  applySettingsToForm();
  document.dispatchEvent(new CustomEvent('toolbill:data-restored'));
  toast('All data erased', 'success');
}

// ---- Wire ----
export function wireSettings() {
  $('#btn-save-settings').addEventListener('click', _saveSettings);
  $('#btn-save-users')?.addEventListener('click', _saveSettings);
  $('#btn-save-security')?.addEventListener('click', _saveSecurityQuestions);

  // Password reveal toggles — click the eye to flip type between password/text
  document.querySelectorAll('[data-toggle-pass]').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById(btn.dataset.togglePass);
      if (!inp) return;
      const isHidden = inp.type === 'password';
      inp.type = isHidden ? 'text' : 'password';
      btn.querySelector('.pass-eye-open')?.classList.toggle('hidden', isHidden);
      btn.querySelector('.pass-eye-shut')?.classList.toggle('hidden', !isHidden);
    });
  });

  $('#btn-export').addEventListener('click', exportBackup);
  $('#import-file').addEventListener('change', _importBackup);
  $('#btn-reset').addEventListener('click', _resetAllData);
  $('#btn-cost-code-setup').addEventListener('click', _openCostCodeModal);
  $('#btn-save-cost-code').addEventListener('click', _saveCostCode);

  // Auto-advance inputs in cost code modal
  for (let i = 0; i < 10; i++) {
    const inp = $(`#cc-digit-${i}`);
    if (inp) {
      inp.addEventListener('input', () => {
        inp.value = inp.value.slice(-1).toLowerCase(); // keep only last char
        if (inp.value && i < 9) $(`#cc-digit-${i + 1}`)?.focus();
      });
    }
  }

  // Sales persons
  $('#sp-add')?.addEventListener('click', _addSalesPerson);
  $('#sp-new-name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); _addSalesPerson(); } });
  $('#sp-from')?.addEventListener('change', _renderSalesPersonSummary);
  $('#sp-to')?.addEventListener('change', _renderSalesPersonSummary);
  $('#sp-quick-month')?.addEventListener('click', () => {
    $('#sp-from').value = _firstOfMonthISO();
    $('#sp-to').value   = _lastOfMonthISO();
    _renderSalesPersonSummary();
  });
  $('#sp-quick-today')?.addEventListener('click', () => {
    const t = _todayISO();
    $('#sp-from').value = t; $('#sp-to').value = t;
    _renderSalesPersonSummary();
  });

  registerTabRenderer('settings', applySettingsToForm);
  registerTabRenderer('sales-persons', () => {
    if ($('#sp-from') && !$('#sp-from').value) $('#sp-from').value = _firstOfMonthISO();
    if ($('#sp-to')   && !$('#sp-to').value)   $('#sp-to').value   = _lastOfMonthISO();
    renderSalesPersonsList();
    _renderSalesPersonSummary();
  });
}
