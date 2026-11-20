/**
 * Start a module Worker from a local `blob:` bootstrap so that it inherits the document's
 * Content-Security-Policy.
 *
 * GitHub Pages cannot send response headers, so the CSP is delivered by a `<meta>` tag in the
 * document. A Worker created from a same-origin URL takes its policy from the headers of its
 * own script response, which carry none, so it would run with no CSP at all. A Worker whose URL
 * is local (`blob:`) inherits the policy container of the document that creates it instead
 * (CSP3 and the HTML policy-container rules), and therefore runs under the `<meta>` policy.
 *
 * The bootstrap is a one-line ES module that statically imports the real Worker module emitted
 * by Vite (`?worker&url`). Inside that module `import.meta.url` is still its real URL, so
 * relative assets such as the `.wasm` resolve exactly as before. This requires the Worker
 * bundle to be an ES module (`worker.format: "es"` in `vite.config.ts`): Vite's default IIFE
 * format rewrites `import.meta.url` to `self.location.href`, which would be the `blob:` URL.
 *
 * The bootstrap revokes its own `blob:` URL once the imported module graph has evaluated, that
 * is, after the URL has been fetched and the Worker's message handler is installed. It is not
 * revoked right after `new Worker()`: Vite's own inline module-Worker wrapper notes that doing so
 * makes the Worker fail to run. If the module fails to load, or the Worker is terminated before it
 * evaluates, the bootstrap Blob (well under 1 KB) stays registered until the page unloads.
 */

/** Source of the bootstrap module that imports `absoluteModuleUrl` and then revokes itself. */
export function moduleWorkerBootstrapSource(absoluteModuleUrl: string): string {
  return `import ${JSON.stringify(absoluteModuleUrl)};\nURL.revokeObjectURL(import.meta.url);\n`;
}

/**
 * Create a `{ type: "module" }` Worker that runs `moduleUrl` (the Vite-emitted URL of the Worker
 * module, absolute or relative to the document) from a `blob:` bootstrap.
 *
 * Throws a `TypeError` if `moduleUrl` is not same-origin with the document: the bootstrap only
 * ever loads this application's own Worker bundles.
 */
export function createModuleWorker(moduleUrl: string): Worker {
  const base = globalThis.location.href;
  const absolute = new URL(moduleUrl, base);
  if (absolute.origin !== new URL(base).origin) {
    throw new TypeError(`Refusing to start a Worker from a cross-origin module: ${absolute.origin}`);
  }
  const bootstrap = new Blob([moduleWorkerBootstrapSource(absolute.href)], { type: "text/javascript" });
  const bootstrapUrl = URL.createObjectURL(bootstrap);
  try {
    return new Worker(bootstrapUrl, { type: "module" });
  } catch (error) {
    // The Worker never started, so nothing else will release the bootstrap.
    URL.revokeObjectURL(bootstrapUrl);
    throw error;
  }
}
