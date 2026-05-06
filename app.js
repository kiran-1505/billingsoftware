// app.js — bootstrap: loads modules, seeds data, wires everything up
import { db } from './db.js';
import {
  state, DEFAULT_SETTINGS, DEFAULT_CATEGORIES, nowISO, closeAnyModal,
  refreshCategories, refreshProducts, refreshDrafts, migrateLegacyProductCategories,
  populateCategorySelects, switchTab, wireTabs, wireModalClose, wireDateInputs,
} from './modules/core.js';

import { wireAdmin, applyUserState }                           from './modules/auth.js';
import { wireBilling, wireDrafts, buildCustomerList,
         saveAndPrintBill, saveDraftFromCart }                 from './modules/billing.js';
import { wireProducts, wireCategoryManager }                   from './modules/products.js';
import { wireInventory }                                       from './modules/inventory.js';
import { wireLabels }                                          from './modules/labels.js';
import { wireReports }                                        from './modules/reports.js';
import { wireVoidBills }                                       from './modules/scaledown.js';
import { wireDaily }                                           from './modules/daily.js';
import { wireSettings, applySettingsToForm, exportBackup }    from './modules/settings.js';
import { wireGlobalScanner, wireCameraScanner }                from './modules/scanner.js';

async function init() {
  // Load settings
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    state.settings[k] = await db.getSetting(k, v);
  }
  applySettingsToForm();

  // Seed + load categories
  await refreshCategories();
  if (!state.categories.length) {
    for (const name of DEFAULT_CATEGORIES) {
      await db.add('categories', { name, createdAt: nowISO() });
    }
    await refreshCategories();
  }

  // Load products, migrate legacy codes, load drafts, build customer list
  await refreshProducts();
  await migrateLegacyProductCategories();
  await refreshDrafts();
  await buildCustomerList();

  // Populate shared category <select> elements
  populateCategorySelects();

  // Wire all modules
  wireTabs();
  wireBilling();
  wireDrafts();
  wireProducts();
  wireCategoryManager();
  wireInventory();
  wireDaily();
  wireLabels();
  wireReports();
  wireVoidBills();
  wireSettings();
  wireModalClose();
  wireDateInputs();
  wireGlobalScanner();
  wireAdmin();
  wireCameraScanner();
  applyUserState();

  // F2 / F9 / F7 / Escape hotkeys (needs references to billing functions)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F2') {
      e.preventDefault();
      switchTab('billing');
      document.querySelector('#bill-search')?.focus();
    }
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

  switchTab('billing');
}

// Expose for update banner
window.exportBackup = exportBackup;

document.addEventListener('DOMContentLoaded', init);
