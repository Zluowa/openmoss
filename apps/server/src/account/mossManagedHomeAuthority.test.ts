import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@synara/contracts";

import {
  assertManagedCodexHomeAuthorityCurrentSync,
  buildMossManagedHomeOwnershipMarker,
  readManagedCodexHomeAuthority,
  type ManagedCodexHomeAuthority,
} from "./mossManagedHomeAuthority.ts";

const roots: string[] = [];
const nonce = "359a3e2c-e085-4f1b-a0a9-262a5552b512";
const otherNonce = "a93e9632-8f78-427d-a89c-1aba8c8b8427";
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moss-home-authority-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const homePath = path.join(stateDir, "moss-codex-home");
  mkdirSync(homePath, { recursive: true });
  const markerPath = path.join(homePath, ".moss-managed-home");
  writeFileSync(markerPath, buildMossManagedHomeOwnershipMarker(nonce));
  let settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        accounts: [{ id: "moss", label: "Moss", homePath, shadowHomePath: "" }],
      },
    },
    providerInstances: {
      codex_moss: {
        driver: "codex",
        enabled: true,
        config: { managed: true, accountId: "moss", homePath, homeOwnershipNonce: nonce },
      },
    },
  };
  const input = { accountId: "moss", homePath, env: {} };
  const issue = (overrides: Partial<Parameters<typeof readManagedCodexHomeAuthority>[0]> = {}) =>
    readManagedCodexHomeAuthority({
      stateDir,
      readSettings: async () => settings,
      readSettingsSync: () => settings,
      input,
      platform: "win32",
      ...overrides,
    });
  return {
    root,
    stateDir,
    homePath,
    markerPath,
    input,
    issue,
    settings: () => settings,
    replaceSettings: (value: ServerSettings) => {
      settings = value;
    },
  };
}

describe("server-issued managed Codex home authority", () => {
  it("binds the reserved settings nonce and rechecks it before reuse", async () => {
    const f = fixture();
    const authority = await f.issue();
    expect(authority?.homePath).toBe(realpathSync.native(f.homePath));
    expect(Object.isFrozen(authority)).toBe(true);
    await authority!.assertCurrent();
    assertManagedCodexHomeAuthorityCurrentSync(authority!);
    const current = f.settings();
    f.replaceSettings({
      ...current,
      providerInstances: {
        codex_moss: {
          ...current.providerInstances.codex_moss!,
          config: {
            ...(current.providerInstances.codex_moss!.config as Record<string, unknown>),
            homeOwnershipNonce: otherNonce,
          },
        },
      },
    });
    await expect(authority!.assertCurrent()).rejects.toThrow("reservation changed");
    expect(() => assertManagedCodexHomeAuthorityCurrentSync(authority!)).toThrow(
      "reservation changed",
    );
  });

  it("does not mint authority for another account or platform", async () => {
    const f = fixture();
    expect(await f.issue({ input: { ...f.input, accountId: "work" } })).toBeUndefined();
    expect(await f.issue({ platform: "linux" })).toBeUndefined();
  });

  it("rejects a copied valid marker without the exact reserved server path", async () => {
    const f = fixture();
    const copiedHome = path.join(f.root, "copied-home");
    mkdirSync(copiedHome);
    writeFileSync(
      path.join(copiedHome, ".moss-managed-home"),
      buildMossManagedHomeOwnershipMarker(nonce),
    );
    await expect(f.issue({ input: { ...f.input, homePath: copiedHome } })).rejects.toThrow(
      "server-owned home",
    );
  });

  it.each(["wrong nonce", "legacy downgrade", "oversized"])("rejects %s markers", async (kind) => {
    const f = fixture();
    writeFileSync(
      f.markerPath,
      kind === "wrong nonce"
        ? buildMossManagedHomeOwnershipMarker(otherNonce)
        : kind === "legacy downgrade"
          ? "moss-managed-codex-home-v1\n"
          : "x".repeat(257),
    );
    await expect(f.issue()).rejects.toThrow(/ownership/);
  });

  it("does not treat a marker-only directory as a persisted reservation", async () => {
    const f = fixture();
    f.replaceSettings(DEFAULT_SERVER_SETTINGS);
    await expect(f.issue()).rejects.toThrow("server reservation");
  });

  it("preserves the existing fixed-path v1 reservation upgrade contract", async () => {
    const f = fixture();
    const current = f.settings();
    f.replaceSettings({
      ...current,
      providerInstances: {
        codex_moss: {
          ...current.providerInstances.codex_moss!,
          config: { managed: true, accountId: "moss", homePath: f.homePath },
        },
      },
    });
    writeFileSync(f.markerPath, "moss-managed-codex-home-v1\n");
    await (await f.issue())!.assertCurrent();
  });

  it.each(["disabled", "shadow", "MOSS_HOME", "account path"])(
    "rejects changed %s provenance",
    async (kind) => {
      const f = fixture();
      const current = f.settings();
      const instance = current.providerInstances.codex_moss!;
      f.replaceSettings({
        ...current,
        ...(kind === "account path"
          ? {
              providers: {
                ...current.providers,
                codex: {
                  ...current.providers.codex,
                  accounts: [{ id: "moss", label: "Moss", homePath: f.root, shadowHomePath: "" }],
                },
              },
            }
          : {}),
        providerInstances: {
          codex_moss: {
            ...instance,
            ...(kind === "disabled" ? { enabled: false } : {}),
            ...(kind === "shadow"
              ? {
                  config: {
                    ...(instance.config as Record<string, unknown>),
                    shadowHomePath: f.root,
                  },
                }
              : {}),
            ...(kind === "MOSS_HOME"
              ? { environment: [{ name: "mOsS_hOmE", value: "", sensitive: false }] }
              : {}),
          },
        },
      });
      await expect(f.issue()).rejects.toThrow("server reservation");
    },
  );

  it("rejects ambient CODEX_HOME aliases and symlinked managed homes", async () => {
    const f = fixture();
    const alias = path.join(f.root, "alias");
    symlinkSync(f.homePath, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(f.issue({ input: { ...f.input, env: { CODEX_HOME: alias } } })).rejects.toThrow(
      "ambient CODEX_HOME",
    );
    await expect(
      f.issue({ input: { ...f.input, env: { CODEX_HOME: f.root, Codex_Home: alias } } }),
    ).rejects.toThrow("ambient CODEX_HOME");
    const original = path.join(f.stateDir, "original");
    renameSync(f.homePath, original);
    symlinkSync(original, f.homePath, process.platform === "win32" ? "junction" : "dir");
    await expect(f.issue()).rejects.toThrow("real directories");
  });

  it("rejects a replaced home even if its copied nonce still matches", async () => {
    const f = fixture();
    const authority = (await f.issue())!;
    renameSync(f.homePath, path.join(f.stateDir, "previous"));
    mkdirSync(f.homePath);
    writeFileSync(f.markerPath, buildMossManagedHomeOwnershipMarker(nonce));
    expect(() => assertManagedCodexHomeAuthorityCurrentSync(authority)).toThrow(
      "ownership changed",
    );
  });

  it("cannot forge the process-local capability from copied public fields", async () => {
    const f = fixture();
    const authority = (await f.issue())!;
    expect(() => assertManagedCodexHomeAuthorityCurrentSync({ ...authority })).toThrow(
      "not issued",
    );
    expect(() =>
      assertManagedCodexHomeAuthorityCurrentSync({
        homePath: f.homePath,
        ownershipMarker: authority.ownershipMarker,
        assertCurrent: async () => {},
      } as ManagedCodexHomeAuthority),
    ).toThrow("not issued");
  });
});
