// FILE: fieldFont.browser.tsx
// Purpose: One UI font and two weights, as a person sees them: fields and prompt boxes in the UI
//          font, mono only for code, headings outside page/dialog titles at the medium weight,
//          and Chinese in the terminal drawn in the UI's Chinese face rather than a Song fallback.
// Layer: Browser UI test (global stylesheet + shared parts)

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { DeviceSetupScreen } from "~/components/device/DeviceScreenStates";
import { getTerminalFontFamily } from "~/components/terminal/terminalRuntimeAppearance";
import { EmptyTitle } from "./empty";

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.classList.remove("dark");
});

function family(selector: string): string {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return getComputedStyle(element).fontFamily;
}

function weight(element: Element | null): number {
  if (!element) throw new Error("missing element");
  return Number.parseFloat(getComputedStyle(element).fontWeight);
}

it("draws plain fields and prompt boxes in the UI font, code in mono", async () => {
  await render(
    <div>
      <textarea data-probe="prompt" placeholder="说说你想做什么" />
      <input data-probe="field" placeholder="名称" />
      <input data-probe="code-field" className="font-mono" defaultValue="#2a78d6" />
      <code data-probe="code">npm run build</code>
      <pre data-probe="pre">const a = 1;</pre>
      <p data-probe="text">正文</p>
    </div>,
  );
  const ui = family("[data-probe=text]");
  const mono = family("[data-probe=code]");
  expect(mono).not.toBe(ui);
  expect(mono).toMatch(/JetBrains Mono/);
  expect(family("[data-probe=prompt]")).toBe(ui);
  expect(family("[data-probe=field]")).toBe(ui);
  expect(family("[data-probe=pre]")).toBe(mono);
  expect(family("[data-probe=code-field]")).toMatch(/mono/i);
});

it("uses the medium weight for empty-state and device screen titles, not semibold", async () => {
  await render(
    <div style={{ width: 320, height: 400 }}>
      <EmptyTitle data-probe="empty-title">还没有内容</EmptyTitle>
      <DeviceSetupScreen title="连接手机" description="" steps={[]} />
    </div>,
  );
  const semibold = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--font-weight-semibold"),
  );
  const emptyTitle = document.querySelector("[data-probe=empty-title]");
  expect(emptyTitle!.getBoundingClientRect().height).toBeGreaterThan(0);
  expect(weight(emptyTitle)).toBeLessThan(semibold);
  const deviceTitle = [...document.querySelectorAll("h3")].find(
    (h) => h.textContent === "连接手机",
  );
  expect(weight(deviceTitle ?? null)).toBeLessThan(semibold);
});

it.each(["light", "dark"] as const)(
  "draws Chinese in the terminal with the UI's Chinese face (%s)",
  async (mode) => {
    document.documentElement.classList.toggle("dark", mode === "dark");
    const terminalStack = getTerminalFontFamily();
    // A Chinese sans face comes before the generic fallback, so no Song face is picked.
    const cjkAt = terminalStack.search(/Microsoft YaHei|PingFang SC|Noto Sans CJK SC/);
    expect(cjkAt).toBeGreaterThan(-1);
    expect(cjkAt).toBeLessThan(terminalStack.lastIndexOf("monospace"));

    const sample = "终端里的中文输出";
    await render(
      <div style={{ padding: 16, fontSize: 16 }}>
        <span data-probe="terminal" style={{ fontFamily: "var(--terminal-font-family)" }}>
          {sample}
        </span>
        <br />
        <span data-probe="ui">{sample}</span>
      </div>,
    );
    const terminalProbe = document.querySelector<HTMLElement>("[data-probe=terminal]")!;
    expect(terminalProbe.getBoundingClientRect().width).toBeGreaterThan(0);
    // What Moss controls (the glyph widths depend on the fonts a machine has installed): the
    // terminal text resolves to a stack whose Chinese faces are the UI's own, in the UI's order,
    // all ahead of the generic monospace fallback that would pick a Song face.
    const cjkFaces = (stack: string) =>
      stack
        .split(",")
        .map((face) => face.trim().replace(/^["']|["']$/g, ""))
        .filter((face) => /YaHei|PingFang|CJK/.test(face));
    const resolvedTerminal = getComputedStyle(terminalProbe).fontFamily;
    const resolvedUi = getComputedStyle(document.querySelector("[data-probe=ui]")!).fontFamily;
    const terminalCjk = cjkFaces(resolvedTerminal);
    expect(terminalCjk.length).toBeGreaterThan(0);
    const uiCjk = cjkFaces(resolvedUi);
    expect(uiCjk.filter((face) => terminalCjk.includes(face))).toEqual(terminalCjk);
    const lastCjk = resolvedTerminal.lastIndexOf(terminalCjk.at(-1)!);
    expect(lastCjk).toBeLessThan(resolvedTerminal.lastIndexOf("monospace"));
    await page.screenshot({ path: `__screenshots__/one-look/terminal-chinese-${mode}.png` });
  },
);
