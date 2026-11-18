// FILE: screenReport.browser.tsx
// Purpose: `screen_report` says what a person sees: where the window is, its size and theme,
//          the dialogs and menus open with their titles, what has focus, and the visible text in
//          the order a person reads it, never a field's value or a secret.

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { screenReport } from "./screenReport";

beforeEach(async () => {
  await page.viewport(900, 600);
  document.body.style.margin = "0";
});
afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.classList.remove("dark");
});

describe("screen_report", () => {
  it("gives the route, the window size and the theme", () => {
    history.replaceState(null, "", "/mossbot?tab=rooms");
    document.documentElement.classList.add("dark");
    const report = screenReport();
    expect(report.route).toBe("/mossbot?tab=rooms");
    expect(report.window).toMatchObject({ width: 900, height: 600 });
    expect(report.window.dpr).toBeGreaterThan(0);
    expect(report.theme.mode).toBe("dark");
  });

  it("lists the open dialog and menu with their titles and boxes, and the focused control", () => {
    document.body.innerHTML = `
      <div id="dlg" role="dialog" aria-labelledby="t" style="position:fixed;left:100px;top:80px;width:400px;height:200px">
        <h2 id="t">Delete chat</h2>
        <button id="cancel">Cancel</button>
      </div>
      <div role="menu" aria-label="Chat actions" style="position:fixed;left:600px;top:80px;width:160px;height:90px"></div>
      <div role="dialog" aria-label="Hidden one" style="display:none"></div>`;
    (document.getElementById("cancel") as HTMLButtonElement).focus();
    const report = screenReport();
    expect(report.open).toEqual([
      {
        kind: "dialog",
        title: "Delete chat",
        selector: expect.any(String),
        rect: { x: 100, y: 80, width: 400, height: 200 },
      },
      {
        kind: "menu",
        title: "Chat actions",
        selector: expect.any(String),
        rect: { x: 600, y: 80, width: 160, height: 90 },
      },
    ]);
    expect(document.querySelector(report.open[0]!.selector)).toBe(document.getElementById("dlg"));
    expect(report.focused).toEqual({ selector: "#cancel", role: "button", name: "Cancel" });
  });

  it("reads visible text top to bottom, then left to right, whatever the DOM order", () => {
    document.body.innerHTML = `
      <div style="position:absolute;left:400px;top:300px">Third</div>
      <div style="position:absolute;left:300px;top:20px">Second</div>
      <div style="position:absolute;left:20px;top:22px">First</div>
      <div style="position:absolute;left:20px;top:900px">Below the window</div>
      <div style="position:absolute;left:20px;top:200px;visibility:hidden">Hidden</div>`;
    expect(screenReport().text).toBe("First Second\nThird");
  });

  it("never reads a field's value, a password, a secret or a hidden area", () => {
    document.body.innerHTML = `
      <label>Name <input value="draft text a person typed"></label>
      <input type="password" value="hunter2">
      <div data-agent-secret>sk-ish-value</div>
      <div data-agent-hidden>internal note</div>
      <p>Visible words</p>`;
    const text = screenReport().text;
    expect(text).toContain("Visible words");
    expect(text).toContain("[field: Name]");
    expect(text).toContain("[redacted]");
    for (const leaked of ["draft text", "hunter2", "sk-ish-value", "internal note"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("keeps to maxChars and says it cut", () => {
    document.body.innerHTML = Array.from({ length: 40 }, (_, i) => `<p>Line number ${i}</p>`).join(
      "",
    );
    const report = screenReport({ maxChars: 50 });
    expect(report.text.length).toBeLessThanOrEqual(50);
    expect(report.textTruncated).toBe(true);
  });
});
