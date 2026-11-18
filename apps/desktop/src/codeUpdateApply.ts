// FILE: codeUpdateApply.ts
// Purpose: The apply step of a code update, run as a plain-Node child of the desktop
//          (dist-electron/codeUpdateApply.js under ELECTRON_RUN_AS_NODE). Electron's own `fs`
//          treats .asar files as folders; this process turns that off for itself, then reads the
//          installed archive and writes the new one as ordinary files.
// Layer: Desktop child entry. Input: a JSON file named by argv[2]. Output: one JSON line on stdout,
//        then an explicit exit: on this PC a child that had just written a ~380 MB archive lingered
//        95-170 s before exiting by itself (2026-11-18, cause not established).

import { readFile } from "node:fs/promises";

import { applyCodeUpdate, type CodeUpdateApplyReport } from "@moss/shared/codeUpdate";

import type { CodeUpdateApplyRequest } from "./codeUpdateClient";

(process as { noAsar?: boolean }).noAsar = true;

function answer(result: object, code: number): void {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(code));
}

async function main(): Promise<void> {
  const inputFile = process.argv[2];
  if (!inputFile) throw new Error("usage: codeUpdateApply.js <request.json>");
  const request = JSON.parse(await readFile(inputFile, "utf8")) as CodeUpdateApplyRequest;
  const report: CodeUpdateApplyReport = await applyCodeUpdate(request);
  answer({ ok: true, report }, 0);
}

main().catch((error: unknown) => {
  answer({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1);
});
