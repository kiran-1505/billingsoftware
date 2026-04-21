// db.js — IndexedDB wrapper for ToolBill
// Stores: products, invoices, stockMovements, settings, categories, drafts

const DB_NAME = 'toolbill';
const DB_VERSION = 2;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('products')) {
        const s = db.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
        s.createIndex('shortCode', 'shortCode', { unique: true });
        s.createIndex('category', 'category', { unique: false });
        s.createIndex('name', 'name', { unique: false });
      }
      if (!db.objectStoreNames.contains('invoices')) {
        const s = db.createObjectStore('invoices', { keyPath: 'id', autoIncrement: true });
        s.createIndex('invoiceNo', 'invoiceNo', { unique: true });
        s.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('stockMovements')) {
        const s = db.createObjectStore('stockMovements', { keyPath: 'id', autoIncrement: true });
        s.createIndex('productId', 'productId', { unique: false });
        s.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      // v2: categories + drafts
      if (!db.objectStoreNames.contains('categories')) {
        const s = db.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
        s.createIndex('name', 'name', { unique: true });
      }
      if (!db.objectStoreNames.contains('drafts')) {
        const s = db.createObjectStore('drafts', { keyPath: 'id', autoIncrement: true });
        s.createIndex('date', 'date', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(store, mode = 'readonly') {
  return openDB().then(db => db.transaction(store, mode).objectStore(store));
}

function req2promise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const db = {
  // ----- Generic -----
  async add(store, obj) {
    const s = await tx(store, 'readwrite');
    const id = await req2promise(s.add(obj));
    return id;
  },
  async put(store, obj) {
    const s = await tx(store, 'readwrite');
    return await req2promise(s.put(obj));
  },
  async get(store, id) {
    const s = await tx(store);
    return await req2promise(s.get(id));
  },
  async del(store, id) {
    const s = await tx(store, 'readwrite');
    return await req2promise(s.delete(id));
  },
  async all(store) {
    const s = await tx(store);
    return await req2promise(s.getAll());
  },
  async clear(store) {
    const s = await tx(store, 'readwrite');
    return await req2promise(s.clear());
  },
  async count(store) {
    const s = await tx(store);
    return await req2promise(s.count());
  },

  // ----- Products -----
  async getProductByShortCode(shortCode) {
    const s = await tx('products');
    const idx = s.index('shortCode');
    return await req2promise(idx.get(shortCode));
  },

  // Random short code: 3 letters + 5 digits, separated by '-'
  //   e.g. KMR-48217, XQT-90432
  // Tries up to 25 times to avoid collision with an existing code.
  async nextShortCode() {
    const products = await this.all('products');
    const used = new Set(products.map(p => (p.shortCode || '').toUpperCase()));
    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const pickLetters = () => Array.from({ length: 3 }, () =>
      ALPHA[Math.floor(Math.random() * ALPHA.length)]
    ).join('');
    const pickDigits = () =>
      String(Math.floor(Math.random() * 100000)).padStart(5, '0');
    for (let i = 0; i < 25; i++) {
      const code = `${pickLetters()}-${pickDigits()}`;
      if (!used.has(code)) return code;
    }
    // Extremely unlikely fallback — append timestamp suffix
    return `${pickLetters()}-${pickDigits()}-${Date.now().toString(36).slice(-3)}`;
  },

  // ----- Categories -----
  async getCategoryByName(name) {
    const s = await tx('categories');
    const idx = s.index('name');
    return await req2promise(idx.get(name));
  },

  // ----- Settings -----
  async getSetting(key, fallback = null) {
    const s = await tx('settings');
    const row = await req2promise(s.get(key));
    return row ? row.value : fallback;
  },
  async setSetting(key, value) {
    const s = await tx('settings', 'readwrite');
    return await req2promise(s.put({ key, value }));
  },

  // ----- Backup / restore -----
  async exportAll() {
    const [products, invoices, stockMovements, settingsArr, categories, drafts] = await Promise.all([
      this.all('products'),
      this.all('invoices'),
      this.all('stockMovements'),
      this.all('settings'),
      this.all('categories'),
      this.all('drafts'),
    ]);
    const settings = {};
    for (const s of settingsArr) settings[s.key] = s.value;
    return {
      app: 'toolbill',
      version: 2,
      exportedAt: new Date().toISOString(),
      products, invoices, stockMovements, settings, categories, drafts,
    };
  },

  async importAll(data) {
    if (!data || data.app !== 'toolbill') throw new Error('Not a ToolBill backup');
    const d = await openDB();
    await new Promise((resolve, reject) => {
      const t = d.transaction(['products','invoices','stockMovements','settings','categories','drafts'], 'readwrite');
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
      const pStore = t.objectStore('products');
      const iStore = t.objectStore('invoices');
      const mStore = t.objectStore('stockMovements');
      const sStore = t.objectStore('settings');
      const cStore = t.objectStore('categories');
      const dStore = t.objectStore('drafts');
      pStore.clear(); iStore.clear(); mStore.clear(); sStore.clear(); cStore.clear(); dStore.clear();
      (data.products || []).forEach(p => pStore.put(p));
      (data.invoices || []).forEach(i => iStore.put(i));
      (data.stockMovements || []).forEach(m => mStore.put(m));
      (data.categories || []).forEach(c => cStore.put(c));
      (data.drafts || []).forEach(d => dStore.put(d));
      const settings = data.settings || {};
      Object.keys(settings).forEach(k => sStore.put({ key: k, value: settings[k] }));
    });
  },

  async wipe() {
    await Promise.all([
      this.clear('products'),
      this.clear('invoices'),
      this.clear('stockMovements'),
      this.clear('settings'),
      this.clear('categories'),
      this.clear('drafts'),
    ]);
  },
};

// Expose for debugging from devtools
window.__db = db;
