// FILE: components.ts
// Purpose: Four non-invasive Shadow DOM Custom Elements & mount helpers for Moss Page Apps:
//          MossSelectionAsk, MossCompanionDrawer, MossbotMeetingBar, MossMediaTrigger.
// Layer: Shared Page App UI Kit (zero host CSS mutation)

import { BaseHtmlElement, createMossMarkSvg, createShadowHost } from "./dom";
import {
  runMossAsk,
  runMossbotAsk,
  runMossbotJoin,
  runMossbotSummarize,
  runMossMediaGenerate,
  type MossAskOutcome,
  type MossbotJoinOutcome,
  type MossbotSummaryOutcome,
  type MossMediaOutcome,
} from "./mossBridge";

export type MossHighlightColor = "amber" | "blue" | "rose";

export interface MossHighlightDetail {
  readonly text: string;
  readonly color: MossHighlightColor;
}

export interface MossSelectionAskOptions {
  readonly target?: string | HTMLElement | null;
  readonly drawer?: string | MossCompanionDrawer | null;
  readonly appTitle?: string;
  readonly theme?: "light" | "dark" | "auto";
  readonly autoHighlight?: boolean;
  readonly preferSidechat?: boolean;
  readonly onHighlight?: (detail: MossHighlightDetail) => void;
  readonly onAsk?: (detail: {
    readonly prompt: string;
    readonly selectionText: string;
    readonly outcome: MossAskOutcome;
  }) => void;
}

export interface MossCompanionDrawerOptions {
  readonly container?: HTMLElement | null;
  readonly title?: string;
  readonly placeholder?: string;
  readonly appTitle?: string;
  readonly theme?: "light" | "dark" | "auto";
  readonly open?: boolean;
  readonly getContext?: () => string;
}

export interface MossbotMeetingBarOptions {
  readonly container?: HTMLElement | null;
  readonly meetingId?: string;
  readonly meetingTitle?: string;
  readonly theme?: "light" | "dark" | "auto";
  readonly getTranscript?: () => string;
  readonly onJoined?: (outcome: MossbotJoinOutcome) => void;
  readonly onSummary?: (outcome: MossbotSummaryOutcome) => void;
}

export interface MossMediaTriggerOptions {
  readonly container?: HTMLElement | null;
  readonly kind?: "image" | "video";
  readonly prompt?: string;
  readonly theme?: "light" | "dark" | "auto";
  readonly onResult?: (outcome: MossMediaOutcome) => void;
}

const HIGHLIGHT_COLORS: ReadonlyArray<{
  readonly id: MossHighlightColor;
  readonly label: string;
  readonly dot: string;
  readonly bg: string;
}> = [
  { id: "amber", label: "琥珀黄", dot: "#f59e0b", bg: "rgba(245, 158, 11, 0.24)" },
  { id: "blue", label: "晴空蓝", dot: "#38bdf8", bg: "rgba(56, 189, 248, 0.22)" },
  { id: "rose", label: "浅绯粉", dot: "#f43f5e", bg: "rgba(244, 63, 94, 0.20)" },
];

function applySafeInlineHighlight(
  range: Range,
  color: MossHighlightColor,
  root: HTMLElement,
): boolean {
  const spec = HIGHLIGHT_COLORS.find((item) => item.id === color) ?? HIGHLIGHT_COLORS[0]!;
  try {
    const walker = document.createTreeWalker(
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : (range.commonAncestorContainer.parentElement ?? root),
      NodeFilter.SHOW_TEXT,
    );
    const segments: Array<{ node: Text; start: number; end: number }> = [];
    let current = walker.nextNode();
    while (current) {
      const textNode = current as Text;
      if (
        textNode.nodeValue &&
        textNode.nodeValue.trim().length > 0 &&
        root.contains(textNode) &&
        range.intersectsNode(textNode)
      ) {
        const start = textNode === range.startContainer ? range.startOffset : 0;
        const end = textNode === range.endContainer ? range.endOffset : textNode.nodeValue.length;
        if (end > start) {
          segments.push({ node: textNode, start, end });
        }
      }
      current = walker.nextNode();
    }
    if (segments.length === 0) return false;
    for (const seg of segments) {
      let targetNode = seg.node;
      if (seg.end < targetNode.length) {
        targetNode.splitText(seg.end);
      }
      if (seg.start > 0) {
        targetNode = targetNode.splitText(seg.start);
      }
      const mark = document.createElement("mark");
      mark.setAttribute("data-moss-ui-highlight", color);
      mark.style.backgroundColor = spec.bg;
      mark.style.color = "inherit";
      mark.style.borderRadius = "3px";
      mark.style.padding = "0 1px";
      targetNode.parentNode?.insertBefore(mark, targetNode);
      mark.appendChild(targetNode);
    }
    return true;
  } catch {
    return false;
  }
}

const SELECTION_ASK_CSS = `
:host {
  position: fixed;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  z-index: 2147483000;
  pointer-events: none;
}

.popover {
  position: fixed;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 268px;
  max-width: min(380px, calc(100vw - 16px));
  padding: 6px 8px;
  border-radius: var(--moss-radius-popover);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-popover);
  backdrop-filter: blur(12px);
  box-shadow: var(--moss-shadow-popover);
}

.popover.hidden {
  display: none;
}

.row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.swatch-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border-radius: var(--moss-radius-control);
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  color: var(--moss-ink);
  transition: background-color 120ms ease;
}

.swatch-btn:hover {
  background: var(--moss-hover);
}

.swatch-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--moss-radius-pill);
  flex-shrink: 0;
}

.divider {
  width: 1px;
  height: 16px;
  background: var(--moss-border-strong);
  margin: 0 2px;
}

.ask-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px solid var(--moss-border);
}

.ask-row.hidden {
  display: none;
}

.ask-row .moss-input {
  flex: 1;
}

.inline-answer {
  font-size: 13px;
  line-height: 19px;
  color: var(--moss-ink);
  background: var(--moss-surface);
  border: 1px solid var(--moss-border);
  border-radius: var(--moss-radius-control);
  padding: 8px 10px;
  max-height: 180px;
  overflow-y: auto;
  white-space: pre-wrap;
}

.inline-answer.hidden {
  display: none;
}
`;

export class MossSelectionAsk extends BaseHtmlElement {
  static get observedAttributes(): string[] {
    return ["target", "drawer", "app-title", "theme", "auto-highlight", "prefer-sidechat"];
  }

  private targetEl: HTMLElement | null = null;
  private drawerEl: MossCompanionDrawer | null = null;
  private autoHighlight = true;
  private preferSidechat = false;
  private onHighlightCb: ((detail: MossHighlightDetail) => void) | null = null;
  private onAskCb:
    | ((detail: {
        readonly prompt: string;
        readonly selectionText: string;
        readonly outcome: MossAskOutcome;
      }) => void)
    | null = null;

  private popoverEl!: HTMLDivElement;
  private askRowEl!: HTMLDivElement;
  private askInputEl!: HTMLInputElement;
  private answerEl!: HTMLDivElement;
  private savedRange: Range | null = null;
  private savedText = "";
  private listenersBound = false;

  private readonly onSelectionTrigger = () => {
    this.syncFromWindowSelection();
  };

  private readonly onDocMouseDown = (event: MouseEvent) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.includes(this) || path.includes(this.popoverEl)) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      this.hide();
    }
  };

  constructor() {
    super();
    const shadow = createShadowHost(this, SELECTION_ASK_CSS);

    this.popoverEl = document.createElement("div");
    this.popoverEl.className = "popover hidden";
    this.popoverEl.setAttribute("role", "dialog");
    this.popoverEl.setAttribute("aria-label", "Moss 划线操作条");

    const row = document.createElement("div");
    row.className = "row";

    for (const color of HIGHLIGHT_COLORS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "swatch-btn";
      btn.setAttribute("data-moss-highlight-btn", color.id);
      const dot = document.createElement("span");
      dot.className = "swatch-dot";
      dot.style.background = color.dot;
      btn.appendChild(dot);
      btn.appendChild(document.createTextNode(color.label));
      btn.addEventListener("mousedown", (ev) => ev.preventDefault());
      btn.addEventListener("click", () => this.applyHighlight(color.id));
      row.appendChild(btn);
    }

    const divider = document.createElement("span");
    divider.className = "divider";
    row.appendChild(divider);

    const askToggleBtn = document.createElement("button");
    askToggleBtn.type = "button";
    askToggleBtn.className = "moss-btn moss-btn-primary";
    askToggleBtn.setAttribute("data-moss-action", "open-ask");
    askToggleBtn.appendChild(createMossMarkSvg(13));
    askToggleBtn.appendChild(document.createTextNode("划线提问"));
    askToggleBtn.addEventListener("mousedown", (ev) => ev.preventDefault());
    askToggleBtn.addEventListener("click", () => {
      if (this.askRowEl.classList.contains("hidden")) {
        this.askRowEl.classList.remove("hidden");
        this.askInputEl.focus();
      } else {
        void this.submitAsk();
      }
    });
    row.appendChild(askToggleBtn);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "moss-btn moss-btn-ghost";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("mousedown", (ev) => ev.preventDefault());
    closeBtn.addEventListener("click", () => this.hide());
    row.appendChild(closeBtn);

    this.popoverEl.appendChild(row);

    this.askRowEl = document.createElement("div");
    this.askRowEl.className = "ask-row hidden";

    this.askInputEl = document.createElement("input");
    this.askInputEl.type = "text";
    this.askInputEl.className = "moss-input";
    this.askInputEl.placeholder = "对选中内容向 Moss 提问…";
    this.askInputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void this.submitAsk();
      } else if (ev.key === "Escape") {
        this.hide();
      }
    });

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "moss-btn moss-btn-primary";
    submitBtn.setAttribute("data-moss-action", "submit-ask");
    submitBtn.textContent = "问 Moss";
    submitBtn.addEventListener("mousedown", (ev) => ev.preventDefault());
    submitBtn.addEventListener("click", () => void this.submitAsk());

    this.askRowEl.appendChild(this.askInputEl);
    this.askRowEl.appendChild(submitBtn);
    this.popoverEl.appendChild(this.askRowEl);

    this.answerEl = document.createElement("div");
    this.answerEl.className = "inline-answer hidden";
    this.popoverEl.appendChild(this.answerEl);

    shadow.appendChild(this.popoverEl);
  }

  connectedCallback(): void {
    this.syncAttributes();
    if (!this.listenersBound) {
      this.listenersBound = true;
      document.addEventListener("mouseup", this.onSelectionTrigger);
      document.addEventListener("keyup", this.onSelectionTrigger);
      document.addEventListener("selectionchange", this.onSelectionTrigger);
      document.addEventListener("mousedown", this.onDocMouseDown);
    }
  }

  disconnectedCallback(): void {
    if (this.listenersBound) {
      this.listenersBound = false;
      document.removeEventListener("mouseup", this.onSelectionTrigger);
      document.removeEventListener("keyup", this.onSelectionTrigger);
      document.removeEventListener("selectionchange", this.onSelectionTrigger);
      document.removeEventListener("mousedown", this.onDocMouseDown);
    }
  }

  attributeChangedCallback(): void {
    this.syncAttributes();
  }

  configure(options: MossSelectionAskOptions): void {
    if (options.target !== undefined) {
      this.targetEl =
        typeof options.target === "string"
          ? document.querySelector<HTMLElement>(options.target)
          : options.target;
    }
    if (options.drawer !== undefined) {
      this.drawerEl =
        typeof options.drawer === "string"
          ? document.querySelector<MossCompanionDrawer>(options.drawer)
          : options.drawer;
    }
    if (options.appTitle !== undefined) {
      this.setAttribute("app-title", options.appTitle);
    }
    if (options.theme && options.theme !== "auto") {
      this.setAttribute("theme", options.theme);
    }
    if (options.autoHighlight !== undefined) {
      this.autoHighlight = options.autoHighlight;
    }
    if (options.preferSidechat !== undefined) {
      this.preferSidechat = options.preferSidechat;
    }
    if (options.onHighlight) this.onHighlightCb = options.onHighlight;
    if (options.onAsk) this.onAskCb = options.onAsk;
  }

  showForRange(range: Range): void {
    const text = range.toString().trim();
    if (!text) return;
    this.savedRange = range.cloneRange();
    this.savedText = text;
    const rect = range.getBoundingClientRect();
    this.positionNearRect(rect);
  }

  hide(): void {
    this.popoverEl.classList.add("hidden");
    this.askRowEl.classList.add("hidden");
    this.answerEl.classList.add("hidden");
    this.answerEl.textContent = "";
    this.askInputEl.value = "";
    this.savedRange = null;
    this.savedText = "";
  }

  private syncAttributes(): void {
    const targetAttr = this.getAttribute("target");
    if (targetAttr) {
      this.targetEl = document.querySelector<HTMLElement>(targetAttr);
    }
    const drawerAttr = this.getAttribute("drawer");
    if (drawerAttr) {
      this.drawerEl = document.querySelector<MossCompanionDrawer>(drawerAttr);
    }
    const autoAttr = this.getAttribute("auto-highlight");
    if (autoAttr !== null) {
      this.autoHighlight = autoAttr !== "false";
    }
    const sidechatAttr = this.getAttribute("prefer-sidechat");
    if (sidechatAttr !== null) {
      this.preferSidechat = sidechatAttr === "true" || sidechatAttr === "";
    }
  }

  private resolveTarget(): HTMLElement {
    if (this.targetEl) return this.targetEl;
    const attr = this.getAttribute("target");
    if (attr) {
      this.targetEl = document.querySelector<HTMLElement>(attr);
      if (this.targetEl) return this.targetEl;
    }
    return document.body;
  }

  private resolveDrawer(): MossCompanionDrawer | null {
    if (this.drawerEl) return this.drawerEl;
    const attr = this.getAttribute("drawer");
    if (attr) {
      this.drawerEl = document.querySelector<MossCompanionDrawer>(attr);
    }
    return this.drawerEl;
  }

  private syncFromWindowSelection(): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const text = range.toString().trim();
    if (!text) return;
    const root = this.resolveTarget();
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    this.showForRange(range);
  }

  private positionNearRect(rect: DOMRect): void {
    this.popoverEl.classList.remove("hidden");
    const box = this.popoverEl.getBoundingClientRect();
    const width = box.width || 300;
    const height = box.height || 44;
    const rawLeft = rect.left + rect.width / 2 - width / 2;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rawLeft));
    const aboveTop = rect.top - height - 8;
    const top =
      aboveTop >= 8 ? aboveTop : Math.min(window.innerHeight - height - 8, rect.bottom + 8);
    this.popoverEl.style.left = `${Math.round(left)}px`;
    this.popoverEl.style.top = `${Math.round(Math.max(8, top))}px`;
  }

  private applyHighlight(color: MossHighlightColor): void {
    if (!this.savedText) return;
    if (this.autoHighlight && this.savedRange) {
      applySafeInlineHighlight(this.savedRange, color, this.resolveTarget());
    }
    const detail: MossHighlightDetail = { text: this.savedText, color };
    this.onHighlightCb?.(detail);
    this.dispatchEvent(
      new CustomEvent<MossHighlightDetail>("moss-highlight", {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
    window.getSelection()?.removeAllRanges();
    this.hide();
  }

  private async submitAsk(): Promise<void> {
    const selectionText = this.savedText;
    if (!selectionText) return;
    const customPrompt = this.askInputEl.value.trim();
    const prompt = customPrompt || "请结合上下文解读这段内容。";
    const appTitle = this.getAttribute("app-title") ?? document.title;
    const context = this.resolveTarget().textContent?.slice(0, 1200) ?? "";
    const drawer = this.resolveDrawer();

    if (drawer && typeof drawer.ask === "function") {
      drawer.open();
      this.hide();
      const outcome = await drawer.ask({ prompt, selectionText, context, appTitle });
      this.onAskCb?.({ prompt, selectionText, outcome });
      return;
    }

    this.answerEl.classList.remove("hidden");
    this.answerEl.textContent = "Moss 思考中…";
    this.dispatchEvent(
      new CustomEvent("moss-ask-start", {
        detail: { prompt, selectionText },
        bubbles: true,
        composed: true,
      }),
    );

    const outcome = await runMossAsk({
      prompt,
      selectionText,
      context,
      appTitle,
      preferSidechat: this.preferSidechat,
      onText: (_delta, full) => {
        this.answerEl.textContent = full;
        this.dispatchEvent(
          new CustomEvent("moss-ask-delta", {
            detail: { text: full },
            bubbles: true,
            composed: true,
          }),
        );
      },
    });
    this.answerEl.textContent = outcome.text;
    this.onAskCb?.({ prompt, selectionText, outcome });
    this.dispatchEvent(
      new CustomEvent("moss-ask-done", {
        detail: { prompt, selectionText, outcome },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

const COMPANION_DRAWER_CSS = `
:host {
  display: block;
  height: 100%;
}

.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 340px;
  max-width: 100%;
  background: var(--moss-surface);
  border-left: 1px solid var(--moss-border);
  color: var(--moss-ink);
}

.shell.collapsed {
  width: auto;
  background: transparent;
  border-left: 0;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 42px;
  padding: 0 12px;
  border-bottom: 1px solid var(--moss-border);
  background: var(--moss-paper);
  flex-shrink: 0;
}

.shell.collapsed .header {
  border-bottom: 0;
  background: transparent;
  padding: 6px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
}

.brand-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.shell.collapsed .body,
.shell.collapsed .footer {
  display: none;
}

.empty {
  padding: 14px 12px;
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border);
  background: var(--moss-card);
  color: var(--moss-ink-2);
  font-size: 13px;
  line-height: 19px;
}

.msg {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border);
  background: var(--moss-card);
}

.msg.user {
  background: var(--moss-paper);
}

.msg-role {
  font-size: 12px;
  font-weight: 500;
  color: var(--moss-ink-2);
}

.msg-quote {
  padding: 6px 8px;
  border-left: 2px solid var(--moss-accent);
  background: var(--moss-hover);
  border-radius: 4px;
  font-size: 12px;
  line-height: 17px;
  color: var(--moss-ink-2);
}

.msg-text {
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
  word-break: break-word;
}

.footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-top: 1px solid var(--moss-border);
  background: var(--moss-paper);
  flex-shrink: 0;
}

.footer .moss-input {
  flex: 1;
}
`;

export class MossCompanionDrawer extends BaseHtmlElement {
  static get observedAttributes(): string[] {
    return ["title", "placeholder", "app-title", "theme", "open"];
  }

  private shellEl!: HTMLDivElement;
  private titleEl!: HTMLSpanElement;
  private toggleBtnEl!: HTMLButtonElement;
  private clearBtnEl!: HTMLButtonElement;
  private bodyEl!: HTMLDivElement;
  private inputEl!: HTMLInputElement;
  private sendBtnEl!: HTMLButtonElement;
  private isOpen = true;
  private busy = false;
  private contextGetter: (() => string) | null = null;
  private messages: Array<{
    readonly role: "user" | "assistant";
    text: string;
    readonly quote?: string;
  }> = [];

  constructor() {
    super();
    const shadow = createShadowHost(this, COMPANION_DRAWER_CSS);

    this.shellEl = document.createElement("div");
    this.shellEl.className = "shell";

    const header = document.createElement("div");
    header.className = "header";

    const brand = document.createElement("div");
    brand.className = "brand";
    brand.appendChild(createMossMarkSvg(14));
    this.titleEl = document.createElement("span");
    this.titleEl.className = "brand-title";
    this.titleEl.textContent = "Moss 伴读";
    brand.appendChild(this.titleEl);

    const actions = document.createElement("div");
    actions.className = "header-actions";

    this.clearBtnEl = document.createElement("button");
    this.clearBtnEl.type = "button";
    this.clearBtnEl.className = "moss-btn moss-btn-ghost";
    this.clearBtnEl.textContent = "清空";
    this.clearBtnEl.addEventListener("click", () => this.clear());

    this.toggleBtnEl = document.createElement("button");
    this.toggleBtnEl.type = "button";
    this.toggleBtnEl.className = "moss-btn";
    this.toggleBtnEl.setAttribute("data-moss-role", "toggle");
    this.toggleBtnEl.textContent = "收起";
    this.toggleBtnEl.addEventListener("click", () => this.toggle());

    actions.appendChild(this.clearBtnEl);
    actions.appendChild(this.toggleBtnEl);
    header.appendChild(brand);
    header.appendChild(actions);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "body";
    this.bodyEl.setAttribute("data-moss-role", "messages");

    const footer = document.createElement("div");
    footer.className = "footer";

    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.className = "moss-input";
    this.inputEl.placeholder = "向 Moss 提问…";
    this.inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void this.handleSubmitInput();
      }
    });

    this.sendBtnEl = document.createElement("button");
    this.sendBtnEl.type = "button";
    this.sendBtnEl.className = "moss-btn moss-btn-primary";
    this.sendBtnEl.setAttribute("data-moss-role", "send");
    this.sendBtnEl.textContent = "发送";
    this.sendBtnEl.addEventListener("click", () => void this.handleSubmitInput());

    footer.appendChild(this.inputEl);
    footer.appendChild(this.sendBtnEl);

    this.shellEl.appendChild(header);
    this.shellEl.appendChild(this.bodyEl);
    this.shellEl.appendChild(footer);
    shadow.appendChild(this.shellEl);

    this.renderMessages();
  }

  connectedCallback(): void {
    this.syncAttributes();
  }

  attributeChangedCallback(): void {
    this.syncAttributes();
  }

  configure(options: MossCompanionDrawerOptions): void {
    if (options.title) this.setAttribute("title", options.title);
    if (options.placeholder) this.setAttribute("placeholder", options.placeholder);
    if (options.appTitle) this.setAttribute("app-title", options.appTitle);
    if (options.theme && options.theme !== "auto") this.setAttribute("theme", options.theme);
    if (options.open !== undefined) {
      if (options.open) this.open();
      else this.close();
    }
    if (options.getContext) this.contextGetter = options.getContext;
  }

  open(): void {
    this.isOpen = true;
    this.syncOpenUi();
  }

  close(): void {
    this.isOpen = false;
    this.syncOpenUi();
  }

  toggle(): void {
    this.isOpen = !this.isOpen;
    this.syncOpenUi();
  }

  clear(): void {
    this.messages = [];
    this.renderMessages();
  }

  appendMessage(msg: {
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly quote?: string;
  }): void {
    this.messages.push({ ...msg });
    this.renderMessages();
  }

  async ask(params: {
    readonly prompt: string;
    readonly selectionText?: string;
    readonly context?: string;
    readonly appTitle?: string;
  }): Promise<MossAskOutcome> {
    if (this.busy) {
      return { via: "fallback", text: "上一条提问还在处理中。" };
    }
    this.open();
    const prompt = params.prompt.trim() || "请解读这段内容";
    this.messages.push({
      role: "user",
      text: prompt,
      ...(params.selectionText ? { quote: params.selectionText } : {}),
    });
    const assistantEntry = { role: "assistant" as const, text: "正在思考…" };
    this.messages.push(assistantEntry);
    this.busy = true;
    this.sendBtnEl.disabled = true;
    this.renderMessages();

    try {
      const outcome = await runMossAsk({
        prompt,
        ...(params.selectionText !== undefined ? { selectionText: params.selectionText } : {}),
        context: params.context ?? this.contextGetter?.() ?? "",
        appTitle: params.appTitle ?? this.getAttribute("app-title") ?? document.title,
        onText: (_delta, full) => {
          assistantEntry.text = full;
          this.renderMessages();
        },
      });
      assistantEntry.text = outcome.text;
      this.renderMessages();
      this.dispatchEvent(
        new CustomEvent("moss-drawer-reply", {
          detail: { prompt, outcome },
          bubbles: true,
          composed: true,
        }),
      );
      return outcome;
    } finally {
      this.busy = false;
      this.sendBtnEl.disabled = false;
    }
  }

  private async handleSubmitInput(): Promise<void> {
    const prompt = this.inputEl.value.trim();
    if (!prompt || this.busy) return;
    this.inputEl.value = "";
    await this.ask({ prompt });
  }

  private syncAttributes(): void {
    const title = this.getAttribute("title");
    if (title) this.titleEl.textContent = title;
    const placeholder = this.getAttribute("placeholder");
    if (placeholder) this.inputEl.placeholder = placeholder;
    const openAttr = this.getAttribute("open");
    if (openAttr !== null) {
      this.isOpen = openAttr !== "false";
    }
    this.syncOpenUi();
  }

  private syncOpenUi(): void {
    this.shellEl.classList.toggle("collapsed", !this.isOpen);
    this.toggleBtnEl.textContent = this.isOpen ? "收起" : "打开伴读";
    this.clearBtnEl.style.display = this.isOpen ? "" : "none";
  }

  private renderMessages(): void {
    this.bodyEl.textContent = "";
    if (this.messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "划选正文后点击「划线提问」，或直接在下方输入问题。";
      this.bodyEl.appendChild(empty);
      return;
    }
    for (const msg of this.messages) {
      const card = document.createElement("div");
      card.className = `msg ${msg.role}`;
      const role = document.createElement("div");
      role.className = "msg-role";
      role.textContent = msg.role === "user" ? "我" : "Moss";
      card.appendChild(role);
      if (msg.quote) {
        const quote = document.createElement("div");
        quote.className = "msg-quote";
        quote.textContent = msg.quote.slice(0, 120);
        card.appendChild(quote);
      }
      const text = document.createElement("div");
      text.className = "msg-text";
      text.textContent = msg.text;
      card.appendChild(text);
      this.bodyEl.appendChild(card);
    }
    this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  }
}

const MEETING_BAR_CSS = `
.bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-card);
  color: var(--moss-ink);
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--moss-radius-pill);
  background: var(--moss-hover);
  color: var(--moss-ink-2);
  font-size: 12px;
  line-height: 16px;
}

.status-pill.joined {
  background: var(--moss-success-soft);
  color: var(--moss-success);
}

.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.ask-line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ask-line .moss-input {
  flex: 1;
}

.sheet {
  padding: 10px 12px;
  border-radius: var(--moss-radius-control);
  border: 1px solid var(--moss-border);
  background: var(--moss-surface);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
}

.sheet.hidden {
  display: none;
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--moss-ink-2);
}
`;

export class MossbotMeetingBar extends BaseHtmlElement {
  static get observedAttributes(): string[] {
    return ["meeting-id", "meeting-title", "theme"];
  }

  private titleEl!: HTMLSpanElement;
  private statusEl!: HTMLSpanElement;
  private joinBtnEl!: HTMLButtonElement;
  private summaryBtnEl!: HTMLButtonElement;
  private askInputEl!: HTMLInputElement;
  private askBtnEl!: HTMLButtonElement;
  private sheetEl!: HTMLDivElement;
  private sheetTitleEl!: HTMLSpanElement;
  private sheetBodyEl!: HTMLDivElement;

  private joined = false;
  private busy = false;
  private getTranscriptFn: (() => string) | null = null;
  private onJoinedCb: ((outcome: MossbotJoinOutcome) => void) | null = null;
  private onSummaryCb: ((outcome: MossbotSummaryOutcome) => void) | null = null;

  constructor() {
    super();
    const shadow = createShadowHost(this, MEETING_BAR_CSS);

    const bar = document.createElement("div");
    bar.className = "bar";

    const top = document.createElement("div");
    top.className = "top";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.appendChild(createMossMarkSvg(15));
    this.titleEl = document.createElement("span");
    this.titleEl.style.fontWeight = "500";
    this.titleEl.textContent = "Moss 会议助手";
    meta.appendChild(this.titleEl);

    this.statusEl = document.createElement("span");
    this.statusEl.className = "status-pill";
    this.statusEl.setAttribute("data-moss-role", "status");
    this.statusEl.textContent = "未入场";
    meta.appendChild(this.statusEl);

    const actions = document.createElement("div");
    actions.className = "actions";

    this.joinBtnEl = document.createElement("button");
    this.joinBtnEl.type = "button";
    this.joinBtnEl.className = "moss-btn moss-btn-primary";
    this.joinBtnEl.setAttribute("data-moss-role", "join");
    this.joinBtnEl.textContent = "拉 Moss 加入会议";
    this.joinBtnEl.addEventListener("click", () => void this.join());

    this.summaryBtnEl = document.createElement("button");
    this.summaryBtnEl.type = "button";
    this.summaryBtnEl.className = "moss-btn";
    this.summaryBtnEl.setAttribute("data-moss-role", "summarize");
    this.summaryBtnEl.textContent = "生成会议纪要";
    this.summaryBtnEl.addEventListener("click", () => void this.summarize());

    actions.appendChild(this.joinBtnEl);
    actions.appendChild(this.summaryBtnEl);
    top.appendChild(meta);
    top.appendChild(actions);

    const askLine = document.createElement("div");
    askLine.className = "ask-line";

    this.askInputEl = document.createElement("input");
    this.askInputEl.type = "text";
    this.askInputEl.className = "moss-input";
    this.askInputEl.placeholder = "向 Mossbot 提问当前会议进展或行动项…";
    this.askInputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void this.askQuestion();
      }
    });

    this.askBtnEl = document.createElement("button");
    this.askBtnEl.type = "button";
    this.askBtnEl.className = "moss-btn";
    this.askBtnEl.setAttribute("data-moss-role", "ask");
    this.askBtnEl.textContent = "问 Mossbot";
    this.askBtnEl.addEventListener("click", () => void this.askQuestion());

    askLine.appendChild(this.askInputEl);
    askLine.appendChild(this.askBtnEl);

    this.sheetEl = document.createElement("div");
    this.sheetEl.className = "sheet hidden";
    this.sheetEl.setAttribute("data-moss-role", "sheet");

    const sheetHead = document.createElement("div");
    sheetHead.className = "sheet-head";
    this.sheetTitleEl = document.createElement("span");
    this.sheetTitleEl.textContent = "会议纪要";
    const sheetClose = document.createElement("button");
    sheetClose.type = "button";
    sheetClose.className = "moss-btn moss-btn-ghost";
    sheetClose.textContent = "收起";
    sheetClose.addEventListener("click", () => this.sheetEl.classList.add("hidden"));
    sheetHead.appendChild(this.sheetTitleEl);
    sheetHead.appendChild(sheetClose);

    this.sheetBodyEl = document.createElement("div");
    this.sheetEl.appendChild(sheetHead);
    this.sheetEl.appendChild(this.sheetBodyEl);

    bar.appendChild(top);
    bar.appendChild(askLine);
    bar.appendChild(this.sheetEl);
    shadow.appendChild(bar);
  }

  connectedCallback(): void {
    this.syncAttributes();
  }

  attributeChangedCallback(): void {
    this.syncAttributes();
  }

  configure(options: MossbotMeetingBarOptions): void {
    if (options.meetingId) this.setAttribute("meeting-id", options.meetingId);
    if (options.meetingTitle) this.setAttribute("meeting-title", options.meetingTitle);
    if (options.theme && options.theme !== "auto") this.setAttribute("theme", options.theme);
    if (options.getTranscript) this.getTranscriptFn = options.getTranscript;
    if (options.onJoined) this.onJoinedCb = options.onJoined;
    if (options.onSummary) this.onSummaryCb = options.onSummary;
  }

  private resolveMeetingId(): string {
    const raw = this.getAttribute("meeting-id")?.trim();
    return raw && raw.length > 0 ? raw : "moss-default-meeting";
  }

  async join(): Promise<MossbotJoinOutcome> {
    const title = this.getAttribute("meeting-title") ?? "会议室";
    const meetingId = this.resolveMeetingId();
    this.setBusy(true);
    try {
      const outcome = await runMossbotJoin({
        meetingId,
        title,
      });
      this.joined = outcome.joined;
      this.statusEl.textContent = outcome.statusText;
      this.statusEl.classList.toggle("joined", this.joined);
      this.joinBtnEl.textContent = this.joined ? "Moss 已在场" : "拉 Moss 加入会议";
      this.joinBtnEl.classList.toggle("moss-btn-primary", !this.joined);
      this.onJoinedCb?.(outcome);
      this.dispatchEvent(
        new CustomEvent("moss-meeting-joined", {
          detail: outcome,
          bubbles: true,
          composed: true,
        }),
      );
      return outcome;
    } finally {
      this.setBusy(false);
    }
  }

  async summarize(): Promise<MossbotSummaryOutcome> {
    if (this.busy) return { via: "fallback", summary: "" };
    const title = this.getAttribute("meeting-title") ?? "会议室";
    const meetingId = this.resolveMeetingId();
    const transcript = this.resolveTranscript();
    this.setBusy(true);
    this.sheetEl.classList.remove("hidden");
    this.sheetTitleEl.textContent = "正在整理会议纪要…";
    this.sheetBodyEl.textContent = "";
    try {
      const outcome = await runMossbotSummarize({
        meetingId,
        title,
        transcript,
      });
      this.sheetTitleEl.textContent = "会议纪要";
      this.sheetBodyEl.textContent = outcome.summary;
      this.onSummaryCb?.(outcome);
      this.dispatchEvent(
        new CustomEvent("moss-meeting-summary", {
          detail: outcome,
          bubbles: true,
          composed: true,
        }),
      );
      return outcome;
    } finally {
      this.setBusy(false);
    }
  }

  async askQuestion(overridePrompt?: string): Promise<MossbotSummaryOutcome> {
    const prompt = (overridePrompt ?? this.askInputEl.value).trim();
    if (!prompt || this.busy) return { via: "fallback", summary: "" };
    if (!overridePrompt) this.askInputEl.value = "";
    const title = this.getAttribute("meeting-title") ?? "会议室";
    const meetingId = this.resolveMeetingId();
    const transcript = this.resolveTranscript();
    this.setBusy(true);
    this.sheetEl.classList.remove("hidden");
    this.sheetTitleEl.textContent = "Mossbot 回复";
    this.sheetBodyEl.textContent = "正在检索会议记录…";
    try {
      const outcome = await runMossbotAsk({
        meetingId,
        title,
        prompt,
        transcript,
      });
      this.sheetBodyEl.textContent = outcome.summary;
      this.dispatchEvent(
        new CustomEvent("moss-meeting-answer", {
          detail: { prompt, outcome },
          bubbles: true,
          composed: true,
        }),
      );
      return outcome;
    } finally {
      this.setBusy(false);
    }
  }

  private resolveTranscript(): string {
    if (this.getTranscriptFn) return this.getTranscriptFn();
    return document.body?.innerText?.slice(0, 2400) ?? "";
  }

  private setBusy(next: boolean): void {
    this.busy = next;
    this.joinBtnEl.disabled = next;
    this.summaryBtnEl.disabled = next;
    this.askBtnEl.disabled = next;
  }

  private syncAttributes(): void {
    const title = this.getAttribute("meeting-title");
    if (title) this.titleEl.textContent = title;
  }
}

const MEDIA_TRIGGER_CSS = `
.wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-card);
  color: var(--moss-ink);
}

.row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.row .moss-input {
  flex: 1;
  min-width: 160px;
}

.preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--moss-radius-control);
  border: 1px solid var(--moss-border);
  background: var(--moss-surface);
  font-size: 13px;
  line-height: 19px;
}

.preview.hidden {
  display: none;
}

.preview img,
.preview video {
  max-width: 100%;
  max-height: 220px;
  border-radius: var(--moss-radius-control);
  object-fit: contain;
}
`;

export class MossMediaTrigger extends BaseHtmlElement {
  static get observedAttributes(): string[] {
    return ["kind", "prompt", "theme"];
  }

  private kind: "image" | "video" = "image";
  private busy = false;
  private onResultCb: ((outcome: MossMediaOutcome) => void) | null = null;
  private kindBtnEl!: HTMLButtonElement;
  private inputEl!: HTMLInputElement;
  private runBtnEl!: HTMLButtonElement;
  private previewEl!: HTMLDivElement;

  constructor() {
    super();
    const shadow = createShadowHost(this, MEDIA_TRIGGER_CSS);

    const wrap = document.createElement("div");
    wrap.className = "wrap";

    const row = document.createElement("div");
    row.className = "row";

    this.kindBtnEl = document.createElement("button");
    this.kindBtnEl.type = "button";
    this.kindBtnEl.className = "moss-btn";
    this.kindBtnEl.setAttribute("data-moss-role", "toggle-kind");
    this.kindBtnEl.textContent = "配图";
    this.kindBtnEl.addEventListener("click", () => {
      this.kind = this.kind === "image" ? "video" : "image";
      this.syncLabels();
    });

    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.className = "moss-input";
    this.inputEl.placeholder = "描述要生成的图片或短视频…";
    this.inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void this.trigger();
      }
    });

    this.runBtnEl = document.createElement("button");
    this.runBtnEl.type = "button";
    this.runBtnEl.className = "moss-btn moss-btn-primary";
    this.runBtnEl.setAttribute("data-moss-role", "generate");
    this.runBtnEl.textContent = "生成配图";
    this.runBtnEl.addEventListener("click", () => void this.trigger());

    row.appendChild(this.kindBtnEl);
    row.appendChild(this.inputEl);
    row.appendChild(this.runBtnEl);

    this.previewEl = document.createElement("div");
    this.previewEl.className = "preview hidden";
    this.previewEl.setAttribute("data-moss-role", "preview");

    wrap.appendChild(row);
    wrap.appendChild(this.previewEl);
    shadow.appendChild(wrap);
  }

  connectedCallback(): void {
    this.syncAttributes();
  }

  attributeChangedCallback(): void {
    this.syncAttributes();
  }

  configure(options: MossMediaTriggerOptions): void {
    if (options.kind) {
      this.kind = options.kind;
      this.setAttribute("kind", options.kind);
    }
    if (options.prompt !== undefined) {
      this.inputEl.value = options.prompt;
    }
    if (options.theme && options.theme !== "auto") {
      this.setAttribute("theme", options.theme);
    }
    if (options.onResult) this.onResultCb = options.onResult;
    this.syncLabels();
  }

  async trigger(overridePrompt?: string): Promise<MossMediaOutcome> {
    if (this.busy) {
      return { via: "fallback", kind: this.kind, status: "fallback", text: "生成任务进行中。" };
    }
    const prompt = (overridePrompt ?? this.inputEl.value).trim() || "Moss 极简暖白插画卡片";
    this.busy = true;
    this.runBtnEl.disabled = true;
    this.previewEl.classList.remove("hidden");
    this.previewEl.textContent = this.kind === "video" ? "正在生成短视频…" : "正在生成配图…";
    try {
      const outcome = await runMossMediaGenerate({ kind: this.kind, prompt });
      this.previewEl.textContent = "";
      if (outcome.url) {
        if (outcome.kind === "video") {
          const video = document.createElement("video");
          video.src = outcome.url;
          video.controls = true;
          this.previewEl.appendChild(video);
        } else {
          const img = document.createElement("img");
          img.src = outcome.url;
          img.alt = prompt;
          this.previewEl.appendChild(img);
        }
      }
      if (outcome.text) {
        const note = document.createElement("div");
        note.textContent = outcome.text;
        this.previewEl.appendChild(note);
      }
      this.onResultCb?.(outcome);
      this.dispatchEvent(
        new CustomEvent("moss-media-result", {
          detail: outcome,
          bubbles: true,
          composed: true,
        }),
      );
      return outcome;
    } finally {
      this.busy = false;
      this.runBtnEl.disabled = false;
    }
  }

  private syncAttributes(): void {
    const kindAttr = this.getAttribute("kind");
    if (kindAttr === "video" || kindAttr === "image") {
      this.kind = kindAttr;
    }
    const promptAttr = this.getAttribute("prompt");
    if (promptAttr !== null && !this.inputEl.value) {
      this.inputEl.value = promptAttr;
    }
    this.syncLabels();
  }

  private syncLabels(): void {
    this.kindBtnEl.textContent = this.kind === "video" ? "短视频" : "配图";
    this.runBtnEl.textContent = this.kind === "video" ? "生成短视频" : "生成配图";
  }
}

export function registerMossUIKit(): void {
  if (typeof customElements === "undefined") return;
  if (!customElements.get("moss-selection-ask")) {
    customElements.define("moss-selection-ask", MossSelectionAsk);
  }
  if (!customElements.get("moss-companion-drawer")) {
    customElements.define("moss-companion-drawer", MossCompanionDrawer);
  }
  if (!customElements.get("moss-bot-meeting-bar")) {
    customElements.define("moss-bot-meeting-bar", MossbotMeetingBar);
  }
  if (!customElements.get("moss-media-trigger")) {
    customElements.define("moss-media-trigger", MossMediaTrigger);
  }
}

export function mountSelectionAsk(options: MossSelectionAskOptions = {}): MossSelectionAsk {
  registerMossUIKit();
  const el = document.createElement("moss-selection-ask") as MossSelectionAsk;
  el.configure(options);
  document.body.appendChild(el);
  return el;
}

export function mountCompanionDrawer(
  options: MossCompanionDrawerOptions = {},
): MossCompanionDrawer {
  registerMossUIKit();
  const el = document.createElement("moss-companion-drawer") as MossCompanionDrawer;
  el.configure(options);
  (options.container ?? document.body).appendChild(el);
  return el;
}

export function mountMossbotMeetingBar(options: MossbotMeetingBarOptions = {}): MossbotMeetingBar {
  registerMossUIKit();
  const el = document.createElement("moss-bot-meeting-bar") as MossbotMeetingBar;
  el.configure(options);
  (options.container ?? document.body).appendChild(el);
  return el;
}

export function mountMediaTrigger(options: MossMediaTriggerOptions = {}): MossMediaTrigger {
  registerMossUIKit();
  const el = document.createElement("moss-media-trigger") as MossMediaTrigger;
  el.configure(options);
  (options.container ?? document.body).appendChild(el);
  return el;
}
