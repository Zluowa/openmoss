import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("desktop voice production wiring", () => {
  it("routes IPC fallback through the local backend without public provider credentials", () => {
    const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

    expect(mainSource).toContain("transcribeViaMossBackend: (input) =>");
    expect(mainSource).toContain("requestDesktopBackendVoiceTranscription(input, {");
    expect(mainSource).toContain("backendHttpUrl,");
    expect(mainSource).toContain("backendAuthToken,");
    expect(mainSource).not.toContain("MOSS_OPENROUTER_API_KEY");
    expect(mainSource).not.toContain("MOSS_BYOK_API_KEY");
  });
});
