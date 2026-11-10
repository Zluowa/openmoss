import { describe, expect, it } from "vitest";

import {
  codexJsonLogLineAsText,
  isCodexDiagnosticLogLine,
  isCodexDiagnosticWarningMessage,
  isCodexLogRecord,
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
    // The turn reports a dropped stream itself, through Codex's `error` notification.
    expect(
      isCodexDiagnosticWarningMessage(
        record("ERROR", "codex_core::codex", "stream disconnected before completion"),
      ),
    ).toBe(true);
  });
});

describe("Codex's log records", () => {
  // What a fresh Moss profile's first Codex turn logged while another Codex held the skills folder.
  const firstTurnRecords = [
    "2026-11-03T10:12:07.871469Z ERROR codex_skills_extension::host_service: failed to install system skills: io error while remove existing system skills dir: 拒绝访问。 (os error 5)",
    "2026-11-03T10:12:23.447836Z ERROR codex_skills_extension::loader::host: failed to scan skill path file:///E:/Codex/home/skills/.system/openai-docs/agents: (os error 3)",
    "2026-02-08T04:24:20.085687Z ERROR codex_core::runtime: unrecoverable failure",
    "2026-02-08T04:24:19.241256Z  WARN codex_core::features: unknown feature key in config: skills",
  ];

  it("are Codex's own log at every level, never transcript rows", () => {
    for (const line of firstTurnRecords) {
      expect(isCodexLogRecord(line)).toBe(true);
      expect(isCodexDiagnosticWarningMessage(line)).toBe(true);
    }
  });

  it("leave plain messages and Moss's restated errors in the transcript", () => {
    for (const message of [
      "fatal: permission denied",
      "Tool call failed because the same argument was sent twice (yield_time_ms).",
      "Reconnecting... 2/5",
    ]) {
      expect(isCodexLogRecord(message)).toBe(false);
      expect(isCodexDiagnosticWarningMessage(message)).toBe(false);
    }
  });
});
