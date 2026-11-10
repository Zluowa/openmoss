// FILE: providerMetadata.test.ts
// Purpose: Prevents broken same-origin setup paths from reaching native external navigation.
// Layer: Shared presentation metadata tests
import { describe, expect, it } from "vitest";
import { MOSS_OFFICIAL_SITE_URL } from "./desktopIdentity";
import { PROVIDER_DESCRIPTORS } from "./providerMetadata";

describe("agent setup guides", () => {
  it.each(PROVIDER_DESCRIPTORS)("gives $displayName an absolute HTTPS setup page", (provider) => {
    const guide = new URL(provider.setupDocsHref);
    expect(guide.protocol).toBe("https:");
    expect(guide.hostname.length).toBeGreaterThan(0);
    expect(guide.username).toBe("");
    expect(guide.password).toBe("");
  });
  it("opens Moss's official site for every agent's guide and usage link, never a vendor page", () => {
    for (const provider of PROVIDER_DESCRIPTORS) {
      expect(provider.setupDocsHref).toBe(MOSS_OFFICIAL_SITE_URL);
      expect(provider.usage?.learnMoreHref ?? MOSS_OFFICIAL_SITE_URL).toBe(MOSS_OFFICIAL_SITE_URL);
    }
  });
});
