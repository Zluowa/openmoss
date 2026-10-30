import { describe, expect, it } from "vitest";

import { resolveCanonicalFilesystemHelperTestArch } from "./mossCanonicalFilesystemHelperTestRuntime.ts";

describe("canonical filesystem helper test runtime", () => {
  it("runs native helper suites only on a supported macOS architecture", () => {
    expect(resolveCanonicalFilesystemHelperTestArch("darwin", "arm64")).toBe("arm64");
    expect(resolveCanonicalFilesystemHelperTestArch("darwin", "x64")).toBe("x64");
    expect(resolveCanonicalFilesystemHelperTestArch("linux", "arm64")).toBeNull();
    expect(resolveCanonicalFilesystemHelperTestArch("win32", "x64")).toBeNull();
    expect(resolveCanonicalFilesystemHelperTestArch("darwin", "riscv64")).toBeNull();
  });
});
