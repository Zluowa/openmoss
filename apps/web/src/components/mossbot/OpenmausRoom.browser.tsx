import "~/index.css";
import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { describe, it, expect, vi } from "vitest";
import { NewRoomPanel } from "./openmaus/NewRoomPanel";
import { ManageMembersPanel } from "./openmaus/ManageMembersPanel";
import { Composer } from "./openmaus/Composer";
import { useChatScroll } from "./threebot/chatScroll";
const bots = [
  { id: "a", name: "Nova", icon: "mossbot-orbit" },
  { id: "b", name: "Atlas", icon: "mossbot-sprout" },
];
describe("OpenMaus native room ports", () => {
  it("starts a new room with the selected assistant and ignores unavailable seed identities", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    await render(
      <NewRoomPanel
        bots={bots}
        initialMemberIds={["b", "unavailable"]}
        onCreate={create}
        onClose={() => {}}
      />,
    );
    await expect
      .element(page.getByRole("checkbox", { name: "Atlas", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("checkbox", { name: "Nova", exact: true }))
      .toHaveAttribute("aria-checked", "false");
    await page.getByRole("button", { name: "Create group", exact: true }).click();
    expect(create).toHaveBeenCalledWith({ name: "Atlas", section: "", memberIds: ["b"] });
  });
  it("keeps the creation selection and context after a failed native save", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValue(undefined);
    await render(<NewRoomPanel bots={bots} onCreate={create} onClose={() => {}} />);
    await page.getByRole("textbox", { name: "Group name", exact: true }).fill("Launch");
    await page.getByRole("textbox", { name: "Group context", exact: true }).fill("Release notes");
    await page.getByRole("checkbox", { name: "Nova", exact: true }).click();
    await page.getByRole("button", { name: "Create group", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Something went wrong. Please retry.");
    await expect
      .element(page.getByRole("checkbox", { name: "Nova", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Create group", exact: true }).click();
    expect(create).toHaveBeenLastCalledWith({
      name: "Launch",
      section: "Release notes",
      memberIds: ["a"],
    });
  });
  it("saves the real member set and default responder through the host callback", async () => {
    const save = vi.fn().mockResolvedValue(undefined),
      close = vi.fn();
    await render(
      <ManageMembersPanel
        group={{ name: "Launch", memberIds: ["a", "b"], responder: "everyone" }}
        bots={bots}
        onClose={close}
        onSave={save}
      />,
    );
    await page.getByRole("checkbox", { name: "Nova", exact: true }).click();
    await page.getByRole("combobox", { name: "Default responder" }).selectOptions("mentions");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    expect(save).toHaveBeenCalledWith(["b"], "mentions", ["a", "b"]);
    expect(close).toHaveBeenCalledOnce();
  });
  it("picks duplicate names by identity, respects IME and queues with the clock action", async () => {
    const send = vi.fn().mockResolvedValue(true);
    function Harness() {
      const [text, setText] = useState("");
      return (
        <Composer
          draftId="duplicates-test"
          text={text}
          editText={setText}
          members={[bots[0]!, { ...bots[1]!, name: "Nova" }]}
          working
          disabled={false}
          onSend={send}
          onStop={() => {}}
        />
      );
    }
    await render(<Harness />);
    const input = page.getByRole("combobox", { name: "Message group" });
    await input.click();
    await input.fill("@No");
    await expect.element(page.getByRole("option").first()).toBeVisible();
    input
      .element()
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
      );
    expect(send).not.toHaveBeenCalled();
    await userEvent.keyboard("{ArrowDown}{Tab}");
    await expect.element(input).toHaveValue("@Nova ");
    await page.getByRole("button", { name: "Queue message", exact: true }).click();
    expect(send).toHaveBeenCalledWith(["b"]);
  });
  it("Escape dismisses the mention list, Shift+Enter keeps a multiline draft", async () => {
    const send = vi.fn().mockResolvedValue(true);
    function Harness() {
      const [text, setText] = useState("");
      return (
        <Composer
          draftId="escape-test"
          text={text}
          editText={setText}
          members={bots}
          working={false}
          disabled={false}
          onSend={send}
          onStop={() => {}}
        />
      );
    }
    await render(<Harness />);
    const input = page.getByRole("combobox", { name: "Message group" });
    await input.click();
    await input.fill("@");
    await userEvent.keyboard("{Escape}");
    await expect.element(input).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(send).not.toHaveBeenCalled();
  });
});
it("Threebot keeps a detached reader while content grows and restores the room on remount", async () => {
  const rows = Array.from({ length: 36 }, (_, i) => ({ id: `message-${i}` }));
  function Harness() {
    const [extra, setExtra] = useState(false);
    const scroll = useChatScroll({ threadKey: "scroll-port-test", loaded: true, entries: rows });
    return (
      <>
        <button onClick={() => setExtra(true)}>Grow</button>
        <button onClick={scroll.loadEarlier}>Earlier</button>
        <div
          data-testid="scroll"
          ref={scroll.scroller}
          onScrollCapture={scroll.onScrollCapture}
          onWheelCapture={scroll.onUserScrollIntent}
          style={{ height: 200, overflow: "auto" }}
        >
          <div className="chat-messages">
            {scroll.visibleEntries.map((row) => (
              <div data-chat-entry={row.id} key={row.id} style={{ height: 60 }}>
                {row.id}
              </div>
            ))}
            {extra && <div style={{ height: 300 }}>Tool output</div>}
          </div>
        </div>
        {scroll.showJump && <span>Detached</span>}
      </>
    );
  }
  const screen = await render(<Harness />);
  const node = page.getByTestId("scroll").element() as HTMLElement;
  await expect.poll(() => node.scrollTop).toBeGreaterThan(500);
  node.scrollTop = 200;
  node.dispatchEvent(new Event("scroll", { bubbles: true }));
  await expect.element(page.getByText("Detached", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Grow", exact: true }).click();
  await expect.poll(() => node.scrollTop).toBe(200);
  await screen.unmount();
  await render(<Harness />);
  await expect
    .poll(() => (page.getByTestId("scroll").element() as HTMLElement).scrollTop)
    .toBe(200);
});
