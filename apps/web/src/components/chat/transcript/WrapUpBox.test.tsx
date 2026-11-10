// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WrapUpLiveBox, WrapUpSettledCard } from "./WrapUpBox";

const box = {
  recap: "Merged 16 PRs; the China gateway is still on the old build.",
  ask: "Have you topped up Tencent Cloud?",
  actions: ["Topped up", "Not yet"],
};

afterEach(cleanup);

describe("WrapUpLiveBox", () => {
  it("shows recap, question and buttons, the recommended answer first", () => {
    const { container, getByRole } = render(<WrapUpLiveBox box={box} onAnswer={vi.fn()} />);
    expect(container.textContent).toContain(box.recap);
    expect(container.textContent).toContain(box.ask);
    expect(getByRole("button", { name: "Topped up" }).dataset.wrapUpAction).toBe("primary");
    expect(getByRole("button", { name: "Not yet" }).dataset.wrapUpAction).toBe("secondary");
  });

  it("sends the picked answer once", () => {
    const onAnswer = vi.fn().mockResolvedValue(true);
    const { getByRole } = render(<WrapUpLiveBox box={box} onAnswer={onAnswer} />);
    fireEvent.click(getByRole("button", { name: "Topped up" }));
    fireEvent.click(getByRole("button", { name: "Not yet" }));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("Topped up");
  });

  it("keeps choices available after a failed send without exposing the raw error", async () => {
    const onAnswer = vi.fn().mockRejectedValueOnce(new Error("private transport detail"));
    const { getByRole, queryByText } = render(<WrapUpLiveBox box={box} onAnswer={onAnswer} />);
    fireEvent.click(getByRole("button", { name: "Topped up" }));
    await waitFor(() => {
      expect(getByRole("alert").textContent).toBe("The reply couldn't be sent. Try again.");
      expect(getByRole("button", { name: "Topped up" }).hasAttribute("disabled")).toBe(false);
    });
    expect(queryByText("private transport detail")).toBeNull();
  });
});

describe("WrapUpSettledCard", () => {
  it("shows the answer that was picked", () => {
    const { container } = render(<WrapUpSettledCard box={box} answer="Topped up" />);
    expect(container.querySelector("[data-wrap-up-answer]")?.textContent).toBe("Topped up");
    expect(container.querySelector("button")).toBeNull();
  });

  it("lists the choices when the person wrote something else", () => {
    const { container } = render(<WrapUpSettledCard box={box} answer={null} />);
    const choices = [...container.querySelectorAll("[data-wrap-up-choices] li")].map(
      (item) => item.textContent,
    );
    expect(choices).toEqual(["Topped up", "Not yet"]);
  });
});
