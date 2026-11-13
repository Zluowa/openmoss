// FILE: dashboardCompile.ts
// Purpose: Syntax check for a 数据看板 page script without running it (moss_dashboard_read/write).
// Layer: Agent gateway helper
// Exports: compileCheck

import { Script } from "node:vm";

/** Null when the script compiles; otherwise the parser's message. The code never runs. */
export function compileCheck(code: string): string | null {
  try {
    // Page scripts run as function bodies in the frame, so a top-level return is allowed.
    new Script(`(function(){\n${code}\n})`, { filename: "page-script.js" });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "syntax error";
  }
}
