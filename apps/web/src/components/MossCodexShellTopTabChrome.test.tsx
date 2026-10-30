import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MossCodexShellTopTabChrome } from "./MossCodexShellTopTabChrome";

vi.mock("~/hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("~/appNavigation", () => ({
  goBackInAppHistory: vi.fn(),
  goForwardInAppHistory: vi.fn(),
  useAppNavigationState: () => ({ canGoBack: false, canGoForward: false }),
}));

describe("MossCodexShellTopTabChrome right sidebar control", () => {
  const tabs = [{ id: "images-home", title: "图像", active: true, kind: "prompt" as const }];

  it("keeps the official trailing slot visible but disabled when unavailable", () => {
    const markup = renderToStaticMarkup(
      <MossCodexShellTopTabChrome tabs={tabs} showRightSidebarControl />,
    );

    expect(markup).toContain('data-moss-top-action="toggle-right-sidebar"');
    expect(markup).toContain('aria-label="Right sidebar unavailable"');
    expect(markup).toContain("disabled");
  });

  it("uses a separate live callback when a right sidebar exists", () => {
    const onToggleRightSidebar = vi.fn();
    const markup = renderToStaticMarkup(
      <MossCodexShellTopTabChrome tabs={tabs} onToggleRightSidebar={onToggleRightSidebar} />,
    );

    expect(markup).toContain('aria-label="Toggle right sidebar"');
    expect(markup).not.toContain('aria-label="Right sidebar unavailable"');
    const rightSidebarButton = markup.match(
      /<button[^>]*data-moss-top-action="toggle-right-sidebar"[^>]*>/,
    )?.[0];
    expect(rightSidebarButton).toBeDefined();
    expect(rightSidebarButton).not.toContain('disabled=""');
  });
});
