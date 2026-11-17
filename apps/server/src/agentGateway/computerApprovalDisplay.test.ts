import { describe, expect, it } from "vitest";

import { computerApprovalDisplayArgs } from "./computerApprovalDisplay.ts";

describe("computerApprovalDisplayArgs", () => {
  it("shows step types without persisting nested typed values or credentials", () => {
    const display = computerApprovalDisplayArgs({
      app: "Safari",
      steps: [
        { type: "type_text", text: "private typed text" },
        { type: "set_value", value: "private value" },
        { type: "click", x: 8, y: 12 },
      ],
      headers: { Authorization: "Bearer private-token" },
      prompt_text: "private prompt",
    });

    expect(display).toEqual([
      { name: "app", value: "Safari" },
      { name: "steps", value: '{"count":3,"types":["type_text","set_value","click"]}' },
    ]);
    expect(JSON.stringify(display)).not.toMatch(/private|Bearer|Authorization/);
  });

  // The pending approval card reads `toolParamsDisplay` only as `{ name, value }` rows; a
  // JSON string (what this returned until 2026-11-17) left every Computer card without
  // the action's parameters.
  it("gives the approval card name/value rows it can show", () => {
    const display = computerApprovalDisplayArgs({ app: "Finder", x: 120, y: 48, button: "left" });
    expect(Array.isArray(display)).toBe(true);
    expect(display).toEqual([
      { name: "app", value: "Finder" },
      { name: "x", value: "120" },
      { name: "y", value: "48" },
      { name: "button", value: "left" },
    ]);
  });
});
