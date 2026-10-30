import { describe, expect, it } from "vitest";
import { discoveryFailureCode } from "./discoveryFailureCode";

describe("discoveryFailureCode", () => {
  it("finds the native cause without exporting the error payload", () => {
    const error = new Error("provider request failed with token=private-test-token", {
      cause: Object.assign(new Error("symlink at private path"), { code: "EPERM" }),
    });
    expect(discoveryFailureCode(error)).toBe("EPERM");
    expect(
      discoveryFailureCode({ code: "private-test-token", message: "private-test-token" }),
    ).toBe("DISCOVERY_FAILED");
  });

  it.each([
    ["chatgpt authentication required", "REMOTE_AUTH_REQUIRED"],
    ["executable version probe failed", "BUNDLED_RUNTIME_UNAVAILABLE"],
    ["Codex must report its runtime home", "RUNTIME_HOME_MISSING"],
    ["The official Moss plugin test did not finish installing.", "BUNDLED_PLUGIN_BOOTSTRAP_FAILED"],
    ["Codex authentication changed during launch", "ACCOUNT_CHANGED"],
    ["managed home authority is unavailable", "MANAGED_HOME_AUTHORITY_FAILED"],
    ["Provider process tree 123 did not prove exit (rootExited=true)", "PROCESS_EXIT_UNPROVEN"],
    [
      "Codex account runtime generation was revoked before discovery launch.",
      "RUNTIME_GENERATION_REVOKED",
    ],
  ])("classifies %s", (message, code) => {
    expect(discoveryFailureCode(new Error(message))).toBe(code);
  });

  it("bounds cyclic causes and refuses throwing properties", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(discoveryFailureCode(cyclic)).toBe("DISCOVERY_FAILED");
    expect(
      discoveryFailureCode({
        get code() {
          throw new Error("private-test-token");
        },
      }),
    ).toBe("DISCOVERY_FAILED");
  });
});
