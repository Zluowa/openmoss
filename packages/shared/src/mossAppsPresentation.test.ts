import { describe, expect, it } from "vitest";

import { isMossAppsServer, mossAppsToolAction, mossAppsToolTitle } from "./mossAppsPresentation";

describe("Moss Apps tool presentation", () => {
  it("says what each backend meta-tool does", () => {
    expect(mossAppsToolTitle("COMPOSIO_SEARCH_TOOLS")).toBe("Moss Apps: Find app actions");
    expect(mossAppsToolAction("composio_multi_execute_tool")).toBe("Run app actions");
  });

  it("spells out an unknown tool without the backend's brand", () => {
    expect(mossAppsToolAction("COMPOSIO_LIST_TRIGGERS")).toBe("List triggers");
    expect(mossAppsToolAction("COMPOSIO_")).toBe("Use an app");
  });

  it("recognizes only the Moss Apps server", () => {
    expect(isMossAppsServer(" Moss_Apps ")).toBe(true);
    expect(isMossAppsServer("moss")).toBe(false);
    expect(isMossAppsServer(undefined)).toBe(false);
  });
});
