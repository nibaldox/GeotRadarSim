import "@testing-library/jest-dom/vitest";

// jsdom v29 + Node 26 no longer expose window.localStorage by default, and
// Node's built-in localStorage is opt-in via --localstorage-file. Provide a
// minimal in-memory stub so component tests that touch localStorage keep
// working under jsdom. Safe to load when localStorage is already available.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  const stub: Storage = {
    getItem: (key) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  globalThis.localStorage = stub;
}
