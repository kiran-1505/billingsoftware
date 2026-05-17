// modules/settings.js — settings form, backup, restore, reset
import { db } from '../db.js';
import {
  state, $, DEFAULT_SETTINGS, DEFAULT_CATEGORIES, nowISO, todayISO, toast,
  refreshCategories, refreshProducts, refreshDrafts, migrateLegacyProductCategories,
  populateCategorySelects, downloadBlob, registerTabRenderer, openModal, closeModal,
  switchTab,
} from './core.js';
import { applyUserState } from './auth.js';

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

  registerTabRenderer('settings', applySettingsToForm);
}
