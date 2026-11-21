import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/GeotRadarSim/",
  // Workers start from a `blob:` bootstrap that imports the emitted Worker module (see
  // src/services/moduleWorker.ts) so they inherit this document's <meta> CSP. That needs ES
  // Worker bundles: the default IIFE format rewrites `import.meta.url` to `self.location.href`,
  // which inside a `blob:` Worker is the blob URL and would break the `.wasm` URL resolution.
  worker: { format: "es" },
  plugins: [react(), {
    name: "production-csp",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler: () => [{
        tag: "meta",
        attrs: {
          "http-equiv": "Content-Security-Policy",
          content: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self'; img-src 'self'; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'",
        },
        injectTo: "head-prepend",
      }, {
        tag: "meta",
        attrs: { name: "referrer", content: "no-referrer" },
        injectTo: "head-prepend",
      }],
    },
  }],
});
