import { describe, expect, it } from "vitest";

import { providerDocLabelKey } from "./_chat.settings";

describe("providerDocLabelKey", () => {
  it("maps every Antigravity documentation label to its typed translation key", () => {
    expect(providerDocLabelKey("Install")).toBe("settings.providers.docs.install");
    expect(providerDocLabelKey("Reference")).toBe("settings.providers.docs.reference");
    expect(providerDocLabelKey("Hooks")).toBe("settings.providers.docs.hooks");
  });

  it("keeps the generic docs fallback for unknown labels", () => {
    expect(providerDocLabelKey("Vendor guide")).toBe("settings.providers.docs.title");
  });
});
