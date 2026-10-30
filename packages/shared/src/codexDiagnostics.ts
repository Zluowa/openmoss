// FILE: codexDiagnostics.ts
// Purpose: Recognizes Codex app-server diagnostics that belong in the server log, not the
//   transcript: background auth/model-list/MCP-transport retries and config-parsing notices.
// Layer: Shared provider presentation policy (server stderr routing + web replay of old rows)

// Codex's own background subsystems log every retry on stderr. Codex reports the
// user-relevant outcome through the turn itself (a failed turn carries the auth error),
// and neither the Codex CLI nor its desktop app shows these lines. A refused Responses
// WebSocket is the same kind of line: Codex falls back to HTTP on its own.
const CODEX_DIAGNOSTIC_LOG_TARGET_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+\w+\s+(codex_login::|codex_models_manager::|rmcp::transport::|codex_api::endpoint::responses_websocket\b)/;

const CODEX_LOG_LEVELS = new Set(["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]);
const CODEX_TEXT_LOG_LEVEL_REGEX = /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s/;

/**
 * Codex can log through tracing's JSON formatter instead of its text layout:
 * `{"timestamp":"…Z","level":"WARN","fields":{"message":"…"},"target":"codex_core::…"}`.
 * Returns that line in the text layout (`<timestamp> WARN <target>: <message> key=value`),
 * so one set of rules reads both, or null when the line is not a Codex log record.
 */
export function codexJsonLogLineAsText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const { timestamp, level, target, fields } = record as Record<string, unknown>;
  if (typeof timestamp !== "string" || typeof level !== "string" || typeof target !== "string") {
    return null;
  }
  const upperLevel = level.toUpperCase();
  if (!CODEX_LOG_LEVELS.has(upperLevel) || !fields || typeof fields !== "object") return null;
  const { message, ...extra } = fields as Record<string, unknown>;
  if (typeof message !== "string") return null;
  const extras = Object.entries(extra).map(
    ([name, value]) => `${name}=${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
  return [`${timestamp} ${upperLevel} ${target}: ${message}`, ...extras].join(" ");
}

const CODEX_CONFIG_DIAGNOSTIC_REGEXES = [
  /\bCodex is ignoring \d+ unrecognized configuration settings?\b/i,
  /^user \(.+config\.toml\): .+ is ignored\.$/i,
  // An untrusted project's `.codex` config is skipped; Codex carries on.
  /\bare disabled in the following folders until the project is trusted\b/i,
];

// That notice's detail lines (a numbered `.codex` folder, then how to trust it).
// Live stderr drops them with their entry; rows saved before that need these.
const CODEX_CONFIG_DIAGNOSTIC_DETAIL_REGEXES = [
  /^\d+\.\s+\S.*[\\/]\.codex$/,
  /^To load project-local config, hooks, and exec policies, add .+ as a trusted project in .+$/i,
];

// The same diagnostics also arrive as `warning` notifications; a transport fallback is
// Codex recovering on its own, not something the user can act on. Neither is Codex's own
// log database failing to write (its advice points at Codex's /feedback and CLI).
const CODEX_DIAGNOSTIC_WARNING_REGEXES = [
  ...CODEX_CONFIG_DIAGNOSTIC_REGEXES,
  ...CODEX_CONFIG_DIAGNOSTIC_DETAIL_REGEXES,
  /^Falling back from WebSockets to HTTPS transport\b/i,
  /^Codex couldn't save diagnostic logs to its local database\b/i,
];

const CODEX_LOG_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\S+\s+/;

/** A single stderr line (ANSI already stripped) that only belongs in the server log. */
export function isCodexDiagnosticLogLine(line: string): boolean {
  const trimmed = codexJsonLogLineAsText(line) ?? line.trim();
  return (
    CODEX_DIAGNOSTIC_LOG_TARGET_REGEX.test(trimmed) ||
    CODEX_CONFIG_DIAGNOSTIC_REGEXES.some((pattern) => pattern.test(trimmed))
  );
}

/** A `warning` notification message (or a replayed stderr row) the transcript skips. */
export function isCodexDiagnosticWarningMessage(message: string): boolean {
  const trimmed = message.trim();
  // The live stderr path keeps only ERROR records; rows saved before it read the
  // JSON layout still hold the rest.
  const level = CODEX_TEXT_LOG_LEVEL_REGEX.exec(codexJsonLogLineAsText(trimmed) ?? "")?.[1];
  if (level !== undefined && level !== "ERROR") return true;
  return (
    isCodexDiagnosticLogLine(trimmed) ||
    CODEX_DIAGNOSTIC_WARNING_REGEXES.some((pattern) => pattern.test(trimmed))
  );
}

/** Stable key for a log line, so a retry loop logs each distinct diagnostic once. */
export function codexDiagnosticLogKey(line: string): string {
  return line.trim().replace(CODEX_LOG_TIMESTAMP_REGEX, "");
}
