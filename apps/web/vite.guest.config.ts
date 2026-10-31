// FILE: vite.guest.config.ts
// Purpose: Builds the guest page for "Share with guest" as its own static bundle.
// Layer: Web build config
// Why: The share relay serves this page at `/s/<shareId>` (Nginx in Guangzhou, Cloudflare
//      elsewhere), not the Moss app. It renders the thread with the app's own transcript
//      components, but without the router, the app shell, or a WebSocket, and under a strict
//      CSP (`script-src 'self'`), so it is built apart from the app:
//      `guest.html` → `dist-guest/index.html` with hashed files under `/assets/`.

import fs from "node:fs/promises";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { CENTRAL_ICON_DIRECTORIES, pruneProductionIcons } from "./scripts/production-assets";

const webRoot = import.meta.dirname;
const port = Number(process.env.MOSS_GUEST_PORT ?? 5734);

// The app's glyphs are CSS masks over files in `public/`. Only these directories ship with the
// page; the prune pass then keeps the icons the built bundle names.
const ICON_DIRECTORIES = [...CENTRAL_ICON_DIRECTORIES, "moss-icons"] as const;

// Transcript components draw the Moss mark from this file in `public/`, which the relays do not
// serve. Point them at the same mark as a data URL, which the page's CSP allows.
const APP_MARK_REFERENCE = '"/moss-logo-coral.png"';

/** Dev: `/s/<id>` serves guest.html. Build: `index.html` plus the icons the bundle uses. */
function guestPagePlugin(): Plugin {
  let outDir = "dist-guest";
  let markDataUrl = "";
  return {
    name: "moss-guest-page",
    async buildStart() {
      const mark = await fs.readFile(path.join(webRoot, "src/guest/favicon.svg"), "utf8");
      markDataUrl = `"data:image/svg+xml,${encodeURIComponent(mark.trim())}"`;
    },
    transform(code) {
      if (!code.includes(APP_MARK_REFERENCE)) return null;
      return { code: code.replaceAll(APP_MARK_REFERENCE, markDataUrl), map: null };
    },
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      const publicDir = path.join(webRoot, "public");
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? "";
        if (url.startsWith("/s/")) {
          const query = url.indexOf("?");
          request.url = `/guest.html${query === -1 ? "" : url.slice(query)}`;
          next();
          return;
        }
        // The icon glyphs are CSS masks over `public/`; with publicDir off, serve just those.
        const iconDirectory = ICON_DIRECTORIES.find((directory) =>
          url.startsWith(`/${directory}/`),
        );
        if (!iconDirectory || !url.endsWith(".svg")) {
          next();
          return;
        }
        const file = path.join(publicDir, decodeURIComponent(url.split("?")[0] ?? ""));
        if (!file.startsWith(path.join(publicDir, iconDirectory))) {
          next();
          return;
        }
        void fs.readFile(file).then(
          (contents) => {
            response.setHeader("content-type", "image/svg+xml");
            response.end(contents);
          },
          () => next(),
        );
      });
    },
    // Vite's own HTML plugin emits the page after every other generateBundle hook has run, so
    // the rename happens once the files are on disk.
    async writeBundle() {
      await fs.rename(path.join(outDir, "guest.html"), path.join(outDir, "index.html"));
      const publicDir = path.join(webRoot, "public");
      for (const directory of ICON_DIRECTORIES) {
        await fs.cp(path.join(publicDir, directory), path.join(outDir, directory), {
          recursive: true,
        });
      }
      await pruneProductionIcons(publicDir, outDir, [path.join(outDir, "assets")]);
    },
  };
}

export default defineConfig({
  plugins: [guestPagePlugin(), react(), tailwindcss()],
  base: "/",
  // Only the icon directories above are served; the rest of public/ belongs to the app.
  publicDir: false,
  resolve: {
    alias: {
      react: path.resolve(webRoot, "node_modules/react"),
      "react-dom": path.resolve(webRoot, "node_modules/react-dom"),
    },
    tsconfigPaths: true,
  },
  define: {
    "import.meta.env.VITE_WS_URL": JSON.stringify(""),
  },
  server: {
    port,
    strictPort: true,
  },
  build: {
    outDir: "dist-guest",
    emptyOutDir: true,
    sourcemap: false,
    // The transcript stack is one deliberate chunk; grammars and math already lazy-load.
    chunkSizeWarningLimit: 4000,
    rolldownOptions: {
      input: path.resolve(webRoot, "guest.html"),
    },
  },
});
