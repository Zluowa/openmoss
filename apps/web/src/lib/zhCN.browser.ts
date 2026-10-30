// FILE: zhCN.browser.ts
// Purpose: Proves the long-tail Chinese UI fallback follows locale changes without touching content.
// Layer: Browser localization test

import { afterEach, describe, expect, it } from "vitest";

import { installZhCnUiLocalization, uninstallZhCnUiLocalization } from "../localization/zhCN";

async function settleMutations(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

describe("Simplified Chinese UI fallback", () => {
  afterEach(() => {
    uninstallZhCnUiLocalization();
    document.documentElement.lang = "en";
    document.documentElement.removeAttribute("data-moss-locale");
    document.title = "";
    document.body.replaceChildren();
  });

  it("localizes UI chrome, preserves runtime content, and restores English", async () => {
    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.mossLocale = "zh-CN";

    const preExistingUi = document.createElement("section");
    preExistingUi.innerHTML = `
      <div><div role="slider" aria-valuetext="Current page"></div></div>
    `;
    document.body.append(preExistingUi);
    installZhCnUiLocalization();

    const ui = document.createElement("section");
    ui.innerHTML = `
      <h1>Settings</h1>
      <button aria-label="Check updates">Save changes</button>
      <div role="slider" aria-valuetext="Current page"></div>
      <div data-translation-skip="true">Settings</div>
      <pre>Save changes</pre>
    `;
    document.body.append(ui);
    await settleMutations();

    expect(ui.querySelector("h1")?.textContent).toBe("设置");
    expect(ui.querySelector("button")?.textContent).toBe("保存更改");
    expect(ui.querySelector("button")?.getAttribute("aria-label")).toBe("检查更新");
    expect(ui.querySelector("[role='slider']")?.getAttribute("aria-valuetext")).toBe("当前页");
    expect(preExistingUi.querySelector("[role='slider']")?.getAttribute("aria-valuetext")).toBe(
      "当前页",
    );
    expect(ui.querySelector("[data-translation-skip]")?.textContent).toBe("Settings");
    expect(ui.querySelector("pre")?.textContent).toBe("Save changes");

    document.documentElement.lang = "en";
    document.documentElement.dataset.mossLocale = "en";
    await settleMutations();

    expect(ui.querySelector("h1")?.textContent).toBe("Settings");
    expect(ui.querySelector("button")?.textContent).toBe("Save changes");
    expect(ui.querySelector("button")?.getAttribute("aria-label")).toBe("Check updates");
    expect(ui.querySelector("[role='slider']")?.getAttribute("aria-valuetext")).toBe(
      "Current page",
    );
    expect(preExistingUi.querySelector("[role='slider']")?.getAttribute("aria-valuetext")).toBe(
      "Current page",
    );

    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.mossLocale = "zh-CN";
    await settleMutations();

    expect(ui.querySelector("h1")?.textContent).toBe("设置");
    expect(ui.querySelector("button")?.textContent).toBe("保存更改");
  });

  it("localizes Computer control settings and late toasts only in Chinese, restoring English", async () => {
    document.documentElement.lang = "en";
    document.documentElement.dataset.mossLocale = "en";
    const copy = [
      ["Computer control", "电脑控制"],
      ["Availability", "可用性"],
      ["Available on macOS (cua)", "可在 macOS 上使用（cua）"],
      ["Permissions & helper", "权限与辅助程序"],
      [
        "Moss Computer Use is ready on macOS. (Input helper ready · Capture attached)",
        "Moss 电脑控制已在 macOS 上就绪。（输入辅助程序已就绪 · 屏幕捕获已连接）",
      ],
      ["Desktop capture", "桌面捕获"],
      ["macOS permissions", "macOS 权限"],
      ["Accessibility", "辅助功能"],
      ["Screen Recording", "屏幕录制"],
      ["Refresh", "刷新"],
    ] as const;
    const nodes = copy.map(([source]) => {
      const node = document.createElement("p");
      node.textContent = source;
      document.body.append(node);
      return node;
    });
    installZhCnUiLocalization();
    await settleMutations();
    expect(nodes.map((node) => node.textContent)).toEqual(copy.map(([source]) => source));

    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.mossLocale = "zh-CN";
    await settleMutations();
    expect(nodes.map((node) => node.textContent)).toEqual(copy.map(([, translated]) => translated));

    const toast = document.createElement("div");
    toast.innerHTML = `<h2>Open System Settings</h2><p>System Settings → Privacy &amp; Security → Accessibility → allow Moss.</p>`;
    document.body.append(toast);
    await settleMutations();
    expect(toast.querySelector("h2")?.textContent).toBe("打开系统设置");
    expect(toast.querySelector("p")?.textContent).toBe(
      "系统设置 → 隐私与安全性 → 辅助功能 → 允许 Moss。",
    );

    document.documentElement.lang = "en";
    document.documentElement.dataset.mossLocale = "en";
    await settleMutations();
    expect(nodes.map((node) => node.textContent)).toEqual(copy.map(([source]) => source));
    expect(toast.querySelector("h2")?.textContent).toBe("Open System Settings");
    expect(toast.querySelector("p")?.textContent).toBe(
      "System Settings → Privacy & Security → Accessibility → allow Moss.",
    );
  });

  it("localizes Realtime Voice text and controls while preserving runtime and voice identity", async () => {
    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.mossLocale = "zh-CN";
    installZhCnUiLocalization();

    const surface = document.createElement("section");
    surface.innerHTML = `
      <h1 data-testid="voice-title">Meet Moss Voice</h1>
      <p data-testid="voice-feature">Work across projects</p>
      <button data-testid="close" aria-label="Close voice chat setup">Start voice chat</button>
      <button data-testid="previous" aria-label="Previous voice"></button>
      <button data-testid="next" aria-label="Next voice"></button>
      <button data-testid="preview" aria-label="Replay Maple preview"></button>
      <button data-testid="mute" aria-label="Mute voice output" title="Mute voice output"></button>
      <button data-testid="end" aria-label="End voice chat" title="End voice chat"></button>
      <div data-testid="voice-option" role="radio" aria-label="Maple: Cheerful and candid">
        <span data-testid="voice-name">Maple</span>
        <span data-testid="voice-description">Cheerful and candid</span>
      </div>
      <p data-testid="selected" aria-live="polite">Selected voice: Maple. Cheerful and candid</p>
      <div data-moss-realtime-voice-stage="true"><p data-testid="voice-thinking">Thinking</p></div>
      <p data-testid="workspace-thinking">Thinking</p>
      <p data-testid="runtime-error" role="alert">Voice chat took too long to start</p>
      <code data-testid="model">gpt-realtime-2.1</code>
      <p data-testid="user-content" data-translation-skip="true">Start voice chat</p>
    `;
    document.body.append(surface);
    await settleMutations();

    expect(surface.querySelector("[data-testid='voice-title']")?.textContent).toBe(
      "认识 Moss 语音",
    );
    expect(surface.querySelector("[data-testid='voice-feature']")?.textContent).toBe("跨项目工作");
    expect(surface.querySelector("[data-testid='close']")?.textContent).toBe("开启语音聊天");
    expect(surface.querySelector("[data-testid='close']")?.getAttribute("aria-label")).toBe(
      "关闭语音聊天设置",
    );
    expect(surface.querySelector("[data-testid='previous']")?.getAttribute("aria-label")).toBe(
      "上一个语音",
    );
    expect(surface.querySelector("[data-testid='next']")?.getAttribute("aria-label")).toBe(
      "下一个语音",
    );
    expect(surface.querySelector("[data-testid='preview']")?.getAttribute("aria-label")).toBe(
      "重播 Maple 预览",
    );
    expect(surface.querySelector("[data-testid='mute']")?.getAttribute("aria-label")).toBe(
      "将语音输出静音",
    );
    expect(surface.querySelector("[data-testid='mute']")?.getAttribute("title")).toBe(
      "将语音输出静音",
    );
    expect(surface.querySelector("[data-testid='end']")?.getAttribute("aria-label")).toBe(
      "结束语音聊天",
    );
    expect(surface.querySelector("[data-testid='voice-option']")?.getAttribute("aria-label")).toBe(
      "Maple：开朗而直率",
    );
    expect(surface.querySelector("[data-testid='voice-name']")?.textContent).toBe("Maple");
    expect(surface.querySelector("[data-testid='voice-description']")?.textContent).toBe(
      "开朗而直率",
    );
    expect(surface.querySelector("[data-testid='selected']")?.textContent).toBe(
      "已选择语音：Maple。开朗而直率",
    );
    expect(surface.querySelector("[data-testid='voice-thinking']")?.textContent).toBe("正在思考");
    expect(surface.querySelector("[data-testid='workspace-thinking']")?.textContent).toBe("思考中");
    expect(surface.querySelector("[data-testid='runtime-error']")?.textContent).toBe(
      "Voice chat took too long to start",
    );
    expect(surface.querySelector("[data-testid='model']")?.textContent).toBe("gpt-realtime-2.1");
    expect(surface.querySelector("[data-testid='user-content']")?.textContent).toBe(
      "Start voice chat",
    );

    document.documentElement.lang = "en";
    document.documentElement.dataset.mossLocale = "en";
    await settleMutations();

    expect(surface.querySelector("[data-testid='voice-title']")?.textContent).toBe(
      "Meet Moss Voice",
    );
    expect(surface.querySelector("[data-testid='close']")?.textContent).toBe("Start voice chat");
    expect(surface.querySelector("[data-testid='close']")?.getAttribute("aria-label")).toBe(
      "Close voice chat setup",
    );
    expect(surface.querySelector("[data-testid='voice-option']")?.getAttribute("aria-label")).toBe(
      "Maple: Cheerful and candid",
    );
    expect(surface.querySelector("[data-testid='selected']")?.textContent).toBe(
      "Selected voice: Maple. Cheerful and candid",
    );
    expect(surface.querySelector("[data-testid='voice-thinking']")?.textContent).toBe("Thinking");
    expect(surface.querySelector("[data-testid='workspace-thinking']")?.textContent).toBe(
      "Thinking",
    );
  });

  it("preserves runtime text nested below pre and code elements", async () => {
    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.mossLocale = "zh-CN";
    installZhCnUiLocalization();

    const runtimeContent = document.createElement("section");
    runtimeContent.innerHTML = `
      <pre><code><span data-testid="file-preview-line">Settings</span></code></pre>
      <pre><span data-testid="tool-call-line">Save changes</span></pre>
    `;
    document.body.append(runtimeContent);
    await settleMutations();

    expect(runtimeContent.querySelector("[data-testid='file-preview-line']")?.textContent).toBe(
      "Settings",
    );
    expect(runtimeContent.querySelector("[data-testid='tool-call-line']")?.textContent).toBe(
      "Save changes",
    );
  });

  it("preserves dynamic product values byte-for-byte across locale switches", async () => {
    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.mossLocale = "zh-CN";
    installZhCnUiLocalization();

    const surface = document.createElement("section");
    surface.innerHTML = `
      <h1 data-testid="chrome">Settings</h1>
      <span data-testid="chrome-archive">Archive</span>
      <span data-testid="chrome-read">Read</span>
      <span data-testid="chrome-max">Max</span>
      <span data-testid="project" data-translation-skip="true">Settings</span>
      <span data-testid="thread" data-translation-skip="true">Archive</span>
      <span data-testid="comment" data-translation-skip="true">Read</span>
      <span data-testid="error" data-translation-skip="true" title="Max">Max</span>
      <span data-testid="file" data-translation-skip="true" title="Read">Settings</span>
      <span data-testid="model" data-translation-skip="true">Max</span>
    `;
    document.body.append(surface);

    const expected = {
      project: "Settings",
      thread: "Archive",
      comment: "Read",
      error: "Max",
      file: "Settings",
      model: "Max",
    } as const;
    const expectDynamicValues = () => {
      for (const [testId, value] of Object.entries(expected)) {
        expect(surface.querySelector(`[data-testid='${testId}']`)?.textContent).toBe(value);
      }
      expect(surface.querySelector("[data-testid='error']")?.getAttribute("title")).toBe("Max");
      expect(surface.querySelector("[data-testid='file']")?.getAttribute("title")).toBe("Read");
    };

    await settleMutations();
    expect(surface.querySelector("[data-testid='chrome']")?.textContent).toBe("设置");
    expect(surface.querySelector("[data-testid='chrome-archive']")?.textContent).toBe("归档");
    expect(surface.querySelector("[data-testid='chrome-read']")?.textContent).toBe("已读");
    expect(surface.querySelector("[data-testid='chrome-max']")?.textContent).toBe("最大");
    expectDynamicValues();

    document.documentElement.lang = "en";
    document.documentElement.dataset.mossLocale = "en";
    await settleMutations();
    expect(surface.querySelector("[data-testid='chrome']")?.textContent).toBe("Settings");
    expect(surface.querySelector("[data-testid='chrome-archive']")?.textContent).toBe("Archive");
    expect(surface.querySelector("[data-testid='chrome-read']")?.textContent).toBe("Read");
    expect(surface.querySelector("[data-testid='chrome-max']")?.textContent).toBe("Max");
    expectDynamicValues();

    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.mossLocale = "zh-CN";
    await settleMutations();
    expect(surface.querySelector("[data-testid='chrome']")?.textContent).toBe("设置");
    expect(surface.querySelector("[data-testid='chrome-archive']")?.textContent).toBe("归档");
    expect(surface.querySelector("[data-testid='chrome-read']")?.textContent).toBe("已读");
    expect(surface.querySelector("[data-testid='chrome-max']")?.textContent).toBe("最大");
    expectDynamicValues();
  });

  it("localizes structured launch-plan atoms without rewriting raw paths or identifiers", async () => {
    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.mossLocale = "zh-CN";
    installZhCnUiLocalization();

    const surface = document.createElement("section");
    surface.innerHTML = `
      <span data-testid="environment">
        <span>redacted</span> / <span>hash sha256:abc123</span> / <span>source Work / Fallback</span>
      </span>
      <span data-testid="config">
        <span data-localization-skip="true">Pass / settings.json</span> /
        <span>required</span> / <span>hash deadbeef</span>
      </span>
      <span data-testid="diagnostic">ScreenCaptureKit error / Blocked</span>
    `;
    document.body.append(surface);
    await settleMutations();

    expect(surface.querySelector("[data-testid='environment']")?.textContent?.trim()).toBe(
      "已脱敏 / 哈希 sha256:abc123 / 来源 Work / Fallback",
    );
    expect(
      surface.querySelector("[data-testid='config']")?.textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("Pass / settings.json / 必需 / 哈希 deadbeef");
    expect(surface.querySelector("[data-testid='diagnostic']")?.textContent).toBe(
      "ScreenCaptureKit error / Blocked",
    );
  });

  it("localizes browser document titles outside the body and restores English", async () => {
    document.title = "Sign in · Moss";
    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.mossLocale = "zh-CN";
    installZhCnUiLocalization();
    await settleMutations();

    expect(document.title).toBe("登录 · Moss");

    document.documentElement.lang = "en";
    document.documentElement.dataset.mossLocale = "en";
    await settleMutations();

    expect(document.title).toBe("Sign in · Moss");
  });

  it("does not restore stale source after same-value text and attribute reuse", async () => {
    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.mossLocale = "zh-CN";
    installZhCnUiLocalization();

    const textHost = document.createElement("span");
    const textNode = document.createTextNode("Settings");
    textHost.append(textNode);
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Settings");
    document.body.append(textHost, button);
    await settleMutations();

    expect(textNode.nodeValue).toBe("设置");
    expect(button.getAttribute("aria-label")).toBe("设置");

    // Simulates a renderer reusing the same DOM objects for source content that happens to equal
    // the localization layer's previous output.
    textNode.nodeValue = "设置";
    button.setAttribute("aria-label", "设置");
    await settleMutations();

    document.documentElement.lang = "en";
    document.documentElement.dataset.mossLocale = "en";
    await settleMutations();

    expect(textNode.nodeValue).toBe("设置");
    expect(button.getAttribute("aria-label")).toBe("设置");
  });

  it("reacts to skip and contenteditable boundary changes", async () => {
    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.mossLocale = "zh-CN";
    installZhCnUiLocalization();

    const skipBoundary = document.createElement("div");
    skipBoundary.dataset.translationSkip = "true";
    skipBoundary.setAttribute("aria-label", "Settings");
    skipBoundary.textContent = "Settings";

    const editableEmpty = document.createElement("div");
    editableEmpty.setAttribute("contenteditable", "");
    editableEmpty.textContent = "Settings";

    const editablePlaintext = document.createElement("div");
    editablePlaintext.setAttribute("contenteditable", "plaintext-only");
    editablePlaintext.textContent = "Settings";

    const editableFalse = document.createElement("div");
    editableFalse.setAttribute("contenteditable", "false");
    editableFalse.textContent = "Settings";

    document.body.append(skipBoundary, editableEmpty, editablePlaintext, editableFalse);
    await settleMutations();

    expect(skipBoundary.textContent).toBe("Settings");
    expect(skipBoundary.getAttribute("aria-label")).toBe("Settings");
    expect(editableEmpty.textContent).toBe("Settings");
    expect(editablePlaintext.textContent).toBe("Settings");
    expect(editableFalse.textContent).toBe("设置");

    skipBoundary.removeAttribute("data-translation-skip");
    await settleMutations();
    expect(skipBoundary.textContent).toBe("设置");
    expect(skipBoundary.getAttribute("aria-label")).toBe("设置");

    skipBoundary.dataset.localizationSkip = "true";
    editableFalse.setAttribute("contenteditable", "");
    await settleMutations();
    expect(skipBoundary.textContent).toBe("Settings");
    expect(skipBoundary.getAttribute("aria-label")).toBe("Settings");
    expect(editableFalse.textContent).toBe("Settings");

    skipBoundary.removeAttribute("data-localization-skip");
    editableFalse.setAttribute("contenteditable", "false");
    await settleMutations();
    expect(skipBoundary.textContent).toBe("设置");
    expect(skipBoundary.getAttribute("aria-label")).toBe("设置");
    expect(editableFalse.textContent).toBe("设置");
  });
});
