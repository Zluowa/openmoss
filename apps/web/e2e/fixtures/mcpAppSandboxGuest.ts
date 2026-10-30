import { App } from "@modelcontextprotocol/ext-apps";

type FixtureHostContext = {
  readonly theme?: string;
  readonly displayMode?: string;
  readonly availableDisplayModes?: readonly string[];
  readonly containerDimensions?: { readonly width?: number; readonly height?: number };
  readonly safeAreaInsets?: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
};

function renderStatus(message: string): void {
  const status = document.querySelector<HTMLElement>("#status");
  if (status) status.textContent = message;
}

function renderRoute(): void {
  const route = `${location.pathname}${location.search}${location.hash}`;
  document.body.dataset.route = route;
  const routeLabel = document.querySelector<HTMLElement>("#route");
  if (routeLabel) routeLabel.textContent = route;
}

function applyGuestTheme(theme: "light" | "dark"): void {
  const surface = theme === "dark" ? "#171717" : "#fff";
  const foreground = theme === "dark" ? "#f5f5f5" : "#202020";
  document.documentElement.style.setProperty("--mcp-surface", surface);
  document.documentElement.style.setProperty("--mcp-foreground", foreground);
  document.body.style.background = surface;
  document.body.style.color = foreground;
  const appShell = document.querySelector<HTMLElement>("#app-shell");
  if (appShell) {
    appShell.style.background = "var(--mcp-surface)";
    appShell.style.color = "var(--mcp-foreground)";
  }
}

function applyGuestSafeAreaInsets(insets: FixtureHostContext["safeAreaInsets"]): void {
  const appShell = document.querySelector<HTMLElement>("#app-shell");
  if (!appShell) return;
  const top = Number.isFinite(insets?.top) ? Math.max(0, Math.round(insets?.top ?? 0)) : 0;
  appShell.style.setProperty("--mcp-safe-area-top", `${top}px`);
  appShell.dataset.safeAreaTop = `${top}px`;
}

async function startFixtureApp(): Promise<void> {
  const app = new App(
    { name: "Moss MCP App E2E", version: "1.0.0" },
    {},
    { autoResize: false, strict: true },
  );

  app.ontoolinput = (params) => {
    document.body.dataset.toolInput = JSON.stringify(params.arguments ?? {});
    renderStatus(`input:${String(params.arguments?.value ?? "missing")}`);
  };
  app.ontoolresult = (params) => {
    document.body.dataset.toolResult = JSON.stringify(params);
    renderStatus(`result:${String(params.content?.[0]?.text ?? "missing")}`);
  };
  let lastHostContext: FixtureHostContext = {};
  app.onhostcontextchanged = (context: FixtureHostContext) => {
    lastHostContext = { ...lastHostContext, ...context };
    if (context.safeAreaInsets) {
      lastHostContext = { ...lastHostContext, safeAreaInsets: context.safeAreaInsets };
      applyGuestSafeAreaInsets(context.safeAreaInsets);
    }
    document.body.dataset.lastHostContext = JSON.stringify(lastHostContext);
    document.body.dataset.hostContextUpdates = String(
      Number(document.body.dataset.hostContextUpdates ?? "0") + 1,
    );
    if (context.theme !== undefined) {
      document.body.dataset.theme = context.theme;
      applyGuestTheme(context.theme);
    }
    if (context.displayMode !== undefined) {
      document.body.dataset.hostDisplayMode = context.displayMode;
    }
    const dimensions = context.containerDimensions;
    if (dimensions) {
      document.body.dataset.containerWidth = String(dimensions.width ?? "missing");
      document.body.dataset.containerHeight = String(dimensions.height ?? "missing");
    }
  };

  const previousStorage = localStorage.getItem("moss-mcp-app-e2e-marker");
  localStorage.setItem("moss-mcp-app-e2e-marker", "present");
  document.body.dataset.storageBefore = previousStorage ?? "absent";
  await app.connect();
  document.body.dataset.connected = "true";
  const initialHostContext = app.getHostContext();
  if (initialHostContext) {
    lastHostContext = initialHostContext as FixtureHostContext;
    document.body.dataset.lastHostContext = JSON.stringify(lastHostContext);
  }
  document.body.dataset.hostPlatform = initialHostContext?.platform ?? "missing";
  document.body.dataset.hostDisplayMode = initialHostContext?.displayMode ?? "missing";
  if (initialHostContext?.theme) {
    document.body.dataset.theme = initialHostContext.theme;
    applyGuestTheme(initialHostContext.theme);
  }
  applyGuestSafeAreaInsets(initialHostContext?.safeAreaInsets);
  const initialContext = initialHostContext?.containerDimensions;
  if (initialContext) {
    document.body.dataset.containerWidth = String(initialContext.width);
    document.body.dataset.containerHeight = String(initialContext.height);
  }
  renderStatus("connected");
  app.sendSizeChanged({ width: 320, height: 180 });
  window.addEventListener("popstate", renderRoute);
  renderRoute();
  (
    window as typeof window & {
      __mossMcpApp?: App & { pushFixtureRoute?: () => string; getFixtureRoute?: () => string };
    }
  ).__mossMcpApp = Object.assign(app, {
    pushFixtureRoute: () => {
      history.pushState({ fixture: "route-two" }, "", "/mcp-app-route-two");
      renderRoute();
      return location.href;
    },
    getFixtureRoute: () => location.href,
  });
}

document.body.innerHTML = `
  <main id="app-shell" style="box-sizing:border-box;min-height:180px;padding:16px;padding-top:calc(16px + var(--mcp-safe-area-top, 0px));scroll-padding-top:var(--mcp-safe-area-top, 0px);font:14px system-ui;background:var(--mcp-surface,#fff);color:var(--mcp-foreground,#202020)">
    <div id="app-content">
      <strong>Moss MCP App fixture</strong>
      <p id="status">starting</p>
      <p id="route"></p>
    </div>
  </main>
`;
void startFixtureApp().catch(() => {
  document.body.dataset.connected = "false";
  renderStatus("connect-error");
});
