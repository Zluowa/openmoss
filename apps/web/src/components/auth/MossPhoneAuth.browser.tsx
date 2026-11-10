import "../../index.css";

import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";

import type { MossAccountStartPhoneLoginResult } from "@moss/contracts";
import { MossLocaleScope } from "~/localization";
import type { MossLocaleCode } from "~/uiLocale";
import { MossOtherLoginOptions, MossPhoneLoginForm } from "./MossPhoneAuth";

const challenge = {
  challengeId: "challenge-1",
  phoneNumber: "+8613800138000",
  expiresAt: "2026-07-15T16:00:00.000Z",
  provider: "aliyun",
  delivery: "sent",
} as MossAccountStartPhoneLoginResult;

async function enterChallenge(
  onSendCode: () => Promise<MossAccountStartPhoneLoginResult>,
  locale: MossLocaleCode = "zh-CN",
) {
  await render(
    <MossLocaleScope locale={locale}>
      <MossPhoneLoginForm
        pending={false}
        resendCooldownMs={0}
        serverError={null}
        onSendCode={onSendCode}
        onVerifyCode={async () => undefined}
      />
    </MossLocaleScope>,
  );
  await page.getByLabelText("手机号").fill("13800138000");
  await page.getByRole("button", { name: "获取验证码" }).click();
  await expect.element(page.getByLabelText("短信验证码")).toBeVisible();
}

const LIFETIME_PROMISE = /有效期|分钟内有效|valid until|expires/iu;

describe("Moss phone authentication", () => {
  it("renders one native OTP input behind six visual slots", async () => {
    await enterChallenge(async () => challenge);

    expect(page.getByLabelText("短信验证码").length).toBe(1);
    expect(page.getByTestId("moss-otp-slot").length).toBe(6);
  });

  it("shows Google directly and never offers legacy email/password or key bypasses", async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const rootRoute = createRootRoute({
      component: () => (
        <QueryClientProvider client={queryClient}>
          <MossOtherLoginOptions />
        </QueryClientProvider>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    await render(<RouterProvider router={router} />);

    await expect.element(page.getByRole("button", { name: "使用 Google 继续" })).toBeVisible();
    expect(page.getByRole("button", { name: "其他登录选项" }).length).toBe(0);
    expect(page.getByRole("link", { name: "邮箱登录" }).length).toBe(0);
    expect(page.getByLabelText("密码").length).toBe(0);
    expect(page.getByRole("link", { name: "Moss Key" }).length).toBe(0);
  });

  it("clears an invalid code after verification fails", async () => {
    const onVerifyCode = vi.fn(async () => {
      throw new Error("verification failed");
    });
    await render(
      <MossPhoneLoginForm
        pending={false}
        resendCooldownMs={0}
        serverError={null}
        onSendCode={async () => challenge}
        onVerifyCode={onVerifyCode}
      />,
    );
    await page.getByLabelText("手机号").fill("13800138000");
    await page.getByRole("button", { name: "获取验证码" }).click();
    const codeInput = page.getByLabelText("短信验证码");
    await codeInput.fill("123456");

    await page.getByRole("button", { name: "登录" }).click();

    await expect.element(codeInput).toHaveValue("");
    expect(onVerifyCode).toHaveBeenCalledOnce();
  });

  it("keeps the current code when requesting a replacement code fails", async () => {
    const onSendCode = vi
      .fn<() => Promise<MossAccountStartPhoneLoginResult>>()
      .mockResolvedValueOnce(challenge)
      .mockRejectedValueOnce(new Error("resend failed"));
    await enterChallenge(onSendCode);
    const codeInput = page.getByLabelText("短信验证码");
    await codeInput.fill("123456");

    await page.getByRole("button", { name: "重新获取" }).click();

    await expect.element(codeInput).toHaveValue("123456");
    expect(onSendCode).toHaveBeenCalledTimes(2);
  });

  it("says the code was sent without promising how long it lasts", async () => {
    // The challenge carries Moss's own 10-minute bookkeeping time; MemFire's
    // real code lifetime is unknown to the app and must not be shown.
    await enterChallenge(async () => challenge);

    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("验证码已发送。如果重新获取，只有最新一条短信里的验证码有效。");
    expect(document.body.textContent).not.toMatch(LIFETIME_PROMISE);
    expect(page.getByRole("button", { name: "重新获取" }).length).toBe(1);
  });

  it("says plainly that only the newest code works after a resend", async () => {
    await enterChallenge(async () => challenge);

    await page.getByRole("button", { name: "重新获取" }).click();

    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("新验证码已发送，之前的验证码已失效。");
    expect(document.body.textContent).not.toMatch(LIFETIME_PROMISE);
  });

  it("treats a code that follows a failed or timed-out request as a replacement", async () => {
    const onSendCode = vi
      .fn<() => Promise<MossAccountStartPhoneLoginResult>>()
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValueOnce(challenge);
    await render(
      <MossLocaleScope locale="en">
        <MossPhoneLoginForm
          pending={false}
          resendCooldownMs={0}
          serverError={null}
          onSendCode={onSendCode}
          onVerifyCode={async () => undefined}
        />
      </MossLocaleScope>,
    );
    await page.getByLabelText("手机号").fill("13800138000");
    await page.getByRole("button", { name: "获取验证码" }).click();
    await expect.poll(() => onSendCode.mock.calls.length).toBe(1);
    expect(page.getByRole("status").length).toBe(0);

    await page.getByRole("button", { name: "获取验证码" }).click();

    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("New code sent. Earlier codes no longer work.");
  });

  it("clears the previous code after requesting a replacement succeeds", async () => {
    const onSendCode = vi.fn(async () => challenge);
    await enterChallenge(onSendCode);
    const codeInput = page.getByLabelText("短信验证码");
    await codeInput.fill("123456");

    await page.getByRole("button", { name: "重新获取" }).click();

    await expect.element(codeInput).toHaveValue("");
    expect(onSendCode).toHaveBeenCalledTimes(2);
  });
});
