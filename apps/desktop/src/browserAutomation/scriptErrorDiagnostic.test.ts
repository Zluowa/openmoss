import { describe, expect, it } from "vitest";

import { describeScriptFailure } from "./scriptErrorDiagnostic";

const timeout = (locator: string) =>
  `locator.click: Timeout 1500ms exceeded.\nCall log:\n\u001b[2m  - waiting for ${locator}\u001b[22m\n`;

describe("describeScriptFailure", () => {
  it("names the timed-out locator when the script wrote its text", () => {
    expect(
      describeScriptFailure(
        timeout("getByRole('button', { name: 'Reveal access code' })"),
        'await human.click(page.getByRole("button",{name:"Reveal access code"}))',
      ),
    ).toMatch(
      /^locator\.click timed out after 1500ms waiting for getByRole\('button', \{ name: 'Reveal access code' \}\)\./u,
    );
  });

  it("drops a locator whose text the script never wrote", () => {
    const detail = describeScriptFailure(
      timeout("getByText('hunter2-secret')"),
      "await page.getByText(name).click()",
    );
    expect(detail).toMatch(/^locator\.click timed out after 1500ms\./u);
    expect(detail).not.toContain("hunter2-secret");
  });

  it("reports strict-mode and covered targets without page markup", () => {
    const strict = describeScriptFailure(
      "locator.click: Error: strict mode violation: getByRole('button') resolved to 3 elements:\n    1) <button class=\"secret-markup\">A</button>",
      "await page.getByRole('button').click()",
    );
    expect(strict).toContain("matched 3 elements");
    expect(strict).not.toContain("secret-markup");
    const covered = describeScriptFailure(
      'locator.click: Timeout exceeded.\n  - <div class="modal">private text</div> intercepts pointer events',
      "await page.getByRole('button').click()",
    );
    expect(covered).toContain("another element covers the target");
    expect(covered).not.toContain("private text");
  });

  it("explains a read that raced a navigation", () => {
    expect(
      describeScriptFailure(
        "page.evaluate: Execution context was destroyed, most likely because of a navigation",
        "return await page.evaluate(() => document.body.innerText)",
      ),
    ).toContain("the page navigated while this ran");
  });

  it("repeats only identifiers the script spelled", () => {
    expect(describeScriptFailure("ReferenceError: totl is not defined", "return totl")).toBe(
      "ReferenceError: totl is not defined in the script.",
    );
    expect(describeScriptFailure("secretValue is not defined", "return null")).toBeUndefined();
    expect(describeScriptFailure("private-password is not defined", "return null")).toBeUndefined();
  });

  it("recognises worker time budget and syntax failures", () => {
    expect(
      describeScriptFailure("Execution timed out after 15s; the worker was restarted.", ""),
    ).toContain("time budget");
    expect(describeScriptFailure("SyntaxError: Unexpected identifier 'secret'", "x")).toBe(
      "SyntaxError: the script does not parse.",
    );
  });

  it("returns nothing for unrecognised or non-string errors", () => {
    expect(describeScriptFailure("private-password", "return null")).toBeUndefined();
    expect(describeScriptFailure({ secret: "private-password" }, "return null")).toBeUndefined();
    expect(describeScriptFailure(undefined, "return null")).toBeUndefined();
  });
});
