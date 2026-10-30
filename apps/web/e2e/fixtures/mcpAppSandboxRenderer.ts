import { createElement, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { McpAppSandboxDescriptor } from "@synara/contracts";
import type { WorkLogEntry } from "../../src/workLog";
import type { WorkLogMcpToolResult } from "../../src/lib/toolCallDetails";
import { TimelineWorkEntryRow } from "../../src/components/chat/TimelineWorkEntryRow";
import type { McpAppHostPhase } from "../../src/lib/mcpAppHost";
import { RightDock } from "../../src/components/chat/RightDock";
import type { RightDockPane, RightDockThreadState } from "../../src/rightDockStore.logic";
import {
  closeMcpAppDockEntry,
  exitSelectedMcpAppDockEntry,
  getMcpAppDockEntries,
  registerMcpAppDockHost,
  selectMcpAppDockEntry,
  useMcpAppDockEntries,
} from "../../src/lib/mcpAppDockRegistry";

const THREAD_ID = "thread-mcp-app-e2e";
const CALL_ID = "call-mcp-app-e2e";
const RESOURCE_URI = "ui://fixture/mcp-app";

function projection(resultText = "fixture-result"): WorkLogMcpToolResult {
  return {
    kind: "codex.mcp_tool_call",
    version: 1,
    callId: CALL_ID,
    server: "fixture-server",
    tool: "render_widget",
    status: "completed",
    arguments: { value: "fixture-input" },
    result: {
      content: [
        { type: "text", text: resultText },
        { type: "unknown", json: JSON.stringify({ attachmentId: "must-not-leak" }) },
      ],
      structuredContent: { fixture: true },
    },
    truncation: { truncated: false, deferredBinary: false },
    automaticApprovalReviews: [
      {
        reviewId: "fixture-review",
        targetItemId: CALL_ID,
        status: "approved",
        rationale: "Fixture review approved.",
        startedAtMs: 1_780_000_000_000,
      },
    ],
    app: {
      resourceUri: RESOURCE_URI,
      source: "appContext",
      connectorId: "fixture-connector",
      appName: "Moss MCP App fixture",
    },
  } as WorkLogMcpToolResult;
}

function workEntry(resultText: string): WorkLogEntry {
  const result = projection(resultText);
  return {
    id: "mcp-app-e2e-entry",
    createdAt: "2026-08-30T00:00:00.000Z",
    label: "MCP tool call",
    tone: "tool",
    itemType: "mcp_tool_call",
    activityKind: "tool.completed",
    toolTitle: `${result.server}.${result.tool}`,
    toolName: `mcp__${result.server}__${result.tool}`,
    toolCallId: result.callId,
    toolStatus: "completed",
    mcpToolResult: result,
  };
}

type Presentation = {
  readonly phase: McpAppHostPhase;
  readonly prefersBorder: boolean;
  readonly isCollapsible: boolean;
};

function applyFixtureTheme(theme: "light" | "dark"): void {
  const tokens =
    theme === "dark"
      ? {
          "--background": "#171717",
          "--foreground": "#f5f5f5",
          "--muted-foreground": "#a0a0a0",
          "--border": "#353535",
          "--card": "#202020",
          "--card-foreground": "#f5f5f5",
          "--color-background-surface": "#202020",
          "--color-background-surface-under": "#171717",
          "--color-background-elevated-primary": "#202020",
          "--color-background-elevated-secondary": "#242424",
          "--color-background-primary-solid": "#171717",
          "--color-text-foreground": "#f5f5f5",
          "--color-text-foreground-secondary": "#a0a0a0",
          "--color-border": "#353535",
          "--color-border-light": "#353535",
          "--color-border-heavy": "#5a5a5a",
          "--color-border-subtle": "#353535",
        }
      : {
          "--background": "#f6f6f6",
          "--foreground": "#202020",
          "--muted-foreground": "#6b6b6b",
          "--border": "#d8d8d8",
          "--card": "#ffffff",
          "--card-foreground": "#202020",
          "--color-background-surface": "#ffffff",
          "--color-background-surface-under": "#f6f6f6",
          "--color-background-elevated-primary": "#ffffff",
          "--color-background-elevated-secondary": "#f6f6f6",
          "--color-background-primary-solid": "#f6f6f6",
          "--color-text-foreground": "#202020",
          "--color-text-foreground-secondary": "#6b6b6b",
          "--color-border": "#d8d8d8",
          "--color-border-light": "#d8d8d8",
          "--color-border-heavy": "#b8b8b8",
          "--color-border-subtle": "#d8d8d8",
        };
  for (const [name, value] of Object.entries(tokens)) {
    document.documentElement.style.setProperty(name, value);
  }
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.documentElement.style.setProperty(
    "--fixture-surface",
    theme === "dark" ? "#171717" : "#f6f6f6",
  );
  document.documentElement.style.setProperty(
    "--fixture-foreground",
    theme === "dark" ? "#f5f5f5" : "#202020",
  );
  document.body.style.background = theme === "dark" ? "#171717" : "#f6f6f6";
  document.body.style.color = theme === "dark" ? "#f5f5f5" : "#202020";
}

function FixtureCard(props: {
  readonly remountKey: number;
  readonly theme: "light" | "dark";
  readonly resultText: string;
  readonly onPresentation: (presentation: Presentation) => void;
}) {
  return createElement(TimelineWorkEntryRow, {
    key: props.remountKey,
    workEntry: workEntry(props.resultText),
    chatMetaFontSizePx: 12,
    textFontSizePx: 14,
    density: "default",
    markdownCwd: undefined,
    onImageExpand: () => undefined,
    threadId: THREAD_ID,
    theme: props.theme,
    onMcpAppPresentation: props.onPresentation,
    timestampFormat: "locale",
  });
}

const FIXTURE_OTHER_PANE: RightDockPane = {
  id: "fixture-other-pane",
  kind: "terminal",
  threadId: null,
  diffTurnId: null,
  diffFilePath: null,
  filePath: null,
  pullRequestProjectId: null,
  pullRequestRepository: null,
  pullRequestNumber: null,
  pullRequestInitialTab: null,
};

const rootElement = document.createElement("main");
rootElement.id = "fixture-host";
rootElement.tabIndex = -1;
rootElement.dataset.mcpAppPortalTarget = "true";
rootElement.style.cssText =
  "box-sizing:border-box;display:flex;flex-direction:column;position:relative;width:100%;height:100vh;max-width:100vw;min-height:240px;max-height:100vh;overflow:hidden;outline:none;padding:24px;background:var(--fixture-surface,#f6f6f6);color:var(--fixture-foreground,#202020);font:14px system-ui";
document.body.style.cssText = "margin:0;overflow:hidden;background:#f6f6f6";
document.body.append(rootElement);

const heading = document.createElement("h1");
heading.textContent = "Moss MCP App sandbox";
heading.style.cssText = "margin:0 0 12px;font:600 18px system-ui";
rootElement.append(heading);

let setThemeState: ((theme: "light" | "dark") => void) | null = null;
let setResultState: ((resultText: string) => void) | null = null;
let setDockOpenState: ((open: boolean) => void) | null = null;
let remountState: (() => void) | null = null;
let unmountRoot: (() => void) | null = null;

function renderFixture(): Root {
  const reactRoot = createRoot(rootElement);
  function FixtureSurface() {
    const [theme, setTheme] = useState<"light" | "dark">("light");
    const [resultText, setResult] = useState("fixture-result");
    const [remountKey, setRemountKey] = useState(0);
    const [presentation, setPresentation] = useState<Presentation>({
      phase: "idle",
      prefersBorder: false,
      isCollapsible: true,
    });
    const [dockOpen, setDockOpen] = useState(false);
    const [activePaneId, setActivePaneId] = useState<string | null>(FIXTURE_OTHER_PANE.id);
    const dockCloseRequestRef = useRef(0);
    const mcpAppEntries = useMcpAppDockEntries(THREAD_ID);
    setThemeState = setTheme;
    setResultState = setResult;
    setDockOpenState = setDockOpen;
    remountState = () => setRemountKey((value) => value + 1);
    useEffect(() => {
      applyFixtureTheme(theme);
    }, [theme]);
    useEffect(() => {
      rootElement.dataset.phase = presentation.phase;
      rootElement.dataset.height =
        rootElement.querySelector<HTMLElement>("[data-mcp-app-frame]")?.style.height ?? "240px";
      rootElement.dataset.generation = String(remountKey);
      rootElement.dataset.collapsible = String(presentation.isCollapsible);
      rootElement.dataset.prefersBorder = String(presentation.prefersBorder);
    }, [presentation, remountKey]);
    useEffect(
      () =>
        registerMcpAppDockHost(THREAD_ID, {
          open: (entryId) => {
            dockCloseRequestRef.current += 1;
            selectMcpAppDockEntry(THREAD_ID, entryId);
            setDockOpen(true);
          },
          hide: (entryId) => {
            const remaining = getMcpAppDockEntries(THREAD_ID).filter(
              (entry) => entry.id !== entryId,
            );
            selectMcpAppDockEntry(THREAD_ID, remaining[0]?.id ?? null);
            if (remaining.length === 0 && activePaneId === null) setDockOpen(false);
          },
        }),
      [activePaneId],
    );
    const dockState: RightDockThreadState = {
      open: dockOpen,
      panes: [FIXTURE_OTHER_PANE],
      activePaneId: activePaneId === FIXTURE_OTHER_PANE.id ? FIXTURE_OTHER_PANE.id : null,
    };
    const renderDockPane = (pane: RightDockPane) =>
      pane.id === FIXTURE_OTHER_PANE.id
        ? createElement(
            "div",
            {
              className: "h-full min-h-0 w-full p-4",
              "data-fixture-other-pane": "true",
            },
            "Other pane",
          )
        : null;
    return createElement(
      "div",
      {
        "data-fixture-layout": "mcp-app-host",
        style: {
          display: "flex",
          width: "100%",
          height: "100%",
          minWidth: 0,
          minHeight: 0,
          flex: "1 1 auto",
        },
      },
      createElement(
        "section",
        {
          "data-fixture-production-component": "TimelineWorkEntryRow",
          style: {
            flex: "1 1 auto",
            width: 0,
            maxWidth: "100%",
            minWidth: 0,
            minHeight: 0,
            overflow: "hidden",
            background: "var(--fixture-surface, #f6f6f6)",
            color: "var(--fixture-foreground, #202020)",
            paddingRight: 12,
          },
        },
        createElement(FixtureCard, {
          remountKey,
          theme,
          resultText,
          onPresentation: setPresentation,
        }),
      ),
      createElement(
        "div",
        {
          "data-fixture-right-dock-host": "true",
          style: {
            position: "relative",
            width: "min(420px, 100%)",
            height: "100%",
            minHeight: 0,
            flex: "0 0 min(420px, 100%)",
          },
        },
        createElement(RightDock, {
          state: dockState,
          minWidth: 240,
          defaultWidth: 360,
          shouldAcceptWidth: () => true,
          addMenuKinds: [],
          motionKey: "mcp-app-fixture",
          mcpAppEntries,
          paneLabelOverrides: { [FIXTURE_OTHER_PANE.id]: "Other" },
          onSelectMcpApp: (entryId: string) => selectMcpAppDockEntry(THREAD_ID, entryId),
          onCloseMcpApp: (entryId: string) => void closeMcpAppDockEntry(entryId),
          onSelectPane: (paneId: string) => {
            dockCloseRequestRef.current += 1;
            selectMcpAppDockEntry(THREAD_ID, null);
            setActivePaneId(paneId);
          },
          onClosePane: () => setActivePaneId(null),
          onCollapse: () => {
            const requestId = ++dockCloseRequestRef.current;
            if (!mcpAppEntries.some((entry) => entry.selected)) {
              setDockOpen(false);
              return;
            }
            void exitSelectedMcpAppDockEntry(THREAD_ID).then(() => {
              if (dockCloseRequestRef.current !== requestId) return;
              setDockOpen(false);
            });
          },
          onOpenChange: (open: boolean) => {
            const requestId = ++dockCloseRequestRef.current;
            if (!open) {
              if (!mcpAppEntries.some((entry) => entry.selected)) {
                setDockOpen(false);
                return;
              }
              void exitSelectedMcpAppDockEntry(THREAD_ID).then(() => {
                if (dockCloseRequestRef.current !== requestId) return;
                setDockOpen(false);
              });
              return;
            }
            setDockOpen(true);
          },
          fullWidth: false,
          bottomPanelOpen: false,
          onToggleBottomPanel: () => undefined,
          bottomPanelShortcutLabel: null,
          rightPanelShortcutLabel: null,
          windowControlsGutterClassName: null,
          onAddPane: () => undefined,
          renderPane: renderDockPane,
        }),
      ),
    );
  }
  reactRoot.render(createElement(FixtureSurface));
  return reactRoot;
}

const reactRoot = renderFixture();
unmountRoot = () => reactRoot.unmount();

function currentDescriptor(): McpAppSandboxDescriptor | null {
  const webview = document.querySelector<HTMLElement>("webview[data-mcp-app-sandbox='true']");
  const src = webview?.getAttribute("src");
  const partition = webview?.getAttribute("partition");
  if (!src || !partition) return null;
  try {
    const parsed = new URL(src);
    const initId = new URLSearchParams(parsed.hash.slice(1)).get("init");
    const generation = Number(parsed.searchParams.get("generation"));
    if (!initId || !Number.isSafeInteger(generation)) return null;
    return {
      generation,
      initId,
      origin: `${parsed.protocol}//${parsed.host}`,
      partition,
      sandboxId: parsed.hostname,
      src,
    };
  } catch {
    return null;
  }
}

Object.assign(window, {
  __mossMcpAppFixture: {
    getSnapshot: () => ({ phase: rootElement.dataset.phase ?? "idle" }),
    getDescriptor: currentDescriptor,
    updateTheme(theme: "light" | "dark") {
      applyFixtureTheme(theme);
      setThemeState?.(theme);
    },
    resize(width: number, height: number) {
      rootElement.style.width = `${Math.max(1, Math.round(width))}px`;
      rootElement.style.height = `${Math.max(1, Math.round(height))}px`;
    },
    updateResult(resultText: string) {
      setResultState?.(resultText);
    },
    setDockOpen(open: boolean) {
      setDockOpenState?.(open);
    },
    teardown: async () => {
      unmountRoot?.();
      unmountRoot = null;
    },
    failGeneration: async () => {
      remountState?.();
    },
    retry: async () => {
      document.querySelector<HTMLButtonElement>("[data-mcp-app-error='sandbox'] button")?.click();
    },
  },
});
