import { describe, expect, it } from "vitest";
import { buildCliclickArgs, dispatchDarwinCuaInput } from "./darwinCuaInput";

describe("buildCliclickArgs", () => {
  it("builds left click at screen coords", () => {
    expect(buildCliclickArgs({ action: "click", x: 100.4, y: 200.6 })).toEqual({
      ok: true,
      kind: "hid",
      args: ["c:100,201"],
    });
  });

  it("builds double click and right click", () => {
    expect(buildCliclickArgs({ action: "double_click", x: 1, y: 2 })).toEqual({
      ok: true,
      kind: "hid",
      args: ["c:1,2", "c:1,2"],
    });
    expect(buildCliclickArgs({ action: "right_click", x: 3, y: 4 })).toEqual({
      ok: true,
      kind: "hid",
      args: ["rc:3,4"],
    });
  });

  it("builds type and key", () => {
    expect(buildCliclickArgs({ action: "type", text: "hi there" })).toEqual({
      ok: true,
      kind: "hid",
      args: ["t:hi there"],
    });
    expect(buildCliclickArgs({ action: "press_key", key: "return" })).toEqual({
      ok: true,
      kind: "hid",
      args: ["kp:return"],
    });
  });

  it("keeps dry-run non-HID", () => {
    expect(buildCliclickArgs({ action: "bounded-dry-run" })).toEqual({
      ok: true,
      kind: "dry-run",
      args: [],
    });
  });

  it("rejects click without coords", () => {
    expect(buildCliclickArgs({ action: "click" }).ok).toBe(false);
  });
});

describe("dispatchDarwinCuaInput", () => {
  it("refuses non-darwin platforms", async () => {
    await expect(
      dispatchDarwinCuaInput({ action: "click", x: 1, y: 2 }, { platform: "linux" }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("dry-run does not require cliclick", async () => {
    await expect(
      dispatchDarwinCuaInput(
        { action: "bounded-dry-run" },
        {
          platform: "darwin",
          whichCliclick: async () => undefined,
        },
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it("fails honestly when cliclick is missing", async () => {
    await expect(
      dispatchDarwinCuaInput(
        { action: "click", x: 1, y: 2 },
        {
          platform: "darwin",
          whichCliclick: async () => undefined,
        },
      ),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining("cliclick") });
  });

  it("invokes runCliclick with built args", async () => {
    const calls: Array<{ bin: string; args: readonly string[] }> = [];
    await expect(
      dispatchDarwinCuaInput(
        { action: "type_text", text: "moss" },
        {
          platform: "darwin",
          whichCliclick: async () => "/opt/homebrew/bin/cliclick",
          runCliclick: async (bin, args) => {
            calls.push({ bin, args });
            return { ok: true, message: "ok", command: [bin, ...args] };
          },
        },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual([{ bin: "/opt/homebrew/bin/cliclick", args: ["t:moss"] }]);
  });
});
