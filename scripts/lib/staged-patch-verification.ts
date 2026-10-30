// FILE: staged-patch-verification.ts
// Purpose: Parses unified patches and verifies their exact post-image hunks in staged dependencies.
// Layer: Release/build helper

export interface PatchHunkExpectation {
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly oldLines: ReadonlyArray<string>;
  readonly newLines: ReadonlyArray<string>;
}

export interface PatchFileExpectation {
  readonly sourceFile: string | null;
  readonly targetFile: string | null;
  readonly hunks: ReadonlyArray<PatchHunkExpectation>;
}

function normalizeNewlines(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function parsePatchPath(header: string): string | null {
  const raw = header.slice(4).split("\t", 1)[0]?.trim() ?? "";
  if (raw === "/dev/null") {
    return null;
  }
  return raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
}

function sameLines(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

export function parsePatchFileExpectations(
  patchContents: string,
): ReadonlyArray<PatchFileExpectation> {
  const files: PatchFileExpectation[] = [];
  const lines = normalizeNewlines(patchContents).split("\n");
  let pendingSourceFile: string | null | undefined;
  let current:
    | {
        sourceFile: string | null;
        targetFile: string | null;
        hunks: PatchHunkExpectation[];
      }
    | undefined;
  let currentHunk:
    | {
        header: string;
        oldStart: number;
        oldCount: number;
        newStart: number;
        newCount: number;
        oldLines: string[];
        newLines: string[];
      }
    | undefined;

  const finishHunk = () => {
    if (!currentHunk || !current) return;
    if (
      currentHunk.oldLines.length !== currentHunk.oldCount ||
      currentHunk.newLines.length !== currentHunk.newCount
    ) {
      throw new Error(
        `Malformed patch hunk ${currentHunk.header}: expected ${String(currentHunk.oldCount)}/${String(currentHunk.newCount)} old/new lines but parsed ${String(currentHunk.oldLines.length)}/${String(currentHunk.newLines.length)}.`,
      );
    }
    current.hunks.push(currentHunk);
    currentHunk = undefined;
  };

  const finishFile = () => {
    finishHunk();
    if (!current) return;
    if (current.hunks.length > 0) {
      files.push(current);
    }
    current = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finishFile();
      pendingSourceFile = undefined;
      continue;
    }
    if (!currentHunk && line.startsWith("--- ")) {
      finishFile();
      pendingSourceFile = parsePatchPath(line);
      continue;
    }
    if (!currentHunk && line.startsWith("+++ ")) {
      if (pendingSourceFile === undefined) {
        throw new Error(`Patch target header has no source header: ${line}`);
      }
      current = {
        sourceFile: pendingSourceFile,
        targetFile: parsePatchPath(line),
        hunks: [],
      };
      pendingSourceFile = undefined;
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (!current) {
        throw new Error(`Patch hunk has no file header: ${line}`);
      }
      finishHunk();
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) {
        throw new Error(`Unsupported patch hunk header: ${line}`);
      }
      currentHunk = {
        header: line,
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        oldLines: [],
        newLines: [],
      };
      continue;
    }
    if (!currentHunk || line === "\\ No newline at end of file") {
      continue;
    }
    if (line.startsWith(" ")) {
      const content = line.slice(1);
      currentHunk.oldLines.push(content);
      currentHunk.newLines.push(content);
    } else if (line.startsWith("+")) {
      currentHunk.newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      currentHunk.oldLines.push(line.slice(1));
    }
  }
  finishFile();
  return files;
}

export function assertPatchPostImage(
  expectation: PatchFileExpectation,
  stagedContents: string,
): void {
  if (expectation.targetFile === null) {
    throw new Error("Deleted patch targets must be verified as absent.");
  }
  const stagedLines = normalizeNewlines(stagedContents).split("\n");
  for (const hunk of expectation.hunks) {
    const startIndex = Math.max(0, hunk.newStart - 1);
    const actualPostImage = stagedLines.slice(startIndex, startIndex + hunk.newCount);
    if (!sameLines(actualPostImage, hunk.newLines)) {
      throw new Error(
        `${expectation.targetFile} does not match patched post-image ${hunk.header} at line ${String(hunk.newStart)}.`,
      );
    }
    if (
      hunk.newCount === 0 &&
      hunk.oldLines.length > 0 &&
      sameLines(stagedLines.slice(startIndex, startIndex + hunk.oldLines.length), hunk.oldLines)
    ) {
      throw new Error(
        `${expectation.targetFile} still contains the deleted pre-image ${hunk.header} at line ${String(hunk.newStart)}.`,
      );
    }
  }
}
