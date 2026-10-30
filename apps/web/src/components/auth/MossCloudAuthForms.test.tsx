import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import {
  MossCloudForgotPasswordForm,
  MossCloudResetPasswordForm,
  MossCloudSignInForm,
  MossCloudSignUpForm,
} from "./MossCloudAuthForms";

async function renderWithRouter(element: ReactNode): Promise<string> {
  const rootRoute = createRootRoute({ component: () => element });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("Moss Cloud auth forms", () => {
  it("starts login with only the email field and its browser credential hint", async () => {
    const markup = await renderWithRouter(
      <MossCloudSignInForm pending={false} serverError={null} onSubmit={() => undefined} />,
    );

    expect(markup).toContain('for="moss-login-email"');
    expect(markup).toMatch(/autocomplete="email"/i);
    expect(markup).not.toContain('for="moss-login-password"');
    expect(markup).not.toMatch(/autocomplete="current-password"/i);
    expect(markup).not.toContain("Forgot password?");
    expect(markup).toContain('aria-live="polite"');
  });

  it("marks signup and reset password inputs as new-password fields", async () => {
    const signup = await renderWithRouter(
      <MossCloudSignUpForm pending={false} serverError={null} onSubmit={() => undefined} />,
    );
    const reset = await renderWithRouter(
      <MossCloudResetPasswordForm pending={false} serverError={null} onSubmit={() => undefined} />,
    );

    expect(signup).toMatch(/autocomplete="name"/i);
    expect(signup).toMatch(/autocomplete="new-password"/i);
    expect(reset.match(/autocomplete="new-password"/gi)).toHaveLength(2);
  });

  it("uses an email-labelled recovery form with a polite pending status", async () => {
    const markup = await renderWithRouter(
      <MossCloudForgotPasswordForm pending onSubmit={() => undefined} />,
    );

    expect(markup).toContain('for="moss-forgot-email"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Requesting a password reset link.");
  });
});
