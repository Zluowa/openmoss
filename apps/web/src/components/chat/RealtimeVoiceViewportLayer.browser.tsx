// @vitest-environment browser

import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { RealtimeVoiceViewportLayer } from "./RealtimeVoiceViewportLayer";

afterEach(() => {
  cleanup();
  document.getElementById("root")?.remove();
});

describe("RealtimeVoiceViewportLayer", () => {
  it("covers only the owning chat pane and leaves the app shell interactive", async () => {
    const appRoot = document.createElement("div");
    appRoot.id = "root";
    const previousButton = document.createElement("button");
    previousButton.textContent = "Start Voice";
    appRoot.append(previousButton);
    document.body.append(appRoot);
    previousButton.focus();

    const screen = await render(
      <div className="relative h-[480px] w-[640px]" data-testid="owning-chat-pane">
        <RealtimeVoiceViewportLayer visible>
          <button type="button">End voice chat</button>
        </RealtimeVoiceViewportLayer>
      </div>,
    );

    const layer = screen.getByTestId("voice-viewport-layer");
    await expect.element(layer).toBeVisible();
    const box = layer.element().getBoundingClientRect();
    const paneBox = screen.getByTestId("owning-chat-pane").element().getBoundingClientRect();
    expect({ left: box.left, top: box.top, width: box.width, height: box.height }).toEqual({
      left: paneBox.left,
      top: paneBox.top,
      width: 640,
      height: 480,
    });
    expect(appRoot.hasAttribute("inert")).toBe(false);
    expect(appRoot.hasAttribute("aria-hidden")).toBe(false);
    previousButton.focus();
    expect(document.activeElement).toBe(previousButton);
  });

  it("renders nothing while hidden without mutating existing shell accessibility", async () => {
    const appRoot = document.createElement("div");
    appRoot.id = "root";
    appRoot.setAttribute("aria-hidden", "false");
    const previousButton = document.createElement("button");
    appRoot.append(previousButton);
    document.body.append(appRoot);
    previousButton.focus();

    const rendered = await render(
      <RealtimeVoiceViewportLayer visible={false}>
        <button type="button">End voice chat</button>
      </RealtimeVoiceViewportLayer>,
    );

    expect(document.querySelector('[data-testid="voice-viewport-layer"]')).toBeNull();
    expect(appRoot.hasAttribute("inert")).toBe(false);
    expect(appRoot.getAttribute("aria-hidden")).toBe("false");
    expect(document.activeElement).toBe(previousButton);
    rendered.unmount();
  });
});
