import { describe, expect, it } from "vitest";

import type { ProviderInstanceId } from "@synara/contracts";

import { resolveThreadDisplayProvider } from "./threadDisplayProvider";

describe("resolveThreadDisplayProvider", () => {
  it("prefers the live session provider", () => {
    expect(
      resolveThreadDisplayProvider({
        session: { provider: "claudeAgent" },
        modelSelection: {
          instanceId: "codex_moss" as ProviderInstanceId,
          model: "gpt-5.6-sol",
        },
      }),
    ).toBe("claudeAgent");
  });

  it("infers a configured provider instance when no session is live", () => {
    expect(
      resolveThreadDisplayProvider({
        session: null,
        modelSelection: {
          instanceId: "codex_moss" as ProviderInstanceId,
          model: "gpt-5.6-sol",
        },
      }),
    ).toBe("codex");
  });

  it("falls back to model inference for legacy custom instance ids", () => {
    expect(
      resolveThreadDisplayProvider({
        modelSelection: {
          instanceId: "work" as ProviderInstanceId,
          model: "claude-opus-4-8",
        },
      }),
    ).toBe("claudeAgent");
  });
});
