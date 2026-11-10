// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HoverMountGate } from "./HoverMountGate";

afterEach(cleanup);

function Row({ id, enabled = true }: { id: string; enabled?: boolean }) {
  return (
    <div className="group" data-testid="row">
      <p>reply text</p>
      <HoverMountGate
        id={id}
        enabled={enabled}
        placeholderClassName="mt-1.5 block h-5"
        revealLabel="Show message actions"
      >
        <div data-testid="bar">actions</div>
      </HoverMountGate>
    </div>
  );
}

describe("HoverMountGate", () => {
  it("holds a same-height spacer until the row is hovered", () => {
    const { container, getByTestId, queryByTestId } = render(<Row id="m-hover" />);
    expect(queryByTestId("bar")).toBeNull();
    expect(container.querySelector("[data-message-actions-placeholder]")?.className).toContain(
      "h-5",
    );
    act(() => {
      getByTestId("row").dispatchEvent(new Event("pointerenter"));
    });
    expect(getByTestId("bar")).toBeTruthy();
  });

  it("mounts from the screen-reader button and stays mounted when the row returns", () => {
    const first = render(<Row id="m-keyboard" />);
    fireEvent.click(first.getByRole("button", { name: "Show message actions" }));
    expect(first.getByTestId("bar")).toBeTruthy();
    first.unmount();
    const again = render(<Row id="m-keyboard" />);
    expect(again.getByTestId("bar")).toBeTruthy();
  });

  it("mounts right away when not gated", () => {
    const { getByTestId } = render(<Row id="m-always" enabled={false} />);
    expect(getByTestId("bar")).toBeTruthy();
  });
});
