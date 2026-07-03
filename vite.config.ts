import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      // @ts-expect-error process is a nodejs global
      "@": `${process.cwd()}/src`,
    },
  },

  build: {
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /node_modules[\\/](react|react-dom)[\\/]/,
              priority: 30,
            },
            {
              name: "vendor-markdown",
              test: /node_modules[\\/](react-markdown|remark-gfm|rehype-raw|rehype-sanitize|unified|micromark|mdast-util|hast-util|unist-util|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|devlop|vfile|trough|bail|ccount|zwitch|html-void-elements|parse-entities|character-entities|hastscript|estree-util|style-to-js|style-to-object|inline-style-parser)[\\/]/,
              priority: 20,
            },
            {
              name: "vendor-terminal",
              test: /node_modules[\\/]@xterm[\\/]/,
              priority: 20,
            },
            {
              name: "vendor-dnd",
              test: /node_modules[\\/]@dnd-kit[\\/]/,
              priority: 20,
            },
            {
              name: "vendor",
              test: /node_modules[\\/]/,
              priority: 10,
              maxSize: 450 * 1024,
            },
          ],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
