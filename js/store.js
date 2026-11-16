/* Helium: local persistence: IndexedDB for handles, metadata cache and artwork; localStorage for prefs & stats. */
(function (H) {
  'use strict';

  const STORES = ['kv', 'meta', 'art'];
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open('helium', 1);
          req.onupgradeneeded = () => {
            for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    }
    return dbPromise;
  }

  async function run(store, mode, fn) {
    const db = await open();
    if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = tx.onabort = () => resolve(undefined);
      } catch (e) {
        resolve(undefined);
      }
    });
  }

  const idb = {
    get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
    put: (store, key, value) => run(store, 'readwrite', (s) => s.put(value, key)),
    del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
    clear: (store) => run(store, 'readwrite', (s) => s.clear())
  };

  const ls = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('helium.' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem('helium.' + key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
    },
    remove(key) {
      try { localStorage.removeItem('helium.' + key); } catch (e) { /* storage unavailable */ }
    }
  };

  H.store = { idb, ls };
})(window.Helium = window.Helium || {});
