import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/GeotRadarSim/",
  plugins: [react(), {
    name: "production-csp",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler: () => [{
        tag: "meta",
        attrs: {
          "http-equiv": "Content-Security-Policy",
          content: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'",
        },
        injectTo: "head-prepend",
      }],
    },
  }],
});
