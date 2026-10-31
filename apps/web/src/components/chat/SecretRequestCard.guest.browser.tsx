import "../../index.css";

import { ThreadId, type SecretRequestActivityPayload } from "@synara/contracts";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { detachNativeApi } from "~/nativeApi";

import { SecretRequestCard } from "./SecretRequestCard";

const request: SecretRequestActivityPayload = {
  requestId: `secret-request:${"d".repeat(32)}`,
  label: "Tailscale auth key",
  reason: "Joins three throwaway VMs to your tailnet.",
};

// Its own file: detaching lasts for the page, as it does on the guest page.
it("offers no form on a page with no Moss server to take the answer", async () => {
  detachNativeApi();
  const screen = await render(
    <SecretRequestCard request={request} threadId={ThreadId.makeUnsafe("thread-guest")} />,
  );
  await expect.element(screen.getByText(`${request.label} · Waiting for an answer`)).toBeVisible();
  expect(screen.container.querySelector("input, button")).toBeNull();
});
