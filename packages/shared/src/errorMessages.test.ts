import { describe, expect, it } from "vitest";

import {
  collectErrorMessages,
  describeErrorMessage,
  isCleanSocketCloseError,
  sanitizeUserFacingErrorMessage,
} from "./errorMessages";

describe("errorMessages", () => {
  it("keeps the provider error reason without multiline or inline stack frames", () => {
    expect(
      sanitizeUserFacingErrorMessage(
        "Error: quota exceeded\n    at send (/app/send.ts:2:1)",
        "fallback",
      ),
    ).toBe("Error: quota exceeded");
    expect(
      sanitizeUserFacingErrorMessage("Connection refused at file:///app/send.ts:2:1", "fallback"),
    ).toBe("Connection refused");
    expect(
      sanitizeUserFacingErrorMessage("Request failed at send (/app/send.ts:2:1)", "fallback"),
    ).toBe("Request failed");
    expect(
      sanitizeUserFacingErrorMessage(
        "Request failed at async send (C:\\app\\send.ts:2:1)",
        "fallback",
      ),
    ).toBe("Request failed");
    expect(sanitizeUserFacingErrorMessage("Rate limit resets at noon", "fallback")).toBe(
      "Rate limit resets at noon",
    );
    expect(sanitizeUserFacingErrorMessage(" \n ", "fallback")).toBe("fallback");
  });
  it("uses Error messages", () => {
    expect(describeErrorMessage(new Error("native binding missing"), "fallback")).toBe(
      "native binding missing",
    );
  });

  it("uses serialized RPC error messages", () => {
    expect(
      describeErrorMessage(
        { _tag: "WsRpcError", message: "Project directory does not exist" },
        "fallback",
      ),
    ).toBe("Project directory does not exist");
  });

  it("includes nested causes without duplicating messages", () => {
    expect(
      describeErrorMessage(
        {
          message: "Failed to load node-pty native module",
          cause: { message: "Cannot find module 'pty.node'" },
        },
        "fallback",
      ),
    ).toBe("Failed to load node-pty native module: Cannot find module 'pty.node'");
  });

  it("avoids cycles in cause chains", () => {
    const error: { message: string; cause?: unknown } = { message: "outer" };
    error.cause = error;

    expect(collectErrorMessages(error)).toEqual(["outer"]);
  });

  it("falls back when no useful message is present", () => {
    expect(describeErrorMessage({ ok: false }, "Failed to open terminal")).toBe(
      "Failed to open terminal",
    );
  });

  it("recognizes Effect and browser clean WebSocket closes", () => {
    expect(isCleanSocketCloseError(new Error("SocketCloseError: 1000"))).toBe(true);
    expect(
      isCleanSocketCloseError({
        _tag: "SocketError",
        cause: { _tag: "SocketCloseError", code: 1000 },
      }),
    ).toBe(true);
    expect(isCleanSocketCloseError({ name: "CloseEvent", code: 1000, wasClean: true })).toBe(true);
  });

  it("does not hide non-clean socket failures", () => {
    expect(isCleanSocketCloseError(new Error("SocketCloseError: 1006"))).toBe(false);
    expect(isCleanSocketCloseError({ _tag: "SocketCloseError", code: 1001 })).toBe(false);
    expect(isCleanSocketCloseError(new Error("pty start failed"))).toBe(false);
  });
});
