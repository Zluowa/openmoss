// FILE: codexHomePaths.test.ts
// Purpose: Verifies Codex source, overlay, account, and image-allowlist path isolation.
// Layer: Server path utility tests.

import assert from "node:assert/strict";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveCodexHomeOverlayAccountSegment,
  resolveActiveCodexHomeWritePath,
  resolveCodexHomeOverlayWritePath,
  resolveBaseCodexHomePath,
  resolveCodexHomeAllowlistCandidates,
  resolveMossCodexHomeOverlayPath,
} from "./codexHomePaths.ts";

describe("Codex home paths", () => {
  it("resolves the source home using explicit, environment, then default precedence", () => {
    assert.equal(
      resolveBaseCodexHomePath({ CODEX_HOME: "/env/codex" }, "/explicit/codex"),
      "/explicit/codex",
    );
    assert.equal(resolveBaseCodexHomePath({ CODEX_HOME: "/env/codex" }), "/env/codex");
    assert.ok(resolveBaseCodexHomePath({}).endsWith(`${path.sep}.codex`));
  });

  it("falls back to ~/.codex when nothing is provided", () => {
    const result = resolveBaseCodexHomePath({});
    assert.ok(result.endsWith(`${path.sep}.codex`));
  });

  it("expands a leading tilde in explicit homes", () => {
    const result = resolveBaseCodexHomePath({}, "~/.codex_work");

    assert.ok(result.endsWith(`${path.sep}.codex_work`));
    assert.ok(!result.startsWith("~"));
  });

  it("expands a Windows-style tilde home", () => {
    const result = resolveBaseCodexHomePath({}, "~\\.codex_work");

    assert.ok(result.endsWith(`${path.sep}.codex_work`));
    assert.ok(!result.startsWith("~"));
  });
});

describe("resolveMossCodexHomeOverlayPath", () => {
  it("anchors the overlay under MOSS_HOME when set", () => {
    assert.equal(
      resolveMossCodexHomeOverlayPath({ MOSS_HOME: "/moss/runtime" }, "/users/me/.codex"),
      path.join("/moss/runtime", "codex-home-overlay"),
    );
  });

  it("derives a default overlay beside the source home", () => {
    assert.equal(
      resolveMossCodexHomeOverlayPath({}, "/users/me/.codex"),
      path.join("/users/me", ".moss", "runtime", "codex-home-overlay"),
    );
  });
  it("derives nested account overlays when given an account segment", () => {
    const segment = resolveCodexHomeOverlayAccountSegment({
      accountId: "work",
      homePath: "/users/me/.codex",
      shadowHomePath: "/users/me/.codex_work",
    });

    assert.ok(segment?.startsWith("work-"));
    assert.equal(
      resolveMossCodexHomeOverlayPath({ MOSS_HOME: "/moss/runtime" }, "/users/me/.codex", segment),
      path.join("/moss/runtime", "codex-home-overlay", "accounts", segment ?? ""),
    );
  });

  it("does not create a nested account overlay for the explicit default account", () => {
    assert.equal(
      resolveCodexHomeOverlayAccountSegment({
        accountId: "default",
        homePath: "/users/me/.codex",
      }),
      undefined,
    );
  });

  it("creates a source-specific overlay for a dedicated default account home", () => {
    const segment = resolveCodexHomeOverlayAccountSegment({
      accountId: "default",
      homePath: "/isolated/codex-home",
      accountSourceHomeIsDedicated: true,
    });

    assert.ok(segment?.startsWith("default-"));
  });
});

describe("resolveActiveCodexHomeWritePath", () => {
  it("uses the isolated overlay as Codex's write home", () => {
    assert.equal(
      resolveActiveCodexHomeWritePath({
        env: { CODEX_HOME: "/users/me/.codex", MOSS_HOME: "/moss/runtime" },
        homePath: "/users/me/.codex",
      }),
      path.join("/moss/runtime", "codex-home-overlay"),
    );
  });

  it("does not reuse the default overlay after switching to a dedicated home", () => {
    const env = {
      CODEX_HOME: "/users/me/.codex",
      MOSS_HOME: "/moss/runtime",
    };
    const defaultOverlay = resolveActiveCodexHomeWritePath({ env });
    const dedicatedOverlay = resolveActiveCodexHomeWritePath({
      env,
      homePath: "/isolated/codex-home",
    });

    assert.equal(defaultOverlay, path.join("/moss/runtime", "codex-home-overlay"));
    assert.notEqual(dedicatedOverlay, defaultOverlay);
    assert.ok(dedicatedOverlay.includes(path.join("codex-home-overlay", "accounts")));
  });

  it("allowlists source and overlay homes when distinct", () => {
    assert.deepEqual(
      resolveCodexHomeAllowlistCandidates({
        env: { CODEX_HOME: "/users/me/.codex", MOSS_HOME: "/moss/runtime" },
        homePath: "/users/me/.codex",
      }),
      ["/users/me/.codex", path.join("/moss/runtime", "codex-home-overlay")],
    );
  });

  it("keeps account-id-only homes isolated", () => {
    const env = {
      CODEX_HOME: "/users/me/.codex",
      MOSS_HOME: "/moss/runtime",
    };
    const segment = resolveCodexHomeOverlayAccountSegment({
      accountId: "codex_2",
      homePath: "/users/me/.codex",
    });

    assert.equal(
      resolveActiveCodexHomeWritePath({ env, accountId: "codex_2" }),
      path.join("/moss/runtime", "codex-home-overlay", "accounts", segment ?? ""),
    );
  });

  it("keeps explicit shared homes isolated for non-default accounts", () => {
    const env = {
      CODEX_HOME: "/users/me/.codex",
      MOSS_HOME: "/moss/runtime",
    };
    const segment = resolveCodexHomeOverlayAccountSegment({
      accountId: "codex_2",
      homePath: "/users/me/.codex",
    });

    assert.equal(
      resolveActiveCodexHomeWritePath({
        env,
        homePath: "/users/me/.codex",
        accountId: "codex_2",
      }),
      path.join("/moss/runtime", "codex-home-overlay", "accounts", segment ?? ""),
    );
  });

  it("keeps dedicated explicit account homes in their account overlay", () => {
    const segment = resolveCodexHomeOverlayAccountSegment({
      accountId: "codex_2",
      homePath: "/users/me/.codex-work",
    });
    assert.equal(
      resolveActiveCodexHomeWritePath({
        env: {
          CODEX_HOME: "/users/me/.codex",
          MOSS_HOME: "/moss/runtime",
        },
        homePath: "/users/me/.codex-work",
        accountId: "codex_2",
      }),
      path.join("/moss/runtime", "codex-home-overlay", "accounts", segment ?? ""),
    );
  });
});

describe("resolveCodexHomeAllowlistCandidates", () => {
  it("includes both source and overlay homes when distinct", () => {
    const candidates = resolveCodexHomeAllowlistCandidates({
      env: { CODEX_HOME: "/users/me/.codex", MOSS_HOME: "/moss/runtime" },
      homePath: "/users/me/.codex",
    });
    assert.deepEqual(candidates, [
      "/users/me/.codex",
      path.join("/moss/runtime", "codex-home-overlay"),
    ]);
  });

  it("returns just the source when overlay equals source", () => {
    const candidates = resolveCodexHomeAllowlistCandidates({
      env: { MOSS_HOME: "/users/me" },
      homePath: path.join("/users/me", "codex-home-overlay"),
    });
    assert.deepEqual(candidates, [path.join("/users/me", "codex-home-overlay")]);
  });

  it("includes the shadow home for account-scoped writes", () => {
    const segment = resolveCodexHomeOverlayAccountSegment({
      homePath: "/users/me/.codex",
      shadowHomePath: "/users/me/.codex_work",
    });
    const candidates = resolveCodexHomeAllowlistCandidates({
      env: { MOSS_HOME: "/moss/runtime" },
      homePath: "/users/me/.codex",
      shadowHomePath: "/users/me/.codex_work",
    });
    assert.deepEqual(candidates, [
      path.join("/moss/runtime", "codex-home-overlay", "accounts", segment ?? ""),
      "/users/me/.codex_work",
    ]);
  });

  it("excludes default roots from account-id-only Codex homes", () => {
    const segment = resolveCodexHomeOverlayAccountSegment({
      accountId: "work",
      homePath: "/users/me/.codex",
    });
    const candidates = resolveCodexHomeAllowlistCandidates({
      env: { MOSS_HOME: "/moss/runtime", CODEX_HOME: "/users/me/.codex" },
      homePath: "/users/me/.codex",
      accountId: "work",
      accountSourceHomeIsDedicated: false,
    });
    assert.deepEqual(candidates, [
      path.join("/moss/runtime", "codex-home-overlay", "accounts", segment ?? ""),
    ]);
  });

  it("keeps a dedicated account home alongside its account overlay", () => {
    const segment = resolveCodexHomeOverlayAccountSegment({
      accountId: "work",
      homePath: "/users/me/.codex-work",
    });
    const candidates = resolveCodexHomeAllowlistCandidates({
      env: { MOSS_HOME: "/moss/runtime", CODEX_HOME: "/users/me/.codex" },
      homePath: "/users/me/.codex-work",
      accountId: "work",
      accountSourceHomeIsDedicated: true,
    });
    assert.deepEqual(candidates, [
      "/users/me/.codex-work",
      path.join("/moss/runtime", "codex-home-overlay", "accounts", segment ?? ""),
    ]);
  });
});

describe("Windows managed runtime path prediction", () => {
  it("selects the dedicated canonical home only for the narrow Windows managed shape", () => {
    const input = {
      homePath: path.resolve("managed-codex"),
      accountId: "moss",
      platform: "win32" as const,
      env: { CODEX_HOME: path.resolve("ambient-codex"), MOSS_HOME: path.resolve("moss-state") },
    };
    expect(resolveActiveCodexHomeWritePath(input)).toBe(input.homePath);
    expect(resolveCodexHomeOverlayWritePath(input)).not.toBe(input.homePath);
    for (const changed of [
      { ...input, accountId: "work" },
      { ...input, platform: "linux" as const },
      { ...input, shadowHomePath: path.resolve("shadow-codex") },
      { ...input, homePath: input.env.CODEX_HOME },
    ]) {
      expect(resolveActiveCodexHomeWritePath(changed)).toBe(
        resolveCodexHomeOverlayWritePath(changed),
      );
    }
  });
});
