import { describe, expect, it } from "vitest";

import { computerHostPlatformName, resolveComputerHostPlatform } from "./computerHostPlatform";

describe("resolveComputerHostPlatform", () => {
  it("prefers the host the server reports over the window's own platform", () => {
    expect(resolveComputerHostPlatform({ hostPlatform: "darwin" }, "Win32")).toBe("darwin");
    expect(resolveComputerHostPlatform({ hostPlatform: "win32" }, "MacIntel")).toBe("win32");
    expect(resolveComputerHostPlatform({ hostPlatform: "linux" }, "Win32")).toBe("linux");
  });

  it("falls back to the window's platform only for servers that predate the field", () => {
    expect(resolveComputerHostPlatform({}, "Win32")).toBe("win32");
    expect(resolveComputerHostPlatform(undefined, "MacIntel")).toBe("darwin");
    expect(resolveComputerHostPlatform(undefined, "Linux x86_64")).toBe("linux");
    expect(resolveComputerHostPlatform(undefined, "")).toBeNull();
  });

  it("names each host for people", () => {
    expect(computerHostPlatformName("darwin")).toBe("macOS");
    expect(computerHostPlatformName("win32")).toBe("Windows");
    expect(computerHostPlatformName("linux")).toBe("Linux");
    expect(computerHostPlatformName(null)).toBeNull();
  });
});
