import "../../index.css";
import type { DesktopBridge, DesktopPhoneAccessState } from "@moss/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MossLocaleScope } from "~/localization";
import { getAppTypographyCssVariables } from "~/lib/appTypography";
import { getDensityCssVariables } from "~/lib/appDensity";
import { buildThemeCssVariables, getCodeThemeSeed } from "~/theme/theme.logic";
import { PhoneSettingsPanel } from "./PhoneSettingsPanel";

const LAN_ORIGINS = ["http://192.168.1.42:3773", "http://100.101.20.7:3773"];
const server = vi.hoisted(() => ({ lanOrigins: [] as string[] }));
vi.mock("~/nativeApi", async (original) => {
  const api = {
    server: {
      getAuthSession: async () => ({ authenticated: true, role: "owner" }),
      getConfig: async () => ({ lanOrigins: server.lanOrigins }),
      listAuthPairingLinks: async () => [],
      listAuthClients: async () => [],
      revokeAuthPairingLink: async () => undefined,
    },
  };
  return {
    ...(await original<typeof import("../../nativeApi")>()),
    readNativeApi: () => api,
    ensureNativeApi: () => api,
  };
});

const OFF: DesktopPhoneAccessState = {
  enabled: false,
  active: "off",
  unavailableReason: null,
  error: null,
};

/** A desktop whose background service becomes reachable when the switch is flipped. */
function installDesktop(initial: DesktopPhoneAccessState) {
  let state = initial;
  const set = vi.fn(async (request: { enabled: boolean }) => {
    state = { ...state, ...request, active: request.enabled ? "lan" : "off" };
    server.lanOrigins = request.enabled ? LAN_ORIGINS : [];
    return state;
  });
  window.desktopBridge = {
    phoneAccess: { getState: async () => state, set },
  } as unknown as DesktopBridge;
  return set;
}

function applyTheme(variant: "light" | "dark") {
  const theme = buildThemeCssVariables(
    { codeThemeId: "moss", theme: getCodeThemeSeed("moss", variant) },
    variant,
  );
  for (const [key, value] of Object.entries({
    ...theme.variables,
    ...getAppTypographyCssVariables(),
    ...getDensityCssVariables(),
  })) {
    document.documentElement.style.setProperty(key, value);
  }
  document.documentElement.classList.toggle("dark", variant === "dark");
}

const mount = (locale: "en" | "zh-CN" = "en") =>
  render(
    <MossLocaleScope locale={locale}>
      <div style={{ width: 760, padding: 24 }} className="bg-background text-foreground">
        <PhoneSettingsPanel active />
      </div>
    </MossLocaleScope>,
  );

const rootStyle = document.documentElement.getAttribute("style");
beforeEach(async () => {
  await page.viewport(820, 760);
  server.lanOrigins = [];
  applyTheme("dark");
});
afterEach(() => {
  delete window.desktopBridge;
  if (rootStyle === null) document.documentElement.removeAttribute("style");
  else document.documentElement.setAttribute("style", rootStyle);
  document.documentElement.classList.remove("dark");
});

it("is off by default and offers no pairing code until the desktop switch is on", async () => {
  const set = installDesktop(OFF);
  const screen = await mount();
  const access = page.getByRole("switch", { name: "Allow phone connections", exact: true });
  await expect.element(access).not.toBeChecked();
  await expect.element(page.getByTestId("phone-settings-local-only")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Show pairing QR code" }))
    .not.toBeInTheDocument();
  // The warning says plainly that the sign-in travels unencrypted.
  await expect
    .element(page.getByText(/unencrypted HTTP on your network, including the key/))
    .toBeInTheDocument();

  await access.click();
  expect(set).toHaveBeenCalledWith({ enabled: true });
  await expect.element(access).toBeChecked();
  await expect
    .element(page.getByRole("button", { name: "Show pairing QR code" }))
    .toBeInTheDocument();
  await expect.element(page.getByRole("radio", { name: "192.168.1.42" })).toBeChecked();
  await screen.unmount();
});

it("explains why a development build cannot be reached", async () => {
  installDesktop({ ...OFF, enabled: true, unavailableReason: "development" });
  const screen = await mount();
  const access = page.getByRole("switch", { name: "Allow phone connections", exact: true });
  await expect.element(access).toBeDisabled();
  await expect.element(access).not.toBeChecked();
  await expect
    .element(page.getByText("A development build cannot be reached from a phone."))
    .toBeInTheDocument();
  await screen.unmount();
});

it("sends a browser to the desktop app, even when the server is reachable", async () => {
  server.lanOrigins = LAN_ORIGINS;
  const screen = await mount();
  await expect
    .element(page.getByTestId("phone-settings-local-only"))
    .toHaveTextContent("Pair a phone from the Moss desktop app");
  await expect.element(page.getByTestId("phone-access")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Show pairing QR code" }))
    .not.toBeInTheDocument();
  await screen.unmount();
});

for (const variant of ["light", "dark"] as const) {
  it(`reads clearly in Chinese, ${variant}`, async () => {
    applyTheme(variant);
    installDesktop(OFF);
    const screen = await mount("zh-CN");
    const access = page.getByRole("switch", { name: "允许手机连接", exact: true });
    await expect.element(access).toBeVisible();
    await page.screenshot({ path: `__screenshots__/phone-access-off-${variant}.png` });
    await access.click();
    await expect.element(page.getByRole("button", { name: "显示配对二维码" })).toBeVisible();
    await page.screenshot({ path: `__screenshots__/phone-access-on-${variant}.png` });
    await screen.unmount();
  });
}

// Settings one-set 5/5: the plain-HTTP warning is one sentence, in both languages and themes.
for (const variant of ["light", "dark"] as const) {
  for (const [locale, switchName, line] of [
    [
      "en",
      "Allow phone connections",
      "Unencrypted HTTP: use it only on a network you trust. Voice input is off.",
    ],
    ["zh-CN", "允许手机连接", "未加密的 HTTP，请只在可信的网络中使用；语音输入不可用。"],
  ] as const) {
    it(`settings one-set 5/5: shows the one-line plain-HTTP warning, ${locale} ${variant}`, async () => {
      applyTheme(variant);
      installDesktop(OFF);
      const screen = await mount(locale);
      await page.getByRole("switch", { name: switchName, exact: true }).click();
      const warning = page.getByText(line, { exact: true });
      await expect.element(warning).toBeVisible();
      const box = warning.element().getBoundingClientRect();
      expect(box.height).toBeGreaterThan(0);
      expect(document.body.textContent).not.toMatch(/Voice input needs HTTPS|语音输入需要 HTTPS/u);
      await screen.unmount();
    });
  }
}
