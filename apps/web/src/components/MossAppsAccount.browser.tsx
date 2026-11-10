import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MossLocaleScope } from "~/localization";
import { useTheme } from "~/hooks/useTheme";
import { DEFAULT_THEME_STATE } from "~/theme/theme.logic";
import { mossServerQueryKeys } from "./auth/mossServerReactQuery";
import { MossAppConnectDialog, type MossAppConnectTarget } from "./MossAppConnectDialog";
import { MossAppsAccountNotice } from "./MossAppsAccountNotice";

function ThemeListener() {
  useTheme();
  return null;
}
const target: MossAppConnectTarget = {
  slug: "github",
  name: "GitHub",
  logoUrl: null,
  signIn: "managed",
};
function setAccount(client: QueryClient, id: string | null) {
  client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    authenticated: !!id,
    session: id ? { user: { id } } : null,
    activeRealm: "cn",
  });
  client.setQueryData(mossServerQueryKeys.mossCloudAccountState(), {
    authenticated: false,
    account: null,
    activeRealm: "cn",
  });
  client.setQueryData(mossServerQueryKeys.mossEnterpriseKeyState(), {
    active: false,
    keyPrefix: null,
  });
}
async function painted(element: HTMLElement, minimumWidth = 200) {
  await document.fonts.ready;
  await new Promise<void>((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done())),
  );
  const box = element.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(minimumWidth);
  expect(box.height).toBeGreaterThanOrEqual(16);
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    expect(Number(style.opacity)).toBeGreaterThan(0);
    expect(style.visibility).not.toBe("hidden");
    expect(style.display).not.toBe("none");
  }
}

describe("Moss Apps account UI", () => {
  it("shows Chinese account scope and recovery actions in real light and dark themes", async () => {
    await page.viewport(960, 540);
    const previous = localStorage.getItem("moss:theme");
    const action = vi.fn();
    const mounted = await render(
      <MossLocaleScope locale="zh-CN">
        <ThemeListener />
        <main
          data-testid="apps-account-preview"
          className="w-[640px] max-w-full space-y-6 rounded-xl bg-background p-8 font-sans text-foreground"
        >
          <h1 className="text-ui-xl font-medium">应用</h1>
          <MossAppsAccountNotice availability="ready" onAction={action} />
          <MossAppsAccountNotice availability="authentication-required" onAction={action} />
          <MossAppsAccountNotice availability="login-account-required" onAction={action} />
          <MossAppsAccountNotice availability="unconfigured" onAction={action} />
        </main>
      </MossLocaleScope>,
    );
    try {
      const backgrounds: string[] = [];
      for (const theme of ["light", "dark"] as const) {
        localStorage.setItem("moss:theme", JSON.stringify({ ...DEFAULT_THEME_STATE, mode: theme }));
        window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
        await vi.waitFor(() =>
          expect(document.documentElement.getAttribute("data-theme-variant")).toBe(theme),
        );
        await expect
          .element(page.getByText("连接属于当前 Moss 账号，旧版连接请重新连接。"))
          .toBeVisible();
        await expect.element(page.getByText("请切换到手机或 Google 账号使用应用。")).toBeVisible();
        const preview = page.getByTestId("apps-account-preview").element() as HTMLElement;
        await painted(preview);
        backgrounds.push(getComputedStyle(preview).backgroundColor);
        expect(preview.querySelectorAll("button")).toHaveLength(3);
        for (const button of preview.querySelectorAll("button")) {
          await painted(button, 20);
          const box = button.getBoundingClientRect();
          expect(box.left).toBeGreaterThanOrEqual(0);
          expect(box.right).toBeLessThanOrEqual(window.innerWidth);
          expect(box.top).toBeGreaterThanOrEqual(0);
          expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
        }
        const family = getComputedStyle(preview).fontFamily;
        expect(family).not.toMatch(/Times New Roman|^serif$/u);
        console.info(
          "Apps account fixture paint",
          JSON.stringify({
            theme,
            viewport: [window.innerWidth, window.innerHeight],
            fontFamily: family,
            background: backgrounds.at(-1),
          }),
        );
        await page.screenshot({
          path: `node_modules/.cache/moss-apps-account-zh-${theme}-complete.png`,
        });
      }
      expect(backgrounds[0]).not.toBe(backgrounds[1]);
      await userEvent.click(page.getByRole("button", { name: "选择账号", exact: true }));
      expect(action).toHaveBeenCalledOnce();
    } finally {
      if (previous === null) localStorage.removeItem("moss:theme");
      else localStorage.setItem("moss:theme", previous);
      window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
      await mounted.unmount();
    }
  });

  it.each(["logout", "A-B-A"])("does not open a late consent URL after %s", async (mode) => {
    const previous = window.nativeApi;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    setAccount(client, "a");
    let finish!: (result: unknown) => void;
    const connect = vi.fn(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const openExternal = vi.fn();
    const onConnected = vi.fn();
    window.nativeApi = {
      server: {
        connectMossApp: connect,
        listMossAppConnections: async () => ({ connections: [] }),
      },
      shell: { openExternal },
    } as never;
    function Fixture() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(true)}>Reopen fixture</button>
          <MossAppConnectDialog
            target={open ? target : null}
            onOpenChange={setOpen}
            onConnected={onConnected}
          />
        </>
      );
    }
    const mounted = await render(
      <QueryClientProvider client={client}>
        <MossLocaleScope locale="zh-CN">
          <Fixture />
        </MossLocaleScope>
      </QueryClientProvider>,
    );
    try {
      await userEvent.click(page.getByTestId("moss-app-connect-continue"));
      await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
      setAccount(client, mode === "logout" ? null : "b");
      await expect.element(page.getByTestId("moss-app-connect-dialog")).not.toBeInTheDocument();
      if (mode === "A-B-A") {
        setAccount(client, "a");
        await userEvent.click(page.getByRole("button", { name: "Reopen fixture" }));
        await expect.element(page.getByTestId("moss-app-connect-dialog")).toBeVisible();
      }
      finish({
        signInUrl: "https://connect.composio.dev/link/old-account",
        connection: {
          connectionId: "ca_old",
          toolkitSlug: "github",
          status: "pending",
          createdAt: "2026-11-06T00:00:00Z",
        },
      });
      await vi.waitFor(() => expect(client.isMutating()).toBe(0));
      expect(openExternal).not.toHaveBeenCalled();
      expect(onConnected).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
      client.clear();
      if (previous) window.nativeApi = previous;
      else delete window.nativeApi;
    }
  });
});
