import { describe, expect, it } from "vitest";

import {
  codexJsonLogLineAsText,
  isCodexDiagnosticLogLine,
  isCodexDiagnosticWarningMessage,
} from "./codexDiagnostics";

const TRUST_NOTICE =
  "2026-10-28T16:34:29.269485Z ERROR codex_app_server: Project-local config, hooks, and exec policies are disabled in the following folders until the project is trusted, but skills still load.";

describe("Codex's untrusted-project notice", () => {
  it("goes to the server log, not the transcript", () => {
    expect(isCodexDiagnosticLogLine(TRUST_NOTICE)).toBe(true);
  });

  it("hides the notice and its detail rows saved before the fix", () => {
    for (const row of [
      TRUST_NOTICE,
      "1. D:\\ceshi\\moss-synara-unified-plugins-20261028\\.codex",
      "To load project-local config, hooks, and exec policies, add d:\\repo as a trusted project in E:\\Codex\\home\\config.toml.",
    ]) {
      expect(isCodexDiagnosticWarningMessage(row)).toBe(true);
    }
  });

  it("keeps other numbered lines and real failures", () => {
    expect(isCodexDiagnosticWarningMessage("1. Install the dependencies")).toBe(false);
    expect(
      isCodexDiagnosticLogLine(
        "2026-10-28T16:34:30.000000Z ERROR codex_core::runtime: unrecoverable failure",
      ),
    ).toBe(false);
  });
});

const record = (level: string, target: string, message: string, extra = {}) =>
  JSON.stringify({
    timestamp: "2026-10-28T20:18:28.100813Z",
    level,
    fields: { message, ...extra },
    target,
  });

describe("Codex's JSON log layout", () => {
  it("reads like the text layout", () => {
    expect(
      codexJsonLogLineAsText(
        record("WARN", "codex_otel::metrics", "credential storage file fallback completed", {
          credential_kind: "mcp",
        }),
      ),
    ).toBe(
      "2026-10-28T20:18:28.100813Z WARN codex_otel::metrics: credential storage file fallback completed credential_kind=mcp",
    );
    expect(codexJsonLogLineAsText('{"jsonrpc":"2.0","method":"turn/started"}')).toBeNull();
    expect(codexJsonLogLineAsText("plain text")).toBeNull();
  });

  it("keeps saved rows below ERROR and transport fallbacks out of the transcript", () => {
    expect(
      isCodexDiagnosticWarningMessage(
        record(
          "WARN",
          "codex_core::shell_snapshot",
          "Failed to create shell snapshot for powershell",
        ),
      ),
    ).toBe(true);
    expect(
      isCodexDiagnosticLogLine(
        record(
          "ERROR",
          "codex_api::endpoint::responses_websocket",
          "failed to connect to websocket: HTTP error: 426 Upgrade Required",
        ),
      ),
    ).toBe(true);
    expect(
      isCodexDiagnosticLogLine(
        record(
          "ERROR",
          "rmcp::transport::worker",
          "worker quit with fatal: Transport channel closed",
        ),
      ),
    ).toBe(true);
    expect(
      isCodexDiagnosticWarningMessage(
        "Codex couldn't save diagnostic logs to its local database. Use /feedback with logs included before closing Codex, or run `codex doctor` for diagnostics.",
      ),
    ).toBe(true);
    // An ERROR the user may need still reaches the transcript.
    expect(
      isCodexDiagnosticWarningMessage(
        record("ERROR", "codex_core::codex", "stream disconnected before completion"),
      ),
    ).toBe(false);
  });
});
