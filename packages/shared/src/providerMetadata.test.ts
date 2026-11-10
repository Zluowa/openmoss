// FILE: providerMetadata.test.ts
// Purpose: Prevents broken same-origin setup paths from reaching native external navigation.
// Layer: Shared presentation metadata tests
import { describe, expect, it } from "vitest";
import { PROVIDER_DESCRIPTORS } from "./providerMetadata";

describe("agent setup guides", () => {
  it.each(PROVIDER_DESCRIPTORS)("gives $displayName an absolute HTTPS setup page", (provider) => {
    const guide = new URL(provider.setupDocsHref);
    expect(guide.protocol).toBe("https:");
    expect(guide.hostname.length).toBeGreaterThan(0);
    expect(guide.username).toBe("");
    expect(guide.password).toBe("");
  });
  it("opens the verified Cursor CLI documentation instead of a missing Moss route", () => {
    expect(PROVIDER_DESCRIPTORS.find((provider) => provider.kind === "cursor")?.setupDocsHref).toBe(
      "https://cursor.com/docs/cli/overview",
    );
  });
});
