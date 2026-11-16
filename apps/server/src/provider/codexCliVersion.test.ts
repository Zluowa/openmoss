// FILE: codexCliVersion.test.ts
// Purpose: Guards the Codex CLI compatibility boundary required by Moss runtime features.
// Layer: Server provider unit tests
// Exports: Vitest coverage for provider/codexCliVersion.ts.

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  CODEX_CLI_UNPARSEABLE_VERSION_MESSAGE,
  compareCodexCliVersions,
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  MINIMUM_CODEX_CLI_VERSION,
  MINIMUM_CODEX_PREDICTION_FORK_CLI_VERSION,
  parseCodexAppServerUserAgentVersion,
  parseCodexCliVersion,
} from "./codexCliVersion.ts";

describe("codexCliVersion", () => {
  it("requires the first stable release that honors CODEX_SQLITE_HOME", () => {
    assert.equal(MINIMUM_CODEX_CLI_VERSION, "0.105.0");
    assert.equal(isCodexCliVersionSupported("0.104.0"), false);
    assert.equal(isCodexCliVersionSupported("0.105.0-alpha.22"), false);
    assert.equal(isCodexCliVersionSupported("0.105.0"), true);
    assert.equal(isCodexCliVersionSupported("0.105.1"), true);
  });

  it("reads the app-server build from the initialize userAgent", () => {
    assert.equal(
      parseCodexAppServerUserAgentVersion("moss_desktop/0.163.0 (Ubuntu 24.4.0; x86_64) unknown"),
      "0.163.0",
    );
    assert.equal(
      parseCodexAppServerUserAgentVersion("codex_cli_rs/0.162.0-alpha.20 (Mac OS 15.1.0; arm64)"),
      "0.162.0-alpha.20",
    );
    assert.equal(parseCodexAppServerUserAgentVersion("moss_desktop (Linux)"), null);
    assert.equal(parseCodexAppServerUserAgentVersion("/0.163.0"), null);
    assert.equal(parseCodexAppServerUserAgentVersion(undefined), null);
  });

  it("gates the prediction fork on Codex desktop's experimentalPredictionForkMode floor", () => {
    assert.equal(MINIMUM_CODEX_PREDICTION_FORK_CLI_VERSION, "0.162.0-alpha.20");
    assert.ok(compareCodexCliVersions("0.162.0-alpha.19", "0.162.0-alpha.20") < 0);
    assert.ok(compareCodexCliVersions("0.161.9", "0.162.0-alpha.20") < 0);
    assert.equal(compareCodexCliVersions("0.162.0-alpha.20", "0.162.0-alpha.20"), 0);
    assert.ok(compareCodexCliVersions("0.162.0", "0.162.0-alpha.20") > 0);
    assert.ok(compareCodexCliVersions("0.163.0", "0.162.0-alpha.20") > 0);
  });

  it("names the continuation-safe minimum in upgrade guidance", () => {
    assert.equal(
      formatCodexCliUpgradeMessage("0.104.0"),
      "Codex CLI v0.104.0 is too old for Moss. Upgrade to v0.105.0 or newer and restart Moss.",
    );
  });

  it("provides fail-closed guidance when successful output has no verifiable version", () => {
    assert.equal(parseCodexCliVersion("Codex development build"), null);
    assert.equal(
      CODEX_CLI_UNPARSEABLE_VERSION_MESSAGE,
      "Codex CLI version check succeeded but returned an unrecognized version. Moss requires a verifiable v0.105.0 or newer installation; upgrade or reinstall Codex and restart Moss.",
    );
  });
});
