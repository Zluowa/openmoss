import "../../index.css";

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossCloudSignInForm } from "./MossCloudAuthForms";
import { MossAuthShell } from "./MossAuthShell";

async function mountSignInForm(input?: {
  readonly onSubmit?: (values: { email: string; password: string }) => void;
  readonly serverError?: string | null;
}) {
  const onSubmit = input?.onSubmit ?? vi.fn();
  const rootRoute = createRootRoute({
    component: () => (
      <MossCloudSignInForm
        pending={false}
        serverError={input?.serverError ?? null}
        onSubmit={onSubmit}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();

  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(<RouterProvider router={router} />, { container: host });

  return {
    onSubmit,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("MossCloudSignInForm", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("moves from email to password and submits normalized credentials", async () => {
    const form = await mountSignInForm();

    await expect.element(page.getByLabelText("Email")).toBeInTheDocument();
    expect(document.querySelector("#moss-login-password")).toBeNull();

    await page.getByLabelText("Email").fill("  PERSON@Example.COM ");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect.element(page.getByLabelText("Password")).toBeInTheDocument();
    await expect
      .element(page.getByRole("group", { name: "Email: person@example.com" }))
      .toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: "Forgot password?" })).toBeInTheDocument();

    await page.getByLabelText("Password").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Continue" }).click();

    expect(form.onSubmit).toHaveBeenCalledOnce();
    expect(form.onSubmit).toHaveBeenCalledWith({
      email: "person@example.com",
      password: "correct horse battery staple",
    });

    await form.cleanup();
  });

  it("keeps invalid email on the first step", async () => {
    const form = await mountSignInForm();

    await page.getByLabelText("Email").fill("not-an-email");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect.element(page.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(document.querySelector("#moss-login-password")).toBeNull();
    expect(form.onSubmit).not.toHaveBeenCalled();

    await form.cleanup();
  });

  it("returns to email editing and clears the password", async () => {
    const form = await mountSignInForm();

    await page.getByLabelText("Email").fill("person@example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabelText("Password").fill("temporary password");
    await page.getByRole("button", { name: "Change email from person@example.com" }).click();

    await expect.element(page.getByLabelText("Email")).toBeInTheDocument();
    expect(document.querySelector<HTMLInputElement>("#moss-login-email")?.value).toBe(
      "person@example.com",
    );

    await page.getByRole("button", { name: "Continue" }).click();
    expect(document.querySelector<HTMLInputElement>("#moss-login-password")?.value).toBe("");
    expect(form.onSubmit).not.toHaveBeenCalled();

    await form.cleanup();
  });

  it("shows server errors only with the password step", async () => {
    const form = await mountSignInForm({ serverError: "Email or password is incorrect." });

    expect(document.body.textContent).not.toContain("Email or password is incorrect.");
    await page.getByLabelText("Email").fill("person@example.com");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Email or password is incorrect.");

    await form.cleanup();
  });

  it("keeps the Electron document opaque while an auth surface is mounted", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <MossAuthShell title="Sign in to Moss">
        <p>Authentication</p>
      </MossAuthShell>,
      { container: host },
    );

    expect(document.documentElement.classList.contains("moss-opaque-surface")).toBe(true);

    await screen.unmount();
    expect(document.documentElement.classList.contains("moss-opaque-surface")).toBe(false);
    host.remove();
  });
});
