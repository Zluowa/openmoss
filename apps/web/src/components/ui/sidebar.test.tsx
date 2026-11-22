import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarHeaderNavigationControls } from "../SidebarHeaderNavigationControls";
import {
  RAIL_LAYOUT_TOP_BAR_CLASS,
  useDesktopTopBarTrafficLightGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { SidebarHeaderTrigger, SidebarProvider, useOptionalSidebar } from "./sidebar";

function renderWithQueryClient(node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );
}

function GutterProbe() {
  const className = useDesktopTopBarTrafficLightGutterClassName();
  const sidebar = useOptionalSidebar();
  return <div data-has-sidebar={sidebar ? "true" : "false"} className={className} />;
}

describe("sidebar header trigger", () => {
  it("renders the header trigger when the desktop sidebar is collapsed", () => {
    const html = renderWithQueryClient(
      <SidebarProvider open={false}>
        <SidebarHeaderTrigger />
      </SidebarProvider>,
    );

    expect(html).toContain('data-slot="sidebar-trigger"');
    expect(html).toContain("Toggle Sidebar");
  });

  it("omits the header trigger when the desktop sidebar is expanded", () => {
    const html = renderWithQueryClient(
      <SidebarProvider open>
        <SidebarHeaderTrigger />
      </SidebarProvider>,
    );

    expect(html).toContain('data-slot="sidebar-wrapper"');
    expect(html).not.toContain('data-slot="sidebar-trigger"');
    expect(html).not.toContain("Toggle Sidebar");
  });

  it("allows top-bar gutter hooks and header nav controls to render safely outside SidebarProvider", () => {
    const outsideHtml = renderWithQueryClient(
      <>
        <GutterProbe />
        <SidebarHeaderNavigationControls />
      </>,
    );

    expect(outsideHtml).toContain('data-has-sidebar="false"');
    expect(outsideHtml).toContain(`class="${RAIL_LAYOUT_TOP_BAR_CLASS}"`);
    expect(outsideHtml).not.toContain('data-slot="sidebar-trigger"');

    const insideHtml = renderWithQueryClient(
      <SidebarProvider open>
        <GutterProbe />
      </SidebarProvider>,
    );
    expect(insideHtml).toContain('data-has-sidebar="true"');
  });
});
