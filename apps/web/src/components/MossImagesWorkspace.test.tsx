// @vitest-environment happy-dom
// Exercises the real workspace state machine; shared visual primitives are isolated.
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MossImagesError, type MossImageJob, type MossImagesCatalog } from "~/lib/mossImagesClient";

const calls = vi.hoisted(() => ({
  load: vi.fn(),
  home: vi.fn(),
  history: vi.fn(),
  loadJob: vi.fn(),
  generate: vi.fn(),
  wait: vi.fn(),
  assetReference: vi.fn(),
}));
const accountSource = vi.hoisted(() => ({ key: "settled:a", transitioning: false }));
vi.mock("~/lib/mossImagesAccountBoundary", () => ({
  useMossImagesAccountBoundary: () => ({
    ...accountSource,
    isCurrent: () => !accountSource.transitioning,
  }),
}));
vi.mock("~/lib/mossImagesClient", async (original) => ({
  ...(await original<typeof import("~/lib/mossImagesClient")>()),
  loadMossImagesCatalog: calls.load,
  loadMossImagesHome: calls.home,
  loadMossImagesHistory: calls.history,
  loadMossImageJob: calls.loadJob,
  requestMossImagesGenerate: calls.generate,
  waitForMossImageJob: calls.wait,
  readMossImageAssetReference: calls.assetReference,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/lib/icons", () => ({
  ArrowUpIcon: () => null,
  PlusIcon: () => null,
  XIcon: () => null,
  ChevronLeftIcon: () => null,
  ChevronRightIcon: () => null,
  ChevronDownIcon: () => null,
  MicIcon: () => null,
  BookIcon: () => null,
}));
vi.mock("./images/MossImagesVoiceInput", () => ({ MossImagesVoiceInput: () => null }));
vi.mock("./images/MossImagesComposer", () => ({
  MossImagesComposer: (
    props: import("react").ComponentProps<
      typeof import("./images/MossImagesComposer").MossImagesComposer
    >,
  ) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSend({ provider: "codex", instanceId: "codex", model: "gpt-5.4" });
      }}
    >
      {props.beforeEditor}
      <textarea
        aria-label={props.isEditing ? "描述要如何修改当前图像" : "描述要创建的图像"}
        value={props.prompt}
        disabled={props.busy}
        onChange={(event) => props.onPromptChange(event.target.value)}
        onPaste={(event) =>
          props.onPasteFiles(
            Array.from(event.clipboardData.items).flatMap((item) => {
              const file = item.kind === "file" ? item.getAsFile() : null;
              return file ? [file] : [];
            }),
          )
        }
      />
      {props.attachments}
      <button
        type="button"
        aria-label="添加参考图"
        disabled={!props.canAttach}
        onClick={props.onAttach}
      >
        添加参考图
      </button>
      {props.busy ? (
        <button type="button" onClick={props.onStop}>
          停止等待
        </button>
      ) : (
        <button type="submit" disabled={!props.canSend}>
          {props.isEditing ? "编辑图像" : "生成图像"}
        </button>
      )}
      {props.notice}
    </form>
  ),
}));
vi.mock("./ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverPopup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({
    children,
    render: _render,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { render?: React.ReactElement }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("./MossCodexShellTopTabChrome", () => ({
  MossCodexShellTopTabChrome: ({
    tabs,
    onNewTab,
    onCloseTab,
  }: {
    tabs: { id: string }[];
    onNewTab: () => void;
    onCloseTab: (id: string) => void;
  }) => (
    <div>
      <button onClick={onNewTab}>New tab</button>
      <button onClick={() => onCloseTab(tabs[0]!.id)}>Close first tab</button>
    </div>
  ),
}));
vi.mock("./chat/GeneratedImagePreviewPane", () => ({
  GeneratedImagePreviewPane: ({
    pane,
    resolveImageUrl,
  }: {
    pane: { imagePreview: { images: { id: string; path: string }[]; activeImageId: string } };
    resolveImageUrl: (input: { src: string }) => string;
  }) => {
    const image = pane.imagePreview.images.find(
      (entry) => entry.id === pane.imagePreview.activeImageId,
    );
    return (
      <div data-testid="shared-gallery">
        {image && <img alt="Preview" src={resolveImageUrl({ src: image.path })} />}
      </div>
    );
  },
}));
vi.mock("./ui/button", async (original) => ({
  ...(await original<typeof import("./ui/button")>()),
  Button: ({
    render: renderElement,
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    render?: React.ReactElement;
    variant?: string;
    size?: string;
  }) =>
    renderElement ? (
      React.cloneElement(renderElement, {}, children)
    ) : (
      <button type="button" {...props}>
        {children}
      </button>
    ),
}));
vi.mock("./ui/textarea", () => ({
  Textarea: ({
    unstyled: _unstyled,
    ...props
  }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { unstyled?: boolean }) => (
    <textarea {...props} />
  ),
}));
vi.mock("./ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
    disabled,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
    disabled: boolean;
  }) => (
    <select
      aria-label={value?.includes(":") ? "图像比例" : "图像模型"}
      value={value ?? ""}
      onChange={(event) => onValueChange(event.target.value)}
      disabled={disabled}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

import { MossImagesWorkspace } from "./MossImagesWorkspace";
import type { MossImagesConversationInput } from "~/lib/mossImagesConversation";

const complete: MossImageJob = {
  jobId: "moss_first",
  status: "succeeded",
  prompt: "A kitten",
  createdAt: "2026-10-09T00:00:00.000Z",
  modelId: "gpt-image-2-official",
  imageUrls: ["https://assets.example/kitten.png"],
  billingStatus: "captured",
};
const initial: MossImagesCatalog = {
  account: { id: "account-a", realm: "memfire-phone" },
  models: [
    {
      id: complete.modelId,
      label: "GPT Image",
      kind: "image",
      installed: true,
      available: true,
      supportsReferences: true,
    },
  ],
  jobs: [],
};
beforeEach(() => {
  vi.stubGlobal("React", React);
  accountSource.key = "settled:a";
  accountSource.transitioning = false;
  calls.load.mockReset().mockResolvedValue(initial);
  calls.home.mockReset().mockResolvedValue({ ...initial, models: [], nextCursor: null });
  calls.history
    .mockReset()
    .mockResolvedValue({ account: initial.account, jobs: [], nextCursor: null });
  calls.loadJob.mockReset().mockResolvedValue(complete);
  calls.assetReference.mockReset().mockResolvedValue("data:image/png;base64,Y2FjaGVkLWltYWdl");
  calls.generate.mockReset().mockResolvedValue(complete);
  calls.wait.mockReset().mockImplementation(async ({ job }: { job: MossImageJob }) => job);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function ready() {
  const view = render(<MossImagesWorkspace onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy());
  return view;
}

describe("MossImagesWorkspace account media lifecycle", () => {
  it("hands the prompt and original reference file to one normal conversation without a direct media POST", async () => {
    let finish!: () => void;
    const startConversation = vi.fn(
      (_input: MossImagesConversationInput) =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(
      <MossImagesWorkspace onClose={vi.fn()} onStartConversation={startConversation} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "上传照片" })).toBeTruthy());
    const file = new File(["reference-bytes"], "reference.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("参考图文件"), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "移除 reference.png" })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("描述要创建的图像"), {
      target: { value: "无人机视角" },
    });
    const form = view.container.querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(startConversation).toHaveBeenCalledTimes(1));
    expect(startConversation.mock.calls[0]?.[0]).toMatchObject({
      prompt: "无人机视角",
      references: [file],
    });
    expect(startConversation.mock.calls[0]?.[0]).not.toHaveProperty("modelId");
    expect(calls.home).toHaveBeenCalledTimes(1);
    expect(calls.load).not.toHaveBeenCalled();
    expect(calls.generate).not.toHaveBeenCalled();
    expect(view.container.querySelector("[data-moss-images-result]")).toBeNull();
    finish();
  });
  it("lets the ordinary CLI send and attach files while local image history is unavailable", async () => {
    calls.home.mockRejectedValue(
      new MossImagesError("历史暂不可用", "media_history_unavailable", 503),
    );
    const startConversation = vi.fn(async (_input: MossImagesConversationInput) => undefined);
    const view = render(
      <MossImagesWorkspace onClose={vi.fn()} onStartConversation={startConversation} />,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("生成记录暂时无法读取"),
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "上传照片" }).disabled).toBe(
      false,
    );
    fireEvent.change(screen.getByLabelText("描述要创建的图像"), {
      target: { value: "生成一只猫" },
    });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "生成图像" }).disabled).toBe(
      false,
    );
    fireEvent.submit(view.container.querySelector("form")!);
    await waitFor(() => expect(startConversation).toHaveBeenCalledTimes(1));
    expect(calls.load).not.toHaveBeenCalled();
    expect(calls.generate).not.toHaveBeenCalled();
  });
  it("uses the initial history cursor once and keeps loaded older pages across refresh", async () => {
    const older = { ...complete, jobId: "moss_older", prompt: "Older kitten" };
    calls.home.mockResolvedValue({ ...initial, models: [], jobs: [complete], nextCursor: "older" });
    calls.history.mockResolvedValue({ account: initial.account, jobs: [older], nextCursor: null });
    render(<MossImagesWorkspace onClose={vi.fn()} onStartConversation={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "加载更多图像" })).toBeTruthy());
    expect(calls.history).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "加载更多图像" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "打开图像：Older kitten" })).toBeTruthy(),
    );
    expect(calls.history).toHaveBeenCalledWith(
      { expectedAccount: initial.account, cursor: "older" },
      expect.any(AbortSignal),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(calls.home).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "打开图像：Older kitten" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加载更多图像" })).toBeNull();
    expect(calls.history).toHaveBeenCalledTimes(1);
    expect(calls.generate).not.toHaveBeenCalled();
  });
  it("preserves a CLI draft and local reference while the first history read finishes", async () => {
    let finishHistory!: (catalog: MossImagesCatalog) => void;
    let resumeReference!: () => void;
    const originalRead = FileReader.prototype.readAsDataURL;
    const fileRead = vi
      .spyOn(FileReader.prototype, "readAsDataURL")
      .mockImplementationOnce(function (this: FileReader, blob: Blob) {
        resumeReference = () => originalRead.call(this, blob);
      });
    calls.home.mockImplementationOnce(
      () =>
        new Promise<MossImagesCatalog>((resolve) => {
          finishHistory = resolve;
        }),
    );
    render(<MossImagesWorkspace onClose={vi.fn()} onStartConversation={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("描述要创建的图像"), {
      target: { value: "保留这段描述" },
    });
    const file = new File(["image"], "before-history.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("参考图文件"), { target: { files: [file] } });
    await waitFor(() => expect(resumeReference).toBeTypeOf("function"));
    fileRead.mockRestore();
    await act(async () => finishHistory({ ...initial, models: [], nextCursor: null }));
    act(() => resumeReference());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "移除 before-history.png" })).toBeTruthy(),
    );
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "描述要创建的图像" }).value,
    ).toBe("保留这段描述");
    expect(screen.getByRole("button", { name: "移除 before-history.png" })).toBeTruthy();
  });
  it("opens native Canvas tools without querying or choosing a hidden image model", async () => {
    calls.home.mockResolvedValue({ ...initial, models: [], jobs: [complete], nextCursor: null });
    const edit = vi.fn();
    render(
      <MossImagesWorkspace onClose={vi.fn()} onStartConversation={vi.fn()} onEditInCanvas={edit} />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "打开图像：A kitten" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "打开图像：A kitten" }));
    for (const [name, action] of [
      ["标注", "annotate"],
      ["擦除", "erase"],
      ["移除背景", "remove-background"],
      ["调整大小", "resize"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(edit).toHaveBeenLastCalledWith(
        { jobId: complete.jobId, imageIndex: 0, action },
        expect.any(Function),
      );
    }
    expect(calls.load).not.toHaveBeenCalled();
    expect(calls.generate).not.toHaveBeenCalled();
  });
  it("clears a CLI draft and rejects a late history page when an account mutation starts", async () => {
    let finishHistory!: (catalog: MossImagesCatalog) => void;
    calls.home.mockImplementationOnce(
      () =>
        new Promise<MossImagesCatalog>((resolve) => {
          finishHistory = resolve;
        }),
    );
    const view = render(<MossImagesWorkspace onClose={vi.fn()} onStartConversation={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("描述要创建的图像"), {
      target: { value: "账号 A 草稿" },
    });
    accountSource.key = "pending:b";
    accountSource.transitioning = true;
    view.rerender(<MossImagesWorkspace onClose={vi.fn()} onStartConversation={vi.fn()} />);
    await act(async () =>
      finishHistory({ ...initial, models: [], jobs: [complete], nextCursor: null }),
    );
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "描述要创建的图像" }).value,
    ).toBe("");
    expect(screen.queryByRole("button", { name: "打开图像：A kitten" })).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "生成图像" }).disabled).toBe(true);
    expect(calls.generate).not.toHaveBeenCalled();
  });
  it("blocks new generation while the media wallet awaits payment review", async () => {
    calls.load.mockResolvedValue({
      ...initial,
      mediaWallet: {
        walletKind: "media_cost_v1",
        currency: "CNY",
        pointsPerCny: 100,
        availableNanoCny: "1000000000",
        heldNanoCny: "1",
        reviewRequired: true,
      },
    });
    await ready();
    await waitFor(() => expect(screen.getByText("历史付款记录待核实，暂不能生成。")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("描述要创建的图像"), {
      target: { value: "A landscape" },
    });
    expect((screen.getByRole("button", { name: "生成图像" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.submit(screen.getByLabelText("描述要创建的图像").closest("form")!);
    expect(calls.generate).not.toHaveBeenCalled();
  });
  it("uses the same bounded reference intake for drop and clipboard files", async () => {
    await ready();
    const dropped = new File(["png"], "dropped.png", { type: "image/png" });
    fireEvent.drop(screen.getByRole("region", { name: "Moss Images" }), {
      dataTransfer: { types: ["Files"], files: [dropped] },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "移除 dropped.png" })).toBeTruthy(),
    );
    const pasted = new File(["jpeg"], "pasted.jpg", { type: "image/jpeg" });
    fireEvent.paste(screen.getByLabelText("描述要创建的图像"), {
      clipboardData: { items: [{ kind: "file", getAsFile: () => pasted }] },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "移除 pasted.jpg" })).toBeTruthy(),
    );
    fireEvent.drop(screen.getByRole("region", { name: "Moss Images" }), {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["svg"], "unsafe.svg", { type: "image/svg+xml" })],
      },
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("仅支持 PNG"));
    expect(calls.generate).not.toHaveBeenCalled();
  });

  it("rejects dropped images when the selected model cannot accept references", async () => {
    calls.load.mockResolvedValue({
      ...initial,
      models: [{ ...initial.models[0], supportsReferences: false }],
    });
    await ready();
    fireEvent.drop(screen.getByRole("region", { name: "Moss Images" }), {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["png"], "dropped.png", { type: "image/png" })],
      },
    });
    expect(screen.getByRole("alert").textContent).toContain("不支持参考图");
    expect(screen.queryByRole("button", { name: "移除 dropped.png" })).toBeNull();
  });

  it("does not advertise an independent media balance or recharge even for historical wallet data", async () => {
    const mediaJob: MossImageJob = {
      ...complete,
      billing: { walletKind: "media_cost_v1", creditsCharged: 0, reservedNanoCny: "10000000" },
    };
    calls.load.mockResolvedValue({
      ...initial,
      jobs: [mediaJob],
      mediaWallet: {
        walletKind: "media_cost_v1",
        currency: "CNY",
        pointsPerCny: 100,
        availableNanoCny: "9007199254740993",
        heldNanoCny: "1",
      },
    });
    await ready();
    expect(screen.queryByText(/媒体积分/)).toBeNull();
    expect(screen.getByRole("link", { name: "套餐用量" })).toBeTruthy();
    expect(screen.queryByText("充值")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^打开图像：A kitten/ }));
    expect(screen.getByText("费用待结算")).toBeTruthy();
    expect(screen.queryByText(/扣除 0/)).toBeNull();
  });

  it("generates with the selected installed model and edits the selected original image", async () => {
    await ready();
    calls.load.mockResolvedValue({ ...initial, jobs: [complete] });
    fireEvent.change(screen.getByLabelText("描述要创建的图像"), { target: { value: "A kitten" } });
    fireEvent.click(screen.getByRole("button", { name: "生成图像" }));
    await waitFor(() =>
      expect(screen.getByAltText("Preview").getAttribute("src")).toBe(complete.imageUrls[0]),
    );
    expect(calls.generate.mock.calls[0]?.[0]).toMatchObject({
      prompt: "A kitten",
      modelId: complete.modelId,
    });
    const second = {
      ...complete,
      jobId: "moss_second",
      prompt: "Make the background purple",
      imageUrls: ["https://assets.example/purple.png"],
    };
    calls.generate.mockResolvedValueOnce(second);
    calls.load.mockResolvedValue({ ...initial, jobs: [complete, second] });
    fireEvent.change(screen.getByLabelText("描述要如何修改当前图像"), {
      target: { value: second.prompt },
    });
    fireEvent.click(screen.getByRole("button", { name: "编辑图像" }));
    await waitFor(() => expect(calls.generate).toHaveBeenCalledTimes(2));
    expect(calls.generate.mock.calls[1]?.[0]).toMatchObject({
      prompt: second.prompt,
      referenceImages: complete.imageUrls,
    });
    await waitFor(() =>
      expect(screen.getByAltText("Preview").getAttribute("src")).toBe(second.imageUrls[0]),
    );
  });

  it("preserves the original image and edit draft when the model Skill is unavailable", async () => {
    calls.load.mockResolvedValue({ ...initial, jobs: [complete] });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /^打开图像：A kitten/ }));
    calls.generate.mockRejectedValueOnce(
      new MossImagesError("Skill unavailable", "media_skill_not_installed", 403),
    );
    fireEvent.change(screen.getByLabelText("描述要如何修改当前图像"), {
      target: { value: "Move the sun left" },
    });
    fireEvent.click(screen.getByRole("button", { name: "编辑图像" }));
    await waitFor(() => expect(calls.generate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByAltText("Preview").getAttribute("src")).toBe(complete.imageUrls[0]);
    expect((screen.getByLabelText("描述要如何修改当前图像") as HTMLTextAreaElement).value).toBe(
      "Move the sun left",
    );
    expect(calls.load).toHaveBeenCalledTimes(1);
  });

  it("uses an immediate in-flight guard against duplicate paid submissions", async () => {
    let finish!: (job: MossImageJob) => void;
    calls.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await ready();
    fireEvent.change(screen.getByLabelText("描述要创建的图像"), { target: { value: "A kitten" } });
    const form = screen.getByLabelText("描述要创建的图像").closest("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(calls.generate).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(complete);
    });
  });

  it("stops observation and ignores a late provider result", async () => {
    let finish!: (job: MossImageJob) => void;
    calls.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await ready();
    fireEvent.change(screen.getByLabelText("描述要创建的图像"), { target: { value: "A kitten" } });
    fireEvent.click(screen.getByRole("button", { name: "生成图像" }));
    const signal = calls.generate.mock.calls[0]?.[1] as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "停止等待" }));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finish(complete);
    });
    expect(screen.queryByTestId("shared-gallery")).toBeNull();
    expect(screen.getByLabelText("描述要创建的图像")).toBeTruthy();
  });

  it("clears old account image history and result tabs when the active account changes", async () => {
    calls.load.mockResolvedValueOnce({ ...initial, jobs: [complete] });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /^打开图像：A kitten/ }));
    expect(screen.getByAltText("Preview")).toBeTruthy();
    calls.load.mockResolvedValueOnce({
      ...initial,
      account: { id: "account-b", realm: "supabase-google" },
    });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(screen.queryByTestId("shared-gallery")).toBeNull());
    expect(screen.queryByText("A kitten")).toBeNull();
  });

  it("recovers an uncertain historical job explicitly without another paid submission", async () => {
    const uncertain: MossImageJob = {
      ...complete,
      status: "reconciliation_required",
      imageUrls: [],
      billingStatus: "unknown",
    };
    calls.load.mockResolvedValue({ ...initial, jobs: [uncertain] });
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: /^打开图像：A kitten/ }));
    expect(calls.loadJob).not.toHaveBeenCalled();
    const recovered = {
      ...complete,
      billing: { creditsCharged: 3, creditsReserved: 4 },
    };
    const resumed: MossImageJob = { ...uncertain, status: "running" };
    calls.loadJob.mockResolvedValueOnce(resumed);
    calls.wait.mockImplementationOnce(
      async ({ onUpdate }: { onUpdate: (job: MossImageJob) => void }) => {
        onUpdate(recovered);
        return recovered;
      },
    );
    calls.load.mockResolvedValue({ ...initial, jobs: [recovered] });
    fireEvent.click(screen.getByRole("button", { name: "检查任务与费用" }));
    await waitFor(() => expect(screen.getByAltText("Preview")).toBeTruthy());
    expect(calls.loadJob).toHaveBeenCalledWith(uncertain.jobId, expect.any(AbortSignal));
    expect(screen.getByText("扣除 3 体验积分")).toBeTruthy();
    expect(calls.generate).not.toHaveBeenCalled();
    expect(calls.wait).toHaveBeenCalledWith(expect.objectContaining({ job: resumed }));
  });

  it("keeps the recovery action available when the same operation still needs reconciliation", async () => {
    const uncertain: MossImageJob = {
      ...complete,
      status: "reconciliation_required",
      imageUrls: [],
      billingStatus: "unknown",
    };
    calls.load.mockResolvedValue({ ...initial, jobs: [uncertain] });
    calls.loadJob.mockResolvedValue(uncertain);
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: /^打开图像：A kitten/ }));
    fireEvent.click(screen.getByRole("button", { name: "检查任务与费用" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "检查任务与费用" })).toBeTruthy(),
    );
    expect(calls.loadJob).toHaveBeenCalledTimes(1);
    expect(calls.generate).not.toHaveBeenCalled();
    expect(screen.queryByAltText("Preview")).toBeNull();
    expect(screen.queryByText(/扣除/)).toBeNull();
  });

  it("checks a completed image's late bill while retaining its preview", async () => {
    const unsettled: MossImageJob = { ...complete, billingStatus: "unknown" };
    calls.load.mockResolvedValue({ ...initial, jobs: [unsettled] });
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: /^打开图像：A kitten/ }));
    expect(screen.getByAltText("Preview")).toBeTruthy();
    const billed = { ...complete, billing: { creditsCharged: 3, creditsReserved: 4 } };
    calls.loadJob.mockResolvedValueOnce(billed);
    calls.load.mockResolvedValue({ ...initial, jobs: [billed] });
    fireEvent.click(screen.getByRole("button", { name: "检查任务与费用" }));
    await waitFor(() => expect(screen.getByText("扣除 3 体验积分")).toBeTruthy());
    expect(screen.getByAltText("Preview")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "检查任务与费用" })).toBeNull();
    expect(calls.loadJob).toHaveBeenCalledWith(complete.jobId, expect.any(AbortSignal));
    expect(calls.generate).not.toHaveBeenCalled();
  });

  it("aborts manual recovery and ignores its late result when the account changes", async () => {
    const uncertain: MossImageJob = {
      ...complete,
      status: "reconciliation_required",
      imageUrls: [],
      billingStatus: "unknown",
    };
    calls.load.mockResolvedValue({ ...initial, jobs: [uncertain] });
    let finish!: (job: MossImageJob) => void;
    calls.loadJob.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = await ready();
    fireEvent.click(await screen.findByRole("button", { name: /^打开图像：A kitten/ }));
    fireEvent.click(screen.getByRole("button", { name: "检查任务与费用" }));
    const signal = calls.loadJob.mock.calls[0]?.[1] as AbortSignal;
    accountSource.key = "pending:switch";
    accountSource.transitioning = true;
    view.rerender(<MossImagesWorkspace onClose={vi.fn()} />);
    expect(signal.aborted).toBe(true);
    await act(async () => finish(complete));
    expect(screen.queryByAltText("Preview")).toBeNull();
    expect(screen.queryByText("A kitten")).toBeNull();
    expect(calls.wait).not.toHaveBeenCalled();
    expect(calls.generate).not.toHaveBeenCalled();
  });

  it("keeps unavailable models disabled and never pretends billing is ready", async () => {
    calls.load.mockResolvedValueOnce({
      ...initial,
      models: [{ ...initial.models[0], available: false, unavailableReason: "等待官方价格配置" }],
    });
    await ready();
    fireEvent.change(screen.getByLabelText("描述要创建的图像"), { target: { value: "A kitten" } });
    expect((screen.getByRole("button", { name: "生成图像" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("等待官方价格配置")).toBeTruthy();
    expect(calls.generate).not.toHaveBeenCalled();
  });

  it("does not treat a missing catalog as missing installed skills", async () => {
    calls.load.mockResolvedValueOnce({
      ...initial,
      models: [],
      jobs: [complete],
      errorCode: "media_catalog_unavailable",
    });
    await ready();
    expect(screen.getByRole("alert").textContent).toContain("模型目录暂时无法读取");
    expect(screen.queryByText(/尚未安装图像模型/)).toBeNull();
    expect(screen.getByRole("button", { name: /^打开图像：A kitten/ })).toBeTruthy();
  });
  it("clears history immediately when an account mutation starts and rejects late generation", async () => {
    calls.load.mockResolvedValueOnce({ ...initial, jobs: [complete] });
    const view = await ready();
    fireEvent.click(screen.getByRole("button", { name: /^打开图像：A kitten/ }));
    let finish!: (job: MossImageJob) => void;
    calls.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.change(screen.getByLabelText("描述要如何修改当前图像"), {
      target: { value: "Purple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "编辑图像" }));
    const signal = calls.generate.mock.calls[0]?.[1] as AbortSignal;
    const readsBeforeSwitch = calls.load.mock.calls.length;
    accountSource.key = "pending:switch";
    accountSource.transitioning = true;
    view.rerender(<MossImagesWorkspace onClose={vi.fn()} />);
    expect(signal.aborted).toBe(true);
    expect(screen.queryByTestId("shared-gallery")).toBeNull();
    expect(screen.queryByText("A kitten")).toBeNull();
    expect(calls.load).toHaveBeenCalledTimes(readsBeforeSwitch);
    await act(async () => {
      finish({ ...complete, jobId: "moss_late" });
    });
    expect(screen.queryByTestId("shared-gallery")).toBeNull();
    calls.load.mockResolvedValue({
      ...initial,
      account: { id: "account-b", realm: "supabase-google" },
    });
    accountSource.key = "settled:b";
    accountSource.transitioning = false;
    view.rerender(<MossImagesWorkspace onClose={vi.fn()} />);
    await waitFor(() => expect(calls.load).toHaveBeenCalledTimes(readsBeforeSwitch + 1));
    expect(screen.queryByText("A kitten")).toBeNull();
  });

  it("retires an in-flight catalog read at the same account boundary", async () => {
    const view = await ready();
    let resolveOld!: (catalog: MossImagesCatalog) => void;
    calls.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    const signal = calls.load.mock.calls.at(-1)?.[0] as AbortSignal;
    accountSource.key = "pending:logout";
    accountSource.transitioning = true;
    view.rerender(<MossImagesWorkspace onClose={vi.fn()} />);
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveOld({ ...initial, jobs: [complete] });
    });
    expect(screen.queryByText("A kitten")).toBeNull();
  });

  it("binds submission to the displayed account and clears stale history after a server account mismatch", async () => {
    calls.load.mockResolvedValueOnce({ ...initial, jobs: [complete] });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /^打开图像：A kitten/ }));
    calls.load.mockResolvedValue({
      ...initial,
      account: { id: "account-b", realm: "supabase-google" },
    });
    calls.generate.mockRejectedValueOnce(
      new MossImagesError("Account changed", "media_account_changed", 409),
    );
    fireEvent.change(screen.getByLabelText("描述要如何修改当前图像"), {
      target: { value: "Purple background" },
    });
    fireEvent.click(screen.getByRole("button", { name: "编辑图像" }));
    await waitFor(() => expect(calls.load).toHaveBeenCalledTimes(2));
    expect(calls.generate.mock.calls[0]?.[0].expectedAccount).toEqual(initial.account);
    expect(calls.generate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("shared-gallery")).toBeNull();
    expect(screen.queryByText("A kitten")).toBeNull();
    expect(screen.getByLabelText("描述要创建的图像")).toBeTruthy();
  });

  it("previews and edits the persisted asset instead of an expired supplier URL", async () => {
    const asset = {
      assetId: "a".repeat(64),
      index: 0,
      kind: "image" as const,
      contentType: "image/png",
      byteLength: 128,
      downloadPath: `/api/moss/media/assets/${complete.jobId}/0`,
    };
    const cached = { ...complete, assets: [asset], persistenceStatus: "ready" as const };
    calls.load.mockResolvedValue({ ...initial, jobs: [cached] });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /^打开图像：A kitten/ }));
    expect(screen.getByAltText("Preview").getAttribute("src")).toContain(asset.downloadPath);
    expect(screen.getByText("已保存到此设备")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("描述要如何修改当前图像"), {
      target: { value: "Purple background" },
    });
    fireEvent.click(screen.getByRole("button", { name: "编辑图像" }));
    await waitFor(() => expect(calls.generate).toHaveBeenCalledTimes(1));
    expect(calls.assetReference).toHaveBeenCalledWith(asset, expect.any(AbortSignal));
    expect(calls.generate.mock.calls[0]?.[0].referenceImages).toEqual([
      "data:image/png;base64,Y2FjaGVkLWltYWdl",
    ]);
  });
});
