// FILE: moss-canvas-source-pin.ts
// Purpose: Verify immutable Canvas source and the complete packaged bundle.
// Layer: Release/build helper
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateMossCanvasBundle, MOSS_CANVAS_BUNDLE_RECEIPT } from "./bundled-moss-canvas.ts";

export interface MossCanvasSourcePin {
  readonly repository: "Zluowa/open-hoola-canvas";
  readonly commit: string;
  readonly tree: string;
  readonly lockfileSha256: string;
}
export const MOSS_CANVAS_SOURCE_PIN_FILE = "scripts/lib/moss-canvas-source-pin.json";
export function readMossCanvasSourcePin(repositoryRoot: string): MossCanvasSourcePin {
  const value: unknown = JSON.parse(
    readFileSync(join(repositoryRoot, MOSS_CANVAS_SOURCE_PIN_FILE), "utf8"),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Moss Canvas source pin is invalid");
  const pin = value as Record<string, unknown>;
  if (
    pin.repository !== "Zluowa/open-hoola-canvas" ||
    typeof pin.commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(pin.commit) ||
    typeof pin.tree !== "string" ||
    !/^[a-f0-9]{40}$/u.test(pin.tree) ||
    typeof pin.lockfileSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(pin.lockfileSha256)
  )
    throw new Error("Moss Canvas source pin is invalid");
  return pin as unknown as MossCanvasSourcePin;
}
export function canvasLockfileSha256(sourceDirectory: string): string {
  return createHash("sha256")
    .update(readFileSync(join(sourceDirectory, "package-lock.json")))
    .digest("hex");
}
export function validatePinnedMossCanvasBundle(directory: string, pin: MossCanvasSourcePin) {
  const validation = validateMossCanvasBundle(directory);
  const receipt = JSON.parse(readFileSync(join(directory, MOSS_CANVAS_BUNDLE_RECEIPT), "utf8")) as {
    sha256?: unknown;
    fileCount?: unknown;
    sourcePin?: Record<string, unknown>;
  };
  if (receipt.sha256 !== validation.sha256 || receipt.fileCount !== validation.fileCount)
    throw new Error("Moss Canvas bundle does not match its build receipt");
  if (
    !receipt.sourcePin ||
    ["repository", "commit", "tree", "lockfileSha256"].some(
      (key) => receipt.sourcePin?.[key] !== pin[key as keyof MossCanvasSourcePin],
    )
  )
    throw new Error("Moss Canvas bundle does not match the pinned source");
  return validation;
}
