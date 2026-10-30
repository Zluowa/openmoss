import { DESKTOP_DIAGNOSTIC_ISSUE_PREFIX } from "@synara/contracts";
import type { BackendOutputDetector } from "./backendProcessOutput";

const LEGACY_DIAGNOSTIC_ISSUE_PREFIX = "SYNARA_DIAGNOSTIC_ISSUE ";
const READABLE_ISSUE_PREFIXES = [DESKTOP_DIAGNOSTIC_ISSUE_PREFIX, LEGACY_DIAGNOSTIC_ISSUE_PREFIX];

/** Bounded line framing only. The diagnostics collector validates the untrusted payload. */
export class BackendIssueDetector implements BackendOutputDetector {
  private readonly streams = {
    stdout: { line: "", oversized: false },
    stderr: { line: "", oversized: false },
  };
  constructor(private readonly report: (input: unknown) => void) {}

  push(chunk: Buffer, source: "stdout" | "stderr"): void {
    const state = this.streams[source];
    const text = chunk.toString("utf8");
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const end = newline < 0 ? text.length : newline;
      if (!state.oversized) {
        if (state.line.length + end - start > 2048) {
          state.line = "";
          state.oversized = true;
        } else state.line += text.slice(start, end);
      }
      if (newline < 0) return;
      const prefix = state.oversized
        ? undefined
        : READABLE_ISSUE_PREFIXES.find((prefix) => state.line.startsWith(prefix));
      if (prefix) {
        try {
          this.report(JSON.parse(state.line.slice(prefix.length)));
        } catch {
          /* Ordinary logs and malformed reports are not telemetry. */
        }
      }
      state.line = "";
      state.oversized = false;
      start = newline + 1;
    }
  }
}
