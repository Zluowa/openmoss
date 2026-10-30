import "../../index.css";

import { formatProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

const LONG_ERROR = [
  "Provider request failed",
  "Connection closed while waiting for a response",
  "Acceptance could not be confirmed",
  "Additional provider details",
  "Final diagnostic line",
].join("\n");

// A single-line, jargon-free provider message that the presentation layer
// (resolveThreadErrorPresentation) passes through unchanged. It is long enough
// to line-clamp inside a narrow pane, which is the only way the details
// disclosure appears: multiline/diagnostic raw errors are sanitized to a short
// generic title and never render their raw text.
const LONG_SAFE_ERROR =
  "The provider request failed while waiting for a response and the acceptance could not be " +
  "confirmed before the connection closed during the final delivery attempt so please try again " +
  "later today";

describe("ThreadErrorBanner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("expands a long safe error and collapses it accessibly", async () => {
    await render(
      <div style={{ width: 320 }}>
        <ThreadErrorBanner error={LONG_SAFE_ERROR} />
      </div>,
    );
    const show = page.getByRole("button", { name: "Show details" });
    await expect.element(show).toHaveAttribute("aria-expanded", "false");
    const detailsId = show.element().getAttribute("aria-controls");
    expect(detailsId).toBeTruthy();

    await show.click();
    const hide = page.getByRole("button", { name: "Hide details" });
    await expect.element(hide).toHaveAttribute("aria-expanded", "true");
    const fullError = document.getElementById(detailsId!)!;
    expect(fullError.textContent).toBe(LONG_SAFE_ERROR);
    await expect.element(fullError).toBeVisible();
    expect(getComputedStyle(fullError).whiteSpace).toBe("pre-wrap");
    expect(getComputedStyle(fullError).webkitLineClamp).toBe("none");

    await hide.click();
    await expect.element(show).toHaveAttribute("aria-expanded", "false");
    expect(getComputedStyle(fullError).webkitLineClamp).toBe("3");
    // The error text is rendered once, collapsed or expanded.
    expect(page.getByText("provider request failed", { exact: false }).elements()).toHaveLength(1);
  });

  it("sanitizes long diagnostic errors without widening a narrow pane", async () => {
    const error = `${"x".repeat(500)}\n${Array.from({ length: 30 }, (_, index) => `Detail ${index}`).join("\n")}`;
    await render(
      <div style={{ width: 320 }}>
        <ThreadErrorBanner error={error} onDismiss={() => {}} />
      </div>,
    );
    // Multiline raw diagnostics never reach the banner: the presentation layer
    // replaces them with the localized generic title, so there is nothing to
    // expand or scroll. The shared browser fixture chooses English.
    const alert = page.getByRole("alert");
    await expect.element(alert).toBeVisible();
    const text = alert.element().querySelector("p[data-translation-skip]")!;
    expect(text.textContent).toBe(
      "The provider could not complete this request. Try again shortly.",
    );
    expect(text.getAttribute("title")).toBe(
      "The provider could not complete this request. Try again shortly.",
    );
    await expect.element(page.getByRole("button", { name: /details/ })).not.toBeInTheDocument();
    expect(alert.element().getBoundingClientRect().width).toBeLessThanOrEqual(320);
  });

  it("copies every line while collapsed and confirms success", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await render(<ThreadErrorBanner error={LONG_ERROR} />);
    await page.getByRole("button", { name: "Copy error", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Copied error" })).toBeVisible();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(LONG_ERROR);
  });

  it("resets details and copy feedback when the error changes", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const screen = await render(
      <div style={{ width: 320 }}>
        <ThreadErrorBanner error={LONG_SAFE_ERROR} />
      </div>,
    );
    await page.getByRole("button", { name: "Show details" }).click();
    await page.getByRole("button", { name: "Copy error", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Copied error" })).toBeVisible();

    await screen.rerender(
      <div style={{ width: 320 }}>
        <ThreadErrorBanner error="A different provider error" />
      </div>,
    );
    // Short errors fit in the collapsed text, so there is nothing to expand.
    await expect.element(page.getByRole("button", { name: /details/ })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Copy error", exact: true }))
      .toBeVisible();
    await screen.rerender(<ThreadErrorBanner error={null} />);
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });

  it("only offers existing unblock recovery for quarantine and never resends errors", async () => {
    const onUnblock = vi.fn();
    const onDismiss = vi.fn();
    const screen = await render(
      <ThreadErrorBanner error={LONG_ERROR} onUnblock={onUnblock} onDismiss={onDismiss} />,
    );
    await expect
      .element(page.getByRole("button", { name: "Retry", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Unblock thread" }))
      .not.toBeInTheDocument();

    const quarantine = formatProviderDeliveryBlockDetail("Acceptance is uncertain");
    await screen.rerender(
      <ThreadErrorBanner error={quarantine} onUnblock={onUnblock} onDismiss={onDismiss} />,
    );
    await page.getByRole("button", { name: "Unblock thread" }).click();
    expect(onUnblock).toHaveBeenCalledExactlyOnceWith();
    await screen.rerender(
      <ThreadErrorBanner error={quarantine} onUnblock={onUnblock} unblocking />,
    );
    await expect.element(page.getByRole("button", { name: "Unblocking…" })).toBeDisabled();

    await screen.rerender(<ThreadErrorBanner error={quarantine} onDismiss={onDismiss} />);
    await expect
      .element(page.getByRole("button", { name: "Unblock thread" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Dismiss error" }).click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onUnblock).toHaveBeenCalledTimes(1);
  });
});
