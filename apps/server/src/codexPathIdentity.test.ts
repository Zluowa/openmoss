// FILE: codexPathIdentity.test.ts
// Purpose: Verifies Codex path identity across direct and parent-component aliases.
// Layer: Server filesystem utility tests.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import {
  codexDirectoriesReferenceSameUnredirectedLocation,
  codexDirectoriesReferenceSameUnredirectedLocationIo,
  codexPathsReferenceSameLocation,
  resolveCodexPathIdentity,
  resolveCodexPathIdentityIo,
} from "./codexPathIdentity.ts";
import { runCodexAuthIoAsync } from "./codexAuthIo.ts";

describe("Codex path identity", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches homes reached through a symlinked parent component", () => {
    const root = mkdtempSync(path.join(tmpdir(), "moss-codex-path-identity-"));
    roots.push(root);
    const realParent = path.join(root, "real-parent");
    const realHome = path.join(realParent, "codex-home");
    const parentAlias = path.join(root, "parent-alias");
    mkdirSync(realHome, { recursive: true });
    symlinkSync(realParent, parentAlias, process.platform === "win32" ? "junction" : "dir");

    assert.equal(
      codexPathsReferenceSameLocation(realHome, path.join(parentAlias, "codex-home")),
      true,
    );
  });

  it("preserves missing tails beneath the nearest real parent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "moss-codex-path-missing-"));
    roots.push(root);
    const realParent = path.join(root, "real-parent");
    const parentAlias = path.join(root, "parent-alias");
    mkdirSync(realParent, { recursive: true });
    symlinkSync(realParent, parentAlias, process.platform === "win32" ? "junction" : "dir");

    assert.equal(
      resolveCodexPathIdentity(path.join(parentAlias, "future", "codex-home")),
      resolveCodexPathIdentity(path.join(realParent, "future", "codex-home")),
    );
  });

  it("keeps sync and async identity equal but rejects redirected authority aliases", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "moss-codex-path-io-"));
    roots.push(root);
    const realHome = path.join(root, "home");
    const alias = path.join(root, "alias");
    mkdirSync(realHome);
    symlinkSync(realHome, alias, process.platform === "win32" ? "junction" : "dir");
    for (const target of [realHome, alias, path.join(alias, "missing")]) {
      assert.equal(
        await runCodexAuthIoAsync(resolveCodexPathIdentityIo(target)),
        resolveCodexPathIdentity(target),
      );
    }
    assert.equal(codexDirectoriesReferenceSameUnredirectedLocation(realHome, alias), false);
    assert.equal(
      await runCodexAuthIoAsync(
        codexDirectoriesReferenceSameUnredirectedLocationIo(realHome, alias),
      ),
      false,
    );
    assert.equal(codexDirectoriesReferenceSameUnredirectedLocation(realHome, realHome), true);
    assert.equal(
      codexDirectoriesReferenceSameUnredirectedLocation(
        path.join(root, "first-missing"),
        path.join(root, "second-missing"),
      ),
      false,
    );
  });
});
