import { describe, expect, it } from "vitest";
import { guestAppPreviewOrigin } from "./guestAppPreviewAvailability";

const owner = { protocolVersion: 1 as const, contentOrigin: "https://apps.example" };
describe("guest preview availability", () => {
  it("requires all three current capabilities to agree", () => {
    expect(
      guestAppPreviewOrigin(owner, owner, [owner.contentOrigin], "https://share.example"),
    ).toBe(owner.contentOrigin);
    expect(
      guestAppPreviewOrigin(undefined, owner, [owner.contentOrigin], "https://share.example"),
    ).toBeNull();
    expect(
      guestAppPreviewOrigin(owner, null, [owner.contentOrigin], "https://share.example"),
    ).toBeNull();
    for (const prepared of [
      [],
      ["https://wrong.example"],
      [owner.contentOrigin, owner.contentOrigin],
    ])
      expect(guestAppPreviewOrigin(owner, owner, prepared, "https://share.example")).toBeNull();
    expect(
      guestAppPreviewOrigin(
        owner,
        { ...owner, contentOrigin: "https://wrong.example" },
        [owner.contentOrigin],
        "https://share.example",
      ),
    ).toBeNull();
  });
  it.each([
    "https://share.example:444",
    "http://apps.example",
    "https://apps.example/path",
    "https://apps.example?token=x",
    "https://apps.example#x",
    "https://user@apps.example",
    "javascript:alert(1)",
  ])("rejects unsafe or non-independent source %s", (contentOrigin) => {
    const capability = { ...owner, contentOrigin };
    expect(
      guestAppPreviewOrigin(capability, capability, [contentOrigin], "https://share.example"),
    ).toBeNull();
  });
  it("permits exactly the explicit two-host loopback development fixture", () => {
    const capability = { ...owner, contentOrigin: "http://localhost:53842" };
    expect(
      guestAppPreviewOrigin(
        capability,
        capability,
        [capability.contentOrigin],
        "http://127.0.0.1:53842",
      ),
    ).toBe(capability.contentOrigin);
    expect(
      guestAppPreviewOrigin(
        capability,
        capability,
        [capability.contentOrigin],
        "http://foo.localhost:53842",
      ),
    ).toBeNull();
  });
});
