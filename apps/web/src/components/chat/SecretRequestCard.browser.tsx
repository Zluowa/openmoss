import "../../index.css";

import {
  SECRET_REQUEST_ERROR_CODES,
  ThreadId,
  type NativeApi,
  type SecretRequestActivityPayload,
  type SecretRequestAnswerInput,
} from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { SecretRequestCard } from "./SecretRequestCard";

const THREAD = ThreadId.makeUnsafe("thread-secret-card");
const VALUE = "ghp_card-value-that-stays-private";
const request: SecretRequestActivityPayload = {
  requestId: `secret-request:${"d".repeat(32)}`,
  label: "Tailscale auth key for test VMs",
  reason: "Joins three throwaway VMs to your tailnet. Create it at login.tailscale.com.",
};

function installAnswer(answer: (input: SecretRequestAnswerInput) => Promise<void>) {
  const spy = vi.fn(answer);
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    writable: true,
    value: { secretRequests: { answer: spy } } as unknown as NativeApi,
  });
  return spy;
}

afterEach(async () => {
  await cleanup();
  Reflect.deleteProperty(window, "nativeApi");
});

it("saves a masked value privately and settles in place", async () => {
  const answer = installAnswer(async () => {});
  const screen = await render(<SecretRequestCard request={request} threadId={THREAD} />);
  const input = screen.getByLabelText(request.label);
  const save = screen.getByRole("button", { name: "Save securely" });

  await expect.element(screen.getByText(request.reason)).toBeVisible();
  await expect
    .element(screen.getByText("Kept out of chat, in a private file", { exact: false }))
    .toBeVisible();
  await expect.element(save).toBeDisabled();
  const field = input.element() as HTMLInputElement;
  expect(
    field.type === "password" ||
      getComputedStyle(field).getPropertyValue("-webkit-text-security") === "disc",
  ).toBe(true);

  await input.fill(`  ${VALUE}  `);
  await save.click();
  expect(answer).toHaveBeenCalledExactlyOnceWith({
    threadId: THREAD,
    requestId: request.requestId,
    answer: { type: "save", secret: VALUE },
  });
  await expect
    .element(screen.getByText("Saved privately for the agent", { exact: false }))
    .toBeVisible();
  expect(screen.container.querySelector("input")).toBeNull();
  expect(screen.container.textContent).not.toContain(VALUE);
});

it("declines without sending a value", async () => {
  const answer = installAnswer(async () => {});
  const screen = await render(<SecretRequestCard request={request} threadId={THREAD} />);
  await screen.getByRole("button", { name: "Decline" }).click();
  expect(answer).toHaveBeenCalledExactlyOnceWith({
    threadId: THREAD,
    requestId: request.requestId,
    answer: { type: "decline" },
  });
  await expect.element(screen.getByText("Declined", { exact: false })).toBeVisible();
});

it("shows the server's refusal but never an error that could quote the value", async () => {
  installAnswer(async () => {
    throw { code: SECRET_REQUEST_ERROR_CODES.ended, message: "This request has already ended." };
  });
  const screen = await render(<SecretRequestCard request={request} threadId={THREAD} />);
  await screen.getByLabelText(request.label).fill(VALUE);
  await screen.getByRole("button", { name: "Save securely" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("This request has already ended.");

  installAnswer(async () => {
    throw new Error(`Expected a string, got "${VALUE}"`);
  });
  await screen.getByRole("button", { name: "Save securely" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Could not answer the request. Try again.");
  expect(screen.getByRole("alert").element().textContent).not.toContain(VALUE);
});

it("renders a settled request as one line with nothing to answer", async () => {
  installAnswer(async () => {});
  const screen = await render(
    <SecretRequestCard request={{ ...request, outcome: "timed_out" }} threadId={THREAD} />,
  );
  await expect.element(screen.getByText(`${request.label} · No answer in time`)).toBeVisible();
  expect(screen.container.querySelector("input, button")).toBeNull();
});
