// FILE: AgentThemeSync.browser.tsx
// Purpose: A theme an agent publishes with `moss_theme_set` repaints an open Moss window at
//          once: the colors, and the chat background picture. The theme is the one the owner's
//          agent set on 2026-11-20 (「水草缸」), with its picture stored under a reference.
// Layer: Web browser test

import "../index.css";

import { DEFAULT_SERVER_SETTINGS, type MossPublishedTheme } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useTheme } from "~/hooks/useTheme";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { DEFAULT_THEME_STATE } from "~/theme/theme.logic";
import { inspectThemeCss } from "~/theme/themeCss";

import { AgentThemeSync } from "./AgentThemeSync";

const PICTURE = `moss-theme-image:${"5d".repeat(32)}.png`;
const CSS = `[data-workspace-area="conversation"] {
  background-color: var(--background) !important;
  background-image: linear-gradient(
    color-mix(in srgb, var(--background) 18%, transparent),
    color-mix(in srgb, var(--background) 40%, transparent) 58%,
    color-mix(in srgb, var(--background) 22%, transparent)
  ), url(${PICTURE}) !important;
  background-position: center !important;
  background-size: cover !important;
  background-repeat: no-repeat !important;
}
[data-workspace-area="conversation"]:has([data-message-role]),
.dark [data-workspace-area="conversation"] {
  background-image: linear-gradient(
    color-mix(in srgb, var(--background) 76%, transparent),
    color-mix(in srgb, var(--background) 88%, transparent)
  ), url(${PICTURE}) !important;
}
[data-chat-header] {
  background-color: color-mix(in srgb, var(--background) 94%, transparent) !important;
}
[data-chat-composer-surface] {
  background-color: var(--card) !important;
  border-color: var(--border) !important;
}
[data-user-message-bubble] {
  background-color: color-mix(in srgb, var(--accent) 12%, var(--card)) !important;
}
`;

function aquariumTheme(revision: string): MossPublishedTheme {
  return {
    revision,
    publishedAt: "2026-11-20T09:33:46.456Z",
    name: "水草缸",
    appearance: "light",
    light: {
      preset: "moss",
      accent: "#376341",
      surface: "#f5f5e8",
      ink: "#202d24",
      sidebar: "#e8eddc",
      contrast: 60,
      css: CSS,
    },
    dark: {
      preset: "moss",
      accent: "#a9c88a",
      surface: "#182923",
      ink: "#edf2e3",
      sidebar: "#20352b",
      contrast: 68,
      css: CSS,
    },
  } as MossPublishedTheme;
}

function Window() {
  useTheme();
  return (
    <>
      <AgentThemeSync />
      <div data-workspace-area="conversation" style={{ width: 600, height: 300 }}>
        <div data-message-role="assistant">回复</div>
      </div>
    </>
  );
}

beforeEach(() => {
  localStorage.removeItem("moss:theme:agent-revision");
  localStorage.setItem("moss:theme", JSON.stringify({ ...DEFAULT_THEME_STATE, mode: "light" }));
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
});
afterEach(() => {
  localStorage.removeItem("moss:theme");
  localStorage.removeItem("moss:theme:agent-revision");
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
});

const conversation = () =>
  document.querySelector<HTMLElement>('[data-workspace-area="conversation"]')!;

it("repaints an open window when an agent publishes a theme", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  // The window is open and connected: it already holds server settings without a theme.
  queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS);
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <Window />
    </QueryClientProvider>,
  );
  const before = getComputedStyle(conversation()).backgroundImage;
  expect(before).not.toContain("/api/theme-images/");

  // `server.settingsUpdated` arrives, the way the root route writes it into the cache.
  queryClient.setQueryData(serverQueryKeys.settings(), {
    ...DEFAULT_SERVER_SETTINGS,
    agentTheme: aquariumTheme("f0094d68-49ff-40c5-b4fd-36aac16ee358"),
  });

  await expect
    .poll(() => getComputedStyle(conversation()).backgroundImage)
    .toContain("/api/theme-images/");
  await expect
    .poll(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--moss-boot-background"),
    )
    .toContain("#f5f5e8");

  // A second publication (the agent tries again) repaints again, without a reload.
  const first = aquariumTheme("1c2a4751-0000-4000-8000-000000000002");
  const second = { ...first, light: { ...first.light, surface: "#eef3e2" } } as MossPublishedTheme;
  queryClient.setQueryData(serverQueryKeys.settings(), {
    ...DEFAULT_SERVER_SETTINGS,
    agentTheme: second,
  });
  await expect
    .poll(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--moss-boot-background"),
    )
    .toContain("#eef3e2");
  await screen.unmount();
});

it("keeps var() inside a color in a picture's tint and still drops every other late value", () => {
  const kept = (css: string) =>
    inspectThemeCss(`[data-probe] { ${css} }`).droppedDeclarations === 0;
  // The owner's agent wrote this: a tint mixed from the theme's own colors over the picture.
  expect(
    kept(
      `background-image: linear-gradient(color-mix(in srgb, var(--background) 40%, transparent), transparent), url(${PICTURE});`,
    ),
  ).toBe(true);
  expect(kept("background-image: linear-gradient(rgb(var(--tint)), red);")).toBe(true);
  // A var() that could become the address itself, or sit where an image goes, is dropped.
  expect(kept("background-image: var(--picture);")).toBe(false);
  expect(kept("background-image: linear-gradient(var(--from), red);")).toBe(false);
  expect(kept("background-image: image-set(var(--picture) 1x);")).toBe(false);
  expect(kept("cursor: var(--cursor), auto;")).toBe(false);
  // attr() copies page text, and a shorthand hides its longhands until use.
  expect(
    kept("background-image: linear-gradient(color-mix(in srgb, attr(title) 40%, red), red);"),
  ).toBe(false);
  expect(
    kept(
      `background: linear-gradient(color-mix(in srgb, var(--background) 40%, red), red), url(${PICTURE});`,
    ),
  ).toBe(false);
});
