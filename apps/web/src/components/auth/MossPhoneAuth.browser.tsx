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

import type { MossAccountStartPhoneLoginResult } from "@synara/contracts";
import { MossOtherLoginOptions, MossPhoneLoginForm } from "./MossPhoneAuth";

const challenge = {
  challengeId: "challenge-1",
  phoneNumber: "+8613800138000",
  expiresAt: "2026-07-15T16:00:00.000Z",
  provider: "aliyun",
  delivery: "sent",
} as MossAccountStartPhoneLoginResult;

async function enterChallenge(onSendCode: () => Promise<MossAccountStartPhoneLoginResult>) {
  await render(
    <MossPhoneLoginForm
      pending={false}
      resendCooldownMs={0}
      serverError={null}
      onSendCode={onSendCode}
      onVerifyCode={async () => undefined}
    />,
  );
  await page.getByLabelText("手机号").fill("13800138000");
  await page.getByRole("button", { name: "获取验证码" }).click();
  await expect.element(page.getByLabelText("短信验证码")).toBeVisible();
}

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
