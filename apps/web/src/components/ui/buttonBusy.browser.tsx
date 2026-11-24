// FILE: buttonBusy.browser.tsx
// Purpose: A busy shared button keeps its label as its accessible name. Its spinner is
//          decorative, so "Loading" never joins the name a person (or a screen reader) finds
//          the button by.
// Layer: Web behaviour tests (real Chromium).

import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { Button } from "./button";
import { Spinner } from "./spinner";

describe("busy shared button", () => {
  it("is found by exactly its label while busy, and shows a spinner", async () => {
    await render(
      <Button busy data-testid="busy">
        Merging…
      </Button>,
    );
    const button = page.getByRole("button", { name: "Merging…", exact: true });
    await expect.element(button).toBeInTheDocument();
    const element = button.element();
    expect(element.getAttribute("aria-busy")).toBe("true");
    expect(element.querySelector("[data-slot='central-icon']")).not.toBeNull();
    expect(element.querySelector("[role='status']")).toBeNull();
    expect(element.querySelector("[aria-label='Loading']")).toBeNull();
  });

  it("is not busy by default, and a plain Spinner still announces Loading", async () => {
    await render(
      <>
        <Button>Connect</Button>
        <Spinner />
      </>,
    );
    const idle = page.getByRole("button", { name: "Connect", exact: true }).element();
    expect(idle.hasAttribute("aria-busy")).toBe(false);
    await expect.element(page.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });
});
