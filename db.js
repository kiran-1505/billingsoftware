// db.js — IndexedDB wrapper for ToolBill
// Stores: products, invoices, stockMovements, settings

const DB_NAME = 'toolbill';
const DB_VERSION = 1;

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

  async nextShortCode(category) {
    const prefix = (category || 'GN').toUpperCase();
    const products = await this.all('products');
    let max = 0;
    const re = new RegExp(`^${prefix}-(\\d{4})$`);
    for (const p of products) {
      const m = p.shortCode && p.shortCode.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
    const next = (max + 1).toString().padStart(4, '0');
    return `${prefix}-${next}`;
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
    const [products, invoices, stockMovements, settingsArr] = await Promise.all([
      this.all('products'),
      this.all('invoices'),
      this.all('stockMovements'),
      this.all('settings'),
    ]);
    const settings = {};
    for (const s of settingsArr) settings[s.key] = s.value;
    return {
      app: 'toolbill',
      version: 1,
      exportedAt: new Date().toISOString(),
      products, invoices, stockMovements, settings,
    };
  },

  async importAll(data) {
    if (!data || data.app !== 'toolbill') throw new Error('Not a ToolBill backup');
    const d = await openDB();
    await new Promise((resolve, reject) => {
      const t = d.transaction(['products','invoices','stockMovements','settings'], 'readwrite');
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
      const pStore = t.objectStore('products');
      const iStore = t.objectStore('invoices');
      const mStore = t.objectStore('stockMovements');
      const sStore = t.objectStore('settings');
      pStore.clear(); iStore.clear(); mStore.clear(); sStore.clear();
      (data.products || []).forEach(p => pStore.put(p));
      (data.invoices || []).forEach(i => iStore.put(i));
      (data.stockMovements || []).forEach(m => mStore.put(m));
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
    ]);
  },
};

// Expose for debugging from devtools
window.__db = db;
