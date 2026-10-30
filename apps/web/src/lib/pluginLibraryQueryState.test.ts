import { describe, expect, it } from "vitest";

import {
  pluginLibraryErrorMessage,
  resolvePluginLibraryQueryState,
} from "./pluginLibraryQueryState";

describe("resolvePluginLibraryQueryState", () => {
  it("keeps loading, error, empty, and ready as separate states", () => {
    expect(resolvePluginLibraryQueryState({ isLoading: true, error: null, itemCount: 0 })).toBe(
      "loading",
    );
    expect(
      resolvePluginLibraryQueryState({
        isLoading: false,
        error: new Error("provider unavailable"),
        itemCount: 0,
      }),
    ).toBe("error");
    expect(resolvePluginLibraryQueryState({ isLoading: false, error: null, itemCount: 0 })).toBe(
      "empty",
    );
    expect(resolvePluginLibraryQueryState({ isLoading: false, error: null, itemCount: 2 })).toBe(
      "ready",
    );
  });

  it("preserves already loaded rows when only a background refetch fails", () => {
    expect(
      resolvePluginLibraryQueryState({
        isLoading: false,
        error: new Error("refetch failed"),
        itemCount: 2,
      }),
    ).toBe("ready");
  });
});

describe("pluginLibraryErrorMessage", () => {
  it("reads useful Error, string, and structured messages", () => {
    expect(pluginLibraryErrorMessage(new Error("  Network unavailable  "))).toBe(
      "Network unavailable",
    );
    expect(pluginLibraryErrorMessage("  Request failed  ")).toBe("Request failed");
    expect(pluginLibraryErrorMessage({ message: "  Provider timed out  " })).toBe(
      "Provider timed out",
    );
  });

  it("returns null for errors without a safe display message", () => {
    expect(pluginLibraryErrorMessage(null)).toBeNull();
    expect(pluginLibraryErrorMessage({ code: "E_UNKNOWN" })).toBeNull();
  });

  it("does not expose provider transport or authentication internals", () => {
    expect(
      pluginLibraryErrorMessage(
        new Error(
          "Provider adapter request failed (codex) for plugin/list: chatgpt authentication required for remote plugin catalog",
        ),
      ),
    ).toBeNull();
  });
});
