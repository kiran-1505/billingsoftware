// modules/settings.js — settings form, backup, restore, reset
import { db } from '../db.js';
import {
  state, $, DEFAULT_SETTINGS, DEFAULT_CATEGORIES, nowISO, todayISO, toast,
  refreshCategories, refreshProducts, refreshDrafts, migrateLegacyProductCategories,
  populateCategorySelects, downloadBlob, registerTabRenderer,
} from './core.js';

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
}

async function _saveSettings() {
  const s = state.settings;
  s.shopName      = $('#set-shop-name').value.trim() || 'Shop';
  s.address       = $('#set-address').value.trim();
  s.phone         = $('#set-phone').value.trim();
  s.gstin         = $('#set-gstin').value.trim();
  s.invoicePrefix = $('#set-inv-prefix').value.trim() || 'INV-';
  s.nextInvoiceNo = Math.max(1, parseInt($('#set-inv-next').value || '1', 10));
  s.footer        = $('#set-footer').value.trim();
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
  $('#btn-export').addEventListener('click', exportBackup);
  $('#import-file').addEventListener('change', _importBackup);
  $('#btn-reset').addEventListener('click', _resetAllData);

  registerTabRenderer('settings', applySettingsToForm);
}
