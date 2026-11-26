// FILE: primitives.ts
// Purpose: Non-invasive Shadow DOM Moss Core UI Primitives matching docs/design/moss-design-standard.md:
//          MossButton, MossCard, MossTabs, MossDrawer, MossDialog, MossBadge, MossToast, MossMarkdown.
// Layer: Shared Page App UI Kit

import { BaseHtmlElement, createShadowHost } from "./dom";

export interface MossTabItem {
  readonly id: string;
  readonly label: string;
  readonly content?: string;
  readonly disabled?: boolean;
}

const BUTTON_CSS = `
:host { display: inline-flex; }
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--moss-radius-control);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-card);
  color: var(--moss-ink);
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.btn:hover:not(:disabled) { background: var(--moss-hover); }
.btn:active:not(:disabled) { background: var(--moss-active); }
.btn.variant-primary { background: var(--moss-ink); color: var(--moss-paper); border-color: transparent; }
.btn.variant-primary:hover:not(:disabled) { background: var(--moss-ink); color: var(--moss-paper); opacity: 0.88; }
.btn.variant-secondary { background: var(--moss-surface); color: var(--moss-ink); border-color: var(--moss-border); }
.btn.variant-ghost { background: transparent; color: var(--moss-ink-2); border-color: transparent; }
.btn.variant-ghost:hover:not(:disabled) { background: var(--moss-hover); color: var(--moss-ink); }
.btn.variant-destructive { background: var(--moss-danger-soft); color: var(--moss-danger); border-color: rgba(224, 46, 42, 0.28); }
.btn.size-xs { height: 24px; padding: 0 8px; font-size: 12px; line-height: 16px; border-radius: 6px; }
.btn.size-sm { height: 28px; padding: 0 10px; font-size: 13px; line-height: 17px; }
.btn.size-lg { height: 40px; padding: 0 16px; font-size: 14px; }
.btn.size-icon-sm { width: 28px; height: 28px; padding: 0; }
.btn.size-icon-xs { width: 24px; height: 24px; padding: 0; border-radius: 6px; }
`;

export class MossButton extends BaseHtmlElement {
  static get observedAttributes(): string[] {
    return ["variant", "size", "disabled", "label", "theme"];
  }
  private btnEl!: HTMLButtonElement;
  private labelSpan!: HTMLSpanElement;

  constructor() {
    super();
    const shadow = createShadowHost(this, BUTTON_CSS);
    this.btnEl = document.createElement("button");
    this.btnEl.type = "button";
    this.btnEl.className = "btn";
    this.labelSpan = document.createElement("span");
    const slot = document.createElement("slot");
    this.btnEl.appendChild(slot);
    this.btnEl.appendChild(this.labelSpan);
    shadow.appendChild(this.btnEl);
  }

  connectedCallback(): void {
    this.sync();
  }
  attributeChangedCallback(): void {
    this.sync();
  }

  private sync(): void {
    const variant = this.getAttribute("variant") ?? "default";
    const size = this.getAttribute("size") ?? "default";
    this.btnEl.className = `btn variant-${variant} size-${size}`;
    this.btnEl.disabled =
      this.hasAttribute("disabled") && this.getAttribute("disabled") !== "false";
    const label = this.getAttribute("label");
    this.labelSpan.textContent = label ?? "";
    this.labelSpan.style.display = label ? "" : "none";
  }
}

const CARD_CSS = `
.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border);
  background: var(--moss-card);
  color: var(--moss-ink);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.head.hidden { display: none; }
.title { font-size: 15px; line-height: 20px; font-weight: 500; }
.subtitle { font-size: 13px; line-height: 17px; color: var(--moss-ink-2); margin-top: 2px; }
`;

export class MossCard extends BaseHtmlElement {
  static get observedAttributes(): string[] {
    return ["title", "subtitle", "theme"];
  }
  private headEl!: HTMLDivElement;
  private titleEl!: HTMLDivElement;
  private subtitleEl!: HTMLDivElement;

  constructor() {
    super();
    const shadow = createShadowHost(this, CARD_CSS);
    const card = document.createElement("div");
    card.className = "card";

    this.headEl = document.createElement("div");
    this.headEl.className = "head";
    const titles = document.createElement("div");
    this.titleEl = document.createElement("div");
    this.titleEl.className = "title";
    this.subtitleEl = document.createElement("div");
    this.subtitleEl.className = "subtitle";
    titles.appendChild(this.titleEl);
    titles.appendChild(this.subtitleEl);

    const actions = document.createElement("slot");
    actions.name = "actions";
    this.headEl.appendChild(titles);
    this.headEl.appendChild(actions);

    const body = document.createElement("slot");
    const footer = document.createElement("slot");
    footer.name = "footer";

    card.appendChild(this.headEl);
    card.appendChild(body);
    card.appendChild(footer);
    shadow.appendChild(card);
  }

  connectedCallback(): void {
    this.sync();
  }
  attributeChangedCallback(): void {
    this.sync();
  }

  private sync(): void {
    const title = this.getAttribute("title") ?? "";
    const subtitle = this.getAttribute("subtitle") ?? "";
    this.titleEl.textContent = title;
    this.subtitleEl.textContent = subtitle;
    this.subtitleEl.style.display = subtitle ? "" : "none";
    this.headEl.classList.toggle("hidden", !title && !subtitle);
  }
}

const TABS_CSS = `
.tabs { display: flex; flex-direction: column; gap: 10px; }
.list {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  border-radius: var(--moss-radius-control);
  background: var(--moss-surface);
  border: 1px solid var(--moss-border);
  width: fit-content;
}
.tab {
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 17px;
  font-weight: 500;
  color: var(--moss-ink-2);
  transition: background-color 120ms ease, color 120ms ease;
}
.tab:hover:not(:disabled) { color: var(--moss-ink); background: var(--moss-hover); }
.tab.active {
  background: var(--moss-card);
  color: var(--moss-ink);
  border: 1px solid var(--moss-border);
}
.panel {
  font-size: 14px;
  line-height: 20px;
}
`;

export class MossTabs extends BaseHtmlElement {
  static get observedAttributes(): string[] {
    return ["tabs", "value", "theme"];
  }
  private items: MossTabItem[] = [];
  private activeId = "";
  private listEl!: HTMLDivElement;
  private panelEl!: HTMLDivElement;

  constructor() {
    super();
    const shadow = createShadowHost(this, TABS_CSS);
    const wrap = document.createElement("div");
    wrap.className = "tabs";
    this.listEl = document.createElement("div");
    this.listEl.className = "list";
    this.listEl.setAttribute("role", "tablist");
    this.panelEl = document.createElement("div");
    this.panelEl.className = "panel";
    this.panelEl.setAttribute("role", "tabpanel");
    const slot = document.createElement("slot");
    this.panelEl.appendChild(slot);
    wrap.appendChild(this.listEl);
    wrap.appendChild(this.panelEl);
    shadow.appendChild(wrap);
  }

  connectedCallback(): void {
    this.syncFromAttr();
  }
  attributeChangedCallback(): void {
    this.syncFromAttr();
  }

  setTabs(items: readonly MossTabItem[], activeId?: string): void {
    this.items = [...items];
    this.activeId = activeId ?? this.items[0]?.id ?? "";
    this.render();
  }

  get value(): string {
    return this.activeId;
  }

  set value(next: string) {
    this.select(next, false);
  }

  select(id: string, emit = true): void {
    const target = this.items.find((item) => item.id === id && !item.disabled);
    if (!target) return;
    this.activeId = id;
    this.render();
    if (emit) {
      this.dispatchEvent(
        new CustomEvent("moss-tab-change", {
          detail: { value: id },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private syncFromAttr(): void {
    const raw = this.getAttribute("tabs");
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as MossTabItem[];
        if (Array.isArray(parsed)) this.items = parsed;
      } catch {
        // ignore invalid JSON
      }
    }
    const val = this.getAttribute("value");
    if (val) this.activeId = val;
    if (!this.activeId && this.items[0]) this.activeId = this.items[0].id;
    this.render();
  }

  private render(): void {
    this.listEl.textContent = "";
    for (const item of this.items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `tab${item.id === this.activeId ? " active" : ""}`;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", item.id === this.activeId ? "true" : "false");
      btn.setAttribute("data-moss-tab", item.id);
      btn.disabled = !!item.disabled;
      btn.textContent = item.label;
      btn.addEventListener("click", () => this.select(item.id, true));
      this.listEl.appendChild(btn);
    }
    const active = this.items.find((item) => item.id === this.activeId);
    let contentNode = this.panelEl.querySelector<HTMLDivElement>("[data-moss-tab-content]");
    if (active?.content !== undefined) {
      if (!contentNode) {
        contentNode = document.createElement("div");
        contentNode.setAttribute("data-moss-tab-content", "true");
        this.panelEl.prepend(contentNode);
      }
      contentNode.textContent = active.content;
    } else if (contentNode) {
      contentNode.remove();
    }
  }
}

const DRAWER_CSS = `
.drawer {
  display: flex;
  flex-direction: column;
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border);
  background: var(--moss-surface);
  overflow: hidden;
}
.drawer.closed .body,
.drawer.closed .foot { display: none; }
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 40px;
  padding: 0 12px;
  background: var(--moss-paper);
  border-bottom: 1px solid var(--moss-border);
}
.drawer.closed .head { border-bottom: 0; }
.title { font-size: 14px; font-weight: 500; }
.body { padding: 12px; }
.foot { padding: 10px 12px; border-top: 1px solid var(--moss-border); background: var(--moss-paper); }
`;

export class MossDrawer extends BaseHtmlElement {
  static get observedAttributes(): string[] {
    return ["title", "open", "theme"];
  }
  private wrapEl!: HTMLDivElement;
  private titleEl!: HTMLSpanElement;
  private toggleBtnEl!: HTMLButtonElement;
  private isOpen = true;

  constructor() {
    super();
    const shadow = createShadowHost(this, DRAWER_CSS);
    this.wrapEl = document.createElement("div");
    this.wrapEl.className = "drawer";

    const head = document.createElement("div");
    head.className = "head";
    this.titleEl = document.createElement("span");
    this.titleEl.className = "title";
    this.titleEl.textContent = "侧栏";
    this.toggleBtnEl = document.createElement("button");
    this.toggleBtnEl.type = "button";
    this.toggleBtnEl.className = "moss-btn moss-btn-ghost";
    this.toggleBtnEl.textContent = "收起";
    this.toggleBtnEl.addEventListener("click", () => this.toggle());
    head.appendChild(this.titleEl);
    head.appendChild(this.toggleBtnEl);

    const body = document.createElement("div");
    body.className = "body";
    body.appendChild(document.createElement("slot"));

    const foot = document.createElement("div");
    foot.className = "foot";
    const footerSlot = document.createElement("slot");
    footerSlot.name = "footer";
    foot.appendChild(footerSlot);

    this.wrapEl.appendChild(head);
    this.wrapEl.appendChild(body);
    this.wrapEl.appendChild(foot);
    shadow.appendChild(this.wrapEl);
  }

  connectedCallback(): void {
    this.sync();
  }
  attributeChangedCallback(): void {
    this.sync();
  }

  open(): void {
    this.isOpen = true;
    this.renderState();
  }
  close(): void {
    this.isOpen = false;
    this.renderState();
  }
  toggle(): void {
    this.isOpen = !this.isOpen;
    this.renderState();
    this.dispatchEvent(
      new CustomEvent("moss-drawer-change", {
        detail: { open: this.isOpen },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private sync(): void {
    const title = this.getAttribute("title");
    if (title) this.titleEl.textContent = title;
    const openAttr = this.getAttribute("open");
    if (openAttr !== null) this.isOpen = openAttr !== "false";
    this.renderState();
  }

  private renderState(): void {
    this.wrapEl.classList.toggle("closed", !this.isOpen);
    this.toggleBtnEl.textContent = this.isOpen ? "收起" : "展开";
  }
}

const DIALOG_CSS = `
:host { position: fixed; inset: 0; z-index: 2147483200; pointer-events: none; }
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(20, 20, 19, 0.36);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  pointer-events: auto;
}
.backdrop.hidden { display: none; }
.panel {
  width: min(460px, 100%);
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-card);
  color: var(--moss-ink);
  box-shadow: var(--moss-shadow-popover);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.title { font-size: 16px; line-height: 22px; font-weight: 500; margin: 0; }
.desc { font-size: 13px; line-height: 19px; color: var(--moss-ink-2); margin: 0; }
.foot { display: flex; justify-content: flex-end; gap: 8px; }
`;

export class MossDialog extends BaseHtmlElement {
  static get observedAttributes(): string[] {
    return ["open", "title", "description", "theme"];
  }
  private backdropEl!: HTMLDivElement;
  private titleEl!: HTMLHeadingElement;
  private descEl!: HTMLParagraphElement;
  private readonly onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && !this.backdropEl.classList.contains("hidden")) {
      this.close();
    }
  };

  constructor() {
    super();
    const shadow = createShadowHost(this, DIALOG_CSS);
    this.backdropEl = document.createElement("div");
    this.backdropEl.className = "backdrop hidden";
    this.backdropEl.addEventListener("click", (ev) => {
      if (ev.target === this.backdropEl) this.close();
    });

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");

    const head = document.createElement("div");
    head.className = "head";
    this.titleEl = document.createElement("h2");
    this.titleEl.className = "title";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "moss-btn moss-btn-ghost";
    closeBtn.setAttribute("aria-label", "关闭弹窗");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.close());
    head.appendChild(this.titleEl);
    head.appendChild(closeBtn);

    this.descEl = document.createElement("p");
    this.descEl.className = "desc";

    const bodySlot = document.createElement("slot");
    const foot = document.createElement("div");
    foot.className = "foot";
    const footSlot = document.createElement("slot");
    footSlot.name = "footer";
    foot.appendChild(footSlot);

    panel.appendChild(head);
    panel.appendChild(this.descEl);
    panel.appendChild(bodySlot);
    panel.appendChild(foot);
    this.backdropEl.appendChild(panel);
    shadow.appendChild(this.backdropEl);
  }

  connectedCallback(): void {
    document.addEventListener("keydown", this.onKeyDown);
    this.sync();
  }
  disconnectedCallback(): void {
    document.removeEventListener("keydown", this.onKeyDown);
  }
  attributeChangedCallback(): void {
    this.sync();
  }

  show(): void {
    this.setAttribute("open", "true");
  }

  close(): void {
    this.removeAttribute("open");
    this.backdropEl.classList.add("hidden");
    this.dispatchEvent(new CustomEvent("moss-dialog-close", { bubbles: true, composed: true }));
  }

  private sync(): void {
    const isOpen = this.hasAttribute("open") && this.getAttribute("open") !== "false";
    this.backdropEl.classList.toggle("hidden", !isOpen);
    this.titleEl.textContent = this.getAttribute("title") ?? "";
    const desc = this.getAttribute("description") ?? "";
    this.descEl.textContent = desc;
    this.descEl.style.display = desc ? "" : "none";
  }
}

const BADGE_CSS = `
:host { display: inline-flex; }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border-radius: var(--moss-radius-pill);
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  background: var(--moss-hover);
  color: var(--moss-ink-2);
}
.badge.variant-accent { background: var(--moss-accent-soft); color: var(--moss-accent); }
.badge.variant-success { background: var(--moss-success-soft); color: var(--moss-success); }
.badge.variant-warn { background: var(--moss-warn-soft); color: var(--moss-warn); }
.badge.variant-danger { background: var(--moss-danger-soft); color: var(--moss-danger); }
`;

export class MossBadge extends BaseHtmlElement {
  static get observedAttributes(): string[] {
    return ["variant", "label", "theme"];
  }
  private badgeEl!: HTMLSpanElement;
  private textEl!: HTMLSpanElement;

  constructor() {
    super();
    const shadow = createShadowHost(this, BADGE_CSS);
    this.badgeEl = document.createElement("span");
    this.badgeEl.className = "badge";
    this.textEl = document.createElement("span");
    this.badgeEl.appendChild(document.createElement("slot"));
    this.badgeEl.appendChild(this.textEl);
    shadow.appendChild(this.badgeEl);
  }

  connectedCallback(): void {
    this.sync();
  }
  attributeChangedCallback(): void {
    this.sync();
  }

  private sync(): void {
    const variant = this.getAttribute("variant") ?? "neutral";
    this.badgeEl.className = `badge variant-${variant}`;
    const label = this.getAttribute("label");
    this.textEl.textContent = label ?? "";
    this.textEl.style.display = label ? "" : "none";
  }
}

const TOAST_CSS = `
:host {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483100;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(360px, calc(100vw - 32px));
  padding: 8px 12px;
  border-radius: var(--moss-radius-popover);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-popover);
  backdrop-filter: blur(12px);
  box-shadow: var(--moss-shadow-popover);
  font-size: 13px;
  line-height: 18px;
  color: var(--moss-ink);
}
.toast.hidden { display: none; }
.dot { width: 7px; height: 7px; border-radius: 999px; background: var(--moss-accent); flex-shrink: 0; }
.toast.variant-success .dot { background: var(--moss-success); }
.toast.variant-warn .dot { background: var(--moss-warn); }
.toast.variant-danger .dot { background: var(--moss-danger); }
`;

export class MossToast extends BaseHtmlElement {
  static get observedAttributes(): string[] {
    return ["message", "variant", "open", "theme"];
  }
  private toastEl!: HTMLDivElement;
  private textEl!: HTMLSpanElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  static show(
    message: string,
    options: {
      readonly variant?: "neutral" | "success" | "warn" | "danger";
      readonly durationMs?: number;
    } = {},
  ): MossToast {
    if (typeof customElements !== "undefined" && !customElements.get("moss-toast")) {
      customElements.define("moss-toast", MossToast);
    }
    let existing = document.querySelector<MossToast>("moss-toast[data-moss-singleton='true']");
    if (!existing) {
      existing = document.createElement("moss-toast") as MossToast;
      existing.setAttribute("data-moss-singleton", "true");
      document.body.appendChild(existing);
    }
    existing.present(message, options.variant ?? "neutral", options.durationMs ?? 2800);
    return existing;
  }

  constructor() {
    super();
    const shadow = createShadowHost(this, TOAST_CSS);
    this.toastEl = document.createElement("div");
    this.toastEl.className = "toast hidden";
    this.toastEl.setAttribute("role", "status");
    const dot = document.createElement("span");
    dot.className = "dot";
    this.textEl = document.createElement("span");
    this.toastEl.appendChild(dot);
    this.toastEl.appendChild(this.textEl);
    shadow.appendChild(this.toastEl);
  }

  connectedCallback(): void {
    this.sync();
  }
  attributeChangedCallback(): void {
    this.sync();
  }

  present(message: string, variant = "neutral", durationMs = 2800): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.setAttribute("message", message);
    this.setAttribute("variant", variant);
    this.setAttribute("open", "true");
    if (durationMs > 0) {
      this.timer = setTimeout(() => this.hide(), durationMs);
    }
  }

  hide(): void {
    this.removeAttribute("open");
    this.toastEl.classList.add("hidden");
  }

  private sync(): void {
    const isOpen = this.hasAttribute("open") && this.getAttribute("open") !== "false";
    const variant = this.getAttribute("variant") ?? "neutral";
    this.toastEl.className = `toast variant-${variant}${isOpen ? "" : " hidden"}`;
    this.textEl.textContent = this.getAttribute("message") ?? "";
  }
}

const MARKDOWN_CSS = `
.md { font-size: 14px; line-height: 22px; color: var(--moss-ink); }
.md h1, .md h2, .md h3 { margin: 12px 0 6px; font-weight: 500; line-height: 1.35; }
.md h1 { font-size: 18px; }
.md h2 { font-size: 16px; }
.md h3 { font-size: 14px; }
.md p { margin: 6px 0; }
.md ul, .md ol { margin: 6px 0; padding-left: 20px; }
.md li { margin: 3px 0; }
.md blockquote {
  margin: 8px 0;
  padding: 6px 10px;
  border-left: 2px solid var(--moss-border-strong);
  color: var(--moss-ink-2);
  background: var(--moss-hover);
  border-radius: 4px;
}
.md code {
  font-family: var(--moss-mono);
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--moss-hover);
}
.md pre {
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: var(--moss-radius-control);
  background: var(--moss-surface);
  border: 1px solid var(--moss-border);
  overflow-x: auto;
}
.md pre code { background: transparent; padding: 0; }
.md a { color: var(--moss-accent); text-decoration: none; }
.md a:hover { text-decoration: underline; }
`;

function appendInlineMarkdown(parent: HTMLElement, text: string): void {
  const tokenPattern =
    /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\))/gu;
  let lastIndex = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const at = match.index ?? 0;
    if (at > lastIndex) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex, at)));
    }
    const token = match[0]!;
    if (token.startsWith("**") && token.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.style.fontWeight = "500";
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if (token.startsWith("[")) {
      const sep = token.indexOf("](");
      const label = token.slice(1, sep);
      const href = token.slice(sep + 2, -1);
      const a = document.createElement("a");
      a.textContent = label;
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      parent.appendChild(a);
    }
    lastIndex = at + token.length;
  }
  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

export class MossMarkdown extends BaseHtmlElement {
  static get observedAttributes(): string[] {
    return ["content", "theme"];
  }
  private rootEl!: HTMLDivElement;
  private rawContent = "";

  constructor() {
    super();
    const shadow = createShadowHost(this, MARKDOWN_CSS);
    this.rootEl = document.createElement("div");
    this.rootEl.className = "md";
    shadow.appendChild(this.rootEl);
  }

  connectedCallback(): void {
    const attr = this.getAttribute("content");
    if (attr !== null) this.rawContent = attr;
    else if (!this.rawContent && this.textContent?.trim()) this.rawContent = this.textContent;
    this.render();
  }

  attributeChangedCallback(): void {
    const attr = this.getAttribute("content");
    if (attr !== null) {
      this.rawContent = attr;
      this.render();
    }
  }

  setContent(markdown: string): void {
    this.rawContent = markdown;
    this.render();
  }

  private render(): void {
    this.rootEl.textContent = "";
    const lines = this.rawContent.replace(/\r\n/gu, "\n").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.startsWith("```")) {
        const buf: string[] = [];
        i += 1;
        while (i < lines.length && !lines[i]!.startsWith("```")) {
          buf.push(lines[i]!);
          i += 1;
        }
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = buf.join("\n");
        pre.appendChild(code);
        this.rootEl.appendChild(pre);
        i += 1;
        continue;
      }
      if (!line.trim()) {
        i += 1;
        continue;
      }
      if (line.startsWith("### ") || line.startsWith("## ") || line.startsWith("# ")) {
        const level = line.startsWith("### ") ? 3 : line.startsWith("## ") ? 2 : 1;
        const h = document.createElement(`h${level}`);
        appendInlineMarkdown(h, line.slice(level + 1));
        this.rootEl.appendChild(h);
        i += 1;
        continue;
      }
      if (line.startsWith("> ")) {
        const bq = document.createElement("blockquote");
        appendInlineMarkdown(bq, line.slice(2));
        this.rootEl.appendChild(bq);
        i += 1;
        continue;
      }
      if (/^[-*] /u.test(line)) {
        const ul = document.createElement("ul");
        while (i < lines.length && /^[-*] /u.test(lines[i]!)) {
          const li = document.createElement("li");
          appendInlineMarkdown(li, lines[i]!.slice(2));
          ul.appendChild(li);
          i += 1;
        }
        this.rootEl.appendChild(ul);
        continue;
      }
      const p = document.createElement("p");
      appendInlineMarkdown(p, line);
      this.rootEl.appendChild(p);
      i += 1;
    }
  }
}

export function registerMossPrimitives(): void {
  if (typeof customElements === "undefined") return;
  const entries: Array<[string, CustomElementConstructor]> = [
    ["moss-button", MossButton as unknown as CustomElementConstructor],
    ["moss-card", MossCard as unknown as CustomElementConstructor],
    ["moss-tabs", MossTabs as unknown as CustomElementConstructor],
    ["moss-drawer", MossDrawer as unknown as CustomElementConstructor],
    ["moss-dialog", MossDialog as unknown as CustomElementConstructor],
    ["moss-badge", MossBadge as unknown as CustomElementConstructor],
    ["moss-toast", MossToast as unknown as CustomElementConstructor],
    ["moss-markdown", MossMarkdown as unknown as CustomElementConstructor],
  ];
  for (const [tag, ctor] of entries) {
    if (!customElements.get(tag)) customElements.define(tag, ctor);
  }
}

export function mountButton(opts: {
  container?: HTMLElement | null;
  label: string;
  variant?: string;
  size?: string;
  onClick?: () => void;
}): MossButton {
  registerMossPrimitives();
  const el = document.createElement("moss-button") as MossButton;
  el.setAttribute("label", opts.label);
  if (opts.variant) el.setAttribute("variant", opts.variant);
  if (opts.size) el.setAttribute("size", opts.size);
  if (opts.onClick) el.addEventListener("click", opts.onClick);
  (opts.container ?? document.body).appendChild(el);
  return el;
}

export function mountCard(
  opts: { container?: HTMLElement | null; title?: string; subtitle?: string } = {},
): MossCard {
  registerMossPrimitives();
  const el = document.createElement("moss-card") as MossCard;
  if (opts.title) el.setAttribute("title", opts.title);
  if (opts.subtitle) el.setAttribute("subtitle", opts.subtitle);
  (opts.container ?? document.body).appendChild(el);
  return el;
}

export function mountTabs(opts: {
  container?: HTMLElement | null;
  tabs: readonly MossTabItem[];
  value?: string;
}): MossTabs {
  registerMossPrimitives();
  const el = document.createElement("moss-tabs") as MossTabs;
  el.setTabs(opts.tabs, opts.value);
  (opts.container ?? document.body).appendChild(el);
  return el;
}

export function mountDrawer(
  opts: { container?: HTMLElement | null; title?: string; open?: boolean } = {},
): MossDrawer {
  registerMossPrimitives();
  const el = document.createElement("moss-drawer") as MossDrawer;
  if (opts.title) el.setAttribute("title", opts.title);
  if (opts.open === false) el.setAttribute("open", "false");
  (opts.container ?? document.body).appendChild(el);
  return el;
}

export function mountDialog(opts: {
  container?: HTMLElement | null;
  title: string;
  description?: string;
  open?: boolean;
}): MossDialog {
  registerMossPrimitives();
  const el = document.createElement("moss-dialog") as MossDialog;
  el.setAttribute("title", opts.title);
  if (opts.description) el.setAttribute("description", opts.description);
  if (opts.open) el.setAttribute("open", "true");
  (opts.container ?? document.body).appendChild(el);
  return el;
}

export function mountBadge(opts: {
  container?: HTMLElement | null;
  label: string;
  variant?: string;
}): MossBadge {
  registerMossPrimitives();
  const el = document.createElement("moss-badge") as MossBadge;
  el.setAttribute("label", opts.label);
  if (opts.variant) el.setAttribute("variant", opts.variant);
  (opts.container ?? document.body).appendChild(el);
  return el;
}

export function mountMarkdown(opts: {
  container?: HTMLElement | null;
  content: string;
}): MossMarkdown {
  registerMossPrimitives();
  const el = document.createElement("moss-markdown") as MossMarkdown;
  el.setContent(opts.content);
  (opts.container ?? document.body).appendChild(el);
  return el;
}
