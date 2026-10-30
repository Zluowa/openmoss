import * as FS from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = Path.resolve(import.meta.dirname, "..");
const INDEX_SOURCE = FS.readFileSync(Path.join(WEB_ROOT, "index.html"), "utf8");
const SCRIPT_SRC_TOKENS = INDEX_SOURCE.match(/\bscript-src\s+([^;"]+)/)?.[1]?.split(/\s+/) ?? [];
const LOGO_PATH = Path.join(WEB_ROOT, "public", "moss-logo-coral.png");
const LOGO_BYTES = FS.readFileSync(LOGO_PATH);
const BOOTSTRAP_SOURCE = FS.readFileSync(Path.join(import.meta.dirname, "bootstrap.ts"), "utf8");
const MAIN_SOURCE = FS.readFileSync(Path.join(import.meta.dirname, "main.tsx"), "utf8");

describe("renderer bootstrap ordering", () => {
  it("ships a renderer CSP without unsafe-eval", () => {
    expect(INDEX_SOURCE).toContain('http-equiv="Content-Security-Policy"');
    expect(SCRIPT_SRC_TOKENS).toContain("'self'");
    expect(SCRIPT_SRC_TOKENS).toContain("'wasm-unsafe-eval'");
    expect(SCRIPT_SRC_TOKENS).not.toContain("'unsafe-eval'");
  });

  it("allows only the signed production Realtime Voice websocket origins", () => {
    expect(INDEX_SOURCE).toContain("wss://moss-cn-realtime-edge.inkcomicai.com");
    expect(INDEX_SOURCE).toContain("wss://moss-global-realtime.inkcomicai.com");
    expect(INDEX_SOURCE).not.toContain("wss://*.inkcomicai.com");
  });

  it("allows only loopback media sources for local MCP playback", () => {
    expect(INDEX_SOURCE).toContain(
      "media-src 'self' data: blob: http://localhost:* http://127.0.0.1:*",
    );
    expect(INDEX_SOURCE).not.toContain("media-src *");
    expect(INDEX_SOURCE).not.toContain("media-src https:");
  });

  it("keeps the cold-start logo visible before the React module graph loads", () => {
    expect(INDEX_SOURCE).toMatch(/\.app-boot-splash__icon\s*\{[^}]*opacity:\s*1;/su);
    expect(INDEX_SOURCE).toContain('<img\n        class="app-boot-splash__icon"');
    expect(INDEX_SOURCE).toContain('src="/moss-logo-coral.png"');
    expect(INDEX_SOURCE).toContain('decoding="sync"');
    expect(LOGO_BYTES.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(LOGO_BYTES.readUInt32BE(16)).toBeGreaterThan(0);
    expect(LOGO_BYTES.readUInt32BE(20)).toBeGreaterThan(0);
    const splashIndex = INDEX_SOURCE.indexOf('<div id="app-boot-splash"');
    const rootIndex = INDEX_SOURCE.indexOf('<div id="root"></div>');
    expect(splashIndex).toBeGreaterThanOrEqual(0);
    expect(rootIndex).toBeGreaterThan(splashIndex);
    expect(MAIN_SOURCE).toContain("BootstrapSplashDismissal");
    expect(MAIN_SOURCE).toContain("React.useEffect");
    expect(MAIN_SOURCE).not.toContain("React.useLayoutEffect");
    expect(MAIN_SOURCE).toContain("waitForBootstrapPaint().then");
    expect(MAIN_SOURCE).toContain("new MutationObserver");
    expect(MAIN_SOURCE).toContain("root.childElementCount === 0");
  });

  it("migrates desktop storage before loading modules that hydrate app stores", () => {
    expect(INDEX_SOURCE).toContain('<script type="module" src="/src/bootstrap.ts"></script>');

    const migrationImportIndex = BOOTSTRAP_SOURCE.indexOf('import "./storageOriginMigration";');
    const signedOutBootstrapIndex = BOOTSTRAP_SOURCE.indexOf("bootstrapSignedOutScreen()");
    const pairingBootstrapIndex = BOOTSTRAP_SOURCE.indexOf("bootstrapPairingSession()");
    const appImportIndex = BOOTSTRAP_SOURCE.indexOf('import("./main")');
    expect(migrationImportIndex).toBeGreaterThanOrEqual(0);
    expect(signedOutBootstrapIndex).toBeGreaterThan(migrationImportIndex);
    expect(pairingBootstrapIndex).toBeGreaterThan(migrationImportIndex);
    expect(pairingBootstrapIndex).toBeGreaterThan(signedOutBootstrapIndex);
    expect(appImportIndex).toBeGreaterThan(migrationImportIndex);
    expect(appImportIndex).toBeGreaterThan(pairingBootstrapIndex);
    expect(BOOTSTRAP_SOURCE).not.toContain("waitForBootstrapPaint");

    expect(MAIN_SOURCE).not.toContain('import "./storageOriginMigration";');
  });
});
