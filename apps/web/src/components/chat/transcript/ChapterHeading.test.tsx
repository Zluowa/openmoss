// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChapterHeading, chapterAnchorId } from "./ChapterHeading";

afterEach(cleanup);

describe("ChapterHeading", () => {
  it("is a heading anchored to its message", () => {
    const { getByRole } = render(<ChapterHeading messageId="m1" title="Sign-in fixed" />);
    const heading = getByRole("heading", { level: 3 });
    expect(heading.textContent).toBe("Sign-in fixed");
    expect(heading.id).toBe(chapterAnchorId("m1"));
  });

  it("renames on double-click and Enter, clearing to null when emptied", () => {
    const onRename = vi.fn();
    const { getByRole } = render(
      <ChapterHeading messageId="m1" title="Sign-in fixed" onRename={onRename} />,
    );
    fireEvent.doubleClick(getByRole("heading"));
    const input = getByRole("textbox", { name: "Chapter title" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Login works" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledExactlyOnceWith("Login works");

    fireEvent.doubleClick(getByRole("heading"));
    const again = getByRole("textbox", { name: "Chapter title" }) as HTMLInputElement;
    fireEvent.change(again, { target: { value: "  " } });
    fireEvent.blur(again);
    expect(onRename).toHaveBeenLastCalledWith(null);
  });

  it("cancels on Escape without renaming", () => {
    const onRename = vi.fn();
    const { getByRole, queryByRole } = render(
      <ChapterHeading messageId="m1" title="Sign-in fixed" onRename={onRename} />,
    );
    fireEvent.doubleClick(getByRole("heading"));
    fireEvent.keyDown(getByRole("textbox"), { key: "Escape" });
    expect(queryByRole("textbox")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });
});
