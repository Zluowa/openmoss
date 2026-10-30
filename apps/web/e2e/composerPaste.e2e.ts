import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "playwright/test";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireDesktop = createRequire(resolve(webDir, "../desktop/package.json"));
const prompt = [
  "Work ONLY in /tmp/parity12-retest-sandbox. Do not touch moss-moss trees.",
  "",
  "1. Read every paragraph of this message.",
  "   Preserve this indented continuation: 你好.",
  "",
  "2. Keep https://example.com/docs and all numbered steps.",
  "",
  "3. Report completion after checking the final line.",
].join("\n");
let output: string;

test.beforeAll(() => {
  output = mkdtempSync(join(tmpdir(), "moss-composer-e2e-"));
  for (const [entry, target, filename] of [
    ["composerMain.ts", "node", "main.cjs"],
    ["composerRenderer.tsx", "browser", "renderer.js"],
  ]) {
    execFileSync(
      "bun",
      [
        "build",
        `e2e/fixtures/${entry}`,
        `--target=${target}`,
        `--format=${target === "node" ? "cjs" : "iife"}`,
        `--outfile=${join(output, filename!)}`,
        "--external=electron",
        "--define",
        'import.meta.env={"DEV":false,"APP_VERSION":"0.7.6"}',
      ],
      { cwd: webDir, stdio: "inherit" },
    );
  }
  writeFileSync(
    join(output, "index.html"),
    `<!doctype html><meta charset="utf-8">
    <style>body { font: 16px sans-serif; margin: 40px; } pre { white-space: pre-wrap; }
    [contenteditable] { white-space: pre-wrap; min-height: 80px; border: 1px solid; padding: 12px; }</style>
    <div id="root"></div><script src="renderer.js"></script>`,
  );
});
test.afterAll(() => rmSync(output, { recursive: true, force: true }));

for (const method of ["Enter", "Send"] as const) {
  test(`native Electron clipboard preserves all paragraphs on immediate ${method}`, async ({}, testInfo) => {
    mkdirSync(join(output, `profile-${method}`), { recursive: true });
    const application = await electron.launch({
      executablePath: requireDesktop("electron") as string,
      args: ["--no-sandbox", join(output, "main.cjs")],
      env: {
        ...process.env,
        MOSS_E2E_COMPOSER_HTML: join(output, "index.html"),
        MOSS_E2E_COMPOSER_PROFILE: join(output, `profile-${method}`),
      },
    });
    try {
      const page = await application.firstWindow();
      const editor = page.getByTestId("composer-editor");
      await editor.click();
      // Both native formats are present, as with a copy from a rich editor.
      await application.evaluate(({ clipboard }, text) => {
        clipboard.write({ text, html: "<p>first paragraph only</p>" });
      }, prompt);
      expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(prompt);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
      // Deliberately do not wait for an editor/onChange assertion before sending.
      if (method === "Enter") await page.keyboard.press("Enter");
      else await page.getByRole("button", { name: "Send", exact: true }).click();
      const message = page.getByTestId("sent-user-message");
      await expect(message).toHaveCount(1);
      expect(await message.textContent()).toBe(prompt);
      await expect(editor).toHaveText("");
      await page.screenshot({ path: testInfo.outputPath(`native-paste-${method}.png`) });
    } finally {
      await application.close();
    }
  });
}
