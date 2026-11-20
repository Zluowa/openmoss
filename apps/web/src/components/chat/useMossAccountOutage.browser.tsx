import "../../index.css";

import { TurnId, type MossAccountSessionState } from "@moss/contracts";
import { MOSS_ACCOUNT_SERVICE_UNAVAILABLE_MESSAGE } from "@moss/shared/mossManagedSession";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render, renderHook } from "vitest-browser-react";

const harness = vi.hoisted(() => ({ getMossAccountSession: vi.fn() }));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ server: { getMossAccountSession: harness.getMossAccountSession } }),
  readNativeApi: () => ({ server: { getMossAccountSession: harness.getMossAccountSession } }),
}));

import { MossLocaleScope } from "../../localization";
import { mossServerQueryKeys } from "../auth/mossServerReactQuery";
import { ThreadErrorBanner } from "./ThreadErrorBanner";
import { useMossAccountOutage } from "./useMossAccountOutage";

const signedIn: MossAccountSessionState = {
  configured: true,
  authenticated: true,
  session: null,
  smsProvider: "aliyun",
  aliyunSmsConfigured: true,
};
const failed = TurnId.makeUnsafe("turn-failed-during-outage");
let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  harness.getMossAccountSession.mockReset();
});
afterEach(() => queryClient.clear());

it("waits while the account service is down and continues the failed task once it is back", async () => {
  harness.getMossAccountSession.mockResolvedValue({ ...signedIn, accountService: "unavailable" });
  const onResume = vi.fn(async () => true);
  const hook = await renderHook(
    () => useMossAccountOutage({ enabled: true, recoverableTurnId: failed, onResume }),
    { wrapper },
  );
  await vi.waitFor(() => expect(hook.result.current.unavailable).toBe(true));
  // It asks again by itself, every 15 seconds at first.
  const observer = queryClient
    .getQueryCache()
    .find({ queryKey: mossServerQueryKeys.mossAccountSession() })!.observers[0]!;
  const interval = observer.options.refetchInterval as (query: unknown) => number | false;
  expect(
    interval(
      queryClient.getQueryCache().find({ queryKey: mossServerQueryKeys.mossAccountSession() }),
    ),
  ).toBe(15_000);
  expect(onResume).not.toHaveBeenCalled();

  // The service answers again: the next check continues the task, once.
  harness.getMossAccountSession.mockResolvedValue(signedIn);
  await queryClient.invalidateQueries({ queryKey: mossServerQueryKeys.mossAccountSession() });
  await vi.waitFor(() => expect(hook.result.current.unavailable).toBe(false));
  await vi.waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
  expect(onResume).toHaveBeenCalledWith(failed);
  await queryClient.invalidateQueries({ queryKey: mossServerQueryKeys.mossAccountSession() });
  expect(onResume).toHaveBeenCalledTimes(1);
  expect(
    interval(
      queryClient.getQueryCache().find({ queryKey: mossServerQueryKeys.mossAccountSession() }),
    ),
  ).toBe(false);
});

it("never continues a task that failed while the service worked", async () => {
  harness.getMossAccountSession.mockResolvedValue(signedIn);
  const onResume = vi.fn(async () => true);
  const hook = await renderHook(
    () => useMossAccountOutage({ enabled: true, recoverableTurnId: failed, onResume }),
    { wrapper },
  );
  await vi.waitFor(() => expect(harness.getMossAccountSession).toHaveBeenCalled());
  await queryClient.invalidateQueries({ queryKey: mossServerQueryKeys.mossAccountSession() });
  expect(hook.result.current.unavailable).toBe(false);
  expect(onResume).not.toHaveBeenCalled();
});

it("shows the outage card in Chinese with no disabled button and no gateway text", async () => {
  const screen = await render(
    <MossLocaleScope locale="zh-CN">
      <div style={{ width: 560 }}>
        <ThreadErrorBanner title="任务中断" error={MOSS_ACCOUNT_SERVICE_UNAVAILABLE_MESSAGE} />
      </div>
    </MossLocaleScope>,
  );
  const text = screen.getByText("Moss 账号服务暂时不可用，恢复后会自动继续。", { exact: true });
  await expect.element(text).toBeVisible();
  expect(text.element().getBoundingClientRect().height).toBeGreaterThan(0);
  const alert = page.getByRole("alert").element();
  expect(alert.textContent).not.toMatch(/401|https?:|继续任务/u);
  for (const button of alert.querySelectorAll("button"))
    expect((button as HTMLButtonElement).disabled).toBe(false);
});
