import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// `library.importFiles` sends base64 through the WebSocket, whose 2 MiB message cap stops files of
// about 1.5 MB. Every web uploader into 资料库 goes through `~/lib/libraryUpload` instead.
const SRC = fileURLToPath(new URL("..", import.meta.url));
const IS_TEST = /\.(test|browser)\.tsx?$|[\\/]test[\\/]/u;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/u.test(entry.name) && !IS_TEST.test(path) ? [path] : [];
  });
}

describe("资料库 uploads", () => {
  it("never send file bytes through the WebSocket library.importFiles", () => {
    const callers = sources(SRC)
      .filter((path) => /\blibrary\.importFiles\s*\(/u.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).replaceAll("\\", "/"));
    expect(callers).toEqual([]);
  });
});
