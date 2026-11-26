// FILE: tokens.ts
// Purpose: Scoped Moss light/dark design tokens and base Shadow DOM reset for Moss UI Kit.
// Layer: Shared Page App UI Kit (framework-free, strictly scoped to :host)

export const MOSS_UI_KIT_VERSION = "1.0.0";

export const MOSS_UI_KIT_CLASSIC_URLS = [
  "https://cdn.jsdelivr.net/npm/@moss/ui-kit@1.0.0/dist/moss-ui-kit.umd.js",
  "https://cdn.jsdelivr.net/npm/@moss/ui-kit@1.0.0/dist/moss-ui-kit.min.js",
  "https://unpkg.com/@moss/ui-kit@1.0.0/dist/moss-ui-kit.umd.js",
  "https://unpkg.com/@moss/ui-kit@1.0.0/dist/moss-ui-kit.min.js",
] as const;

export const MOSS_UI_KIT_MODULE_URLS = [
  "moss-ui-kit",
  "https://cdn.jsdelivr.net/npm/@moss/ui-kit@1.0.0/+esm",
  "https://unpkg.com/@moss/ui-kit@1.0.0/+esm",
] as const;

/**
 * Light and dark Moss design tokens following `docs/design/moss-design-standard.md`.
 * Strictly scoped via `:host` inside Shadow DOM (or `:root` in the optional standalone CSS file)
 * so host Page App stylesheets are never mutated or polluted.
 */
export const MOSS_UI_KIT_TOKENS_CSS = `
:host {
  color-scheme: light dark;
  --moss-paper: #fcfcfb;
  --moss-surface: #f4f3ef;
  --moss-card: #fdfdfc;
  --moss-popover: rgba(253, 253, 252, 0.94);
  --moss-ink: #141413;
  --moss-ink-2: rgba(20, 20, 19, 0.62);
  --moss-ink-3: rgba(20, 20, 19, 0.42);
  --moss-border: rgba(20, 20, 19, 0.08);
  --moss-border-strong: rgba(20, 20, 19, 0.14);
  --moss-hover: rgba(20, 20, 19, 0.04);
  --moss-active: rgba(20, 20, 19, 0.08);
  --moss-accent: #2a78d6;
  --moss-accent-soft: rgba(42, 120, 214, 0.12);
  --moss-coral: #d97757;
  --moss-coral-soft: rgba(217, 119, 87, 0.14);
  --moss-success: #00a240;
  --moss-success-soft: rgba(0, 162, 64, 0.10);
  --moss-warn: #d97706;
  --moss-warn-soft: rgba(217, 119, 6, 0.12);
  --moss-danger: #e02e2a;
  --moss-danger-soft: rgba(224, 46, 42, 0.10);
  --moss-shadow-popover: 0 8px 24px rgba(20, 20, 19, 0.08), 0 1px 2px rgba(20, 20, 19, 0.04);
  --moss-radius-control: 8px;
  --moss-radius-card: 12px;
  --moss-radius-popover: 12px;
  --moss-radius-pill: 999px;
  --moss-font: "Inter Variable", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif;
  --moss-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"])) {
    --moss-paper: #1c1c1b;
    --moss-surface: #1a1a19;
    --moss-card: #1e1e1d;
    --moss-popover: rgba(33, 33, 32, 0.94);
    --moss-ink: #f0efec;
    --moss-ink-2: rgba(240, 239, 236, 0.60);
    --moss-ink-3: rgba(240, 239, 236, 0.38);
    --moss-border: rgba(240, 239, 236, 0.09);
    --moss-border-strong: rgba(240, 239, 236, 0.16);
    --moss-hover: rgba(240, 239, 236, 0.05);
    --moss-active: rgba(240, 239, 236, 0.10);
    --moss-accent: #3987e5;
    --moss-accent-soft: rgba(57, 135, 229, 0.18);
    --moss-coral: #d97757;
    --moss-coral-soft: rgba(217, 119, 87, 0.20);
    --moss-success: #00a240;
    --moss-success-soft: rgba(0, 162, 64, 0.18);
    --moss-warn: #f5b44a;
    --moss-warn-soft: rgba(245, 180, 74, 0.16);
    --moss-danger: #e02e2a;
    --moss-danger-soft: rgba(224, 46, 42, 0.18);
    --moss-shadow-popover: 0 10px 28px rgba(0, 0, 0, 0.36), 0 1px 2px rgba(0, 0, 0, 0.24);
  }
}

:host([theme="dark"]),
:host-context([data-theme="dark"]),
:host-context(.dark) {
  --moss-paper: #1c1c1b;
  --moss-surface: #1a1a19;
  --moss-card: #1e1e1d;
  --moss-popover: rgba(33, 33, 32, 0.94);
  --moss-ink: #f0efec;
  --moss-ink-2: rgba(240, 239, 236, 0.60);
  --moss-ink-3: rgba(240, 239, 236, 0.38);
  --moss-border: rgba(240, 239, 236, 0.09);
  --moss-border-strong: rgba(240, 239, 236, 0.16);
  --moss-hover: rgba(240, 239, 236, 0.05);
  --moss-active: rgba(240, 239, 236, 0.10);
  --moss-accent: #3987e5;
  --moss-accent-soft: rgba(57, 135, 229, 0.18);
  --moss-coral: #d97757;
  --moss-coral-soft: rgba(217, 119, 87, 0.20);
  --moss-success: #00a240;
  --moss-success-soft: rgba(0, 162, 64, 0.18);
  --moss-warn: #f5b44a;
  --moss-warn-soft: rgba(245, 180, 74, 0.16);
  --moss-danger: #e02e2a;
  --moss-danger-soft: rgba(224, 46, 42, 0.18);
  --moss-shadow-popover: 0 10px 28px rgba(0, 0, 0, 0.36), 0 1px 2px rgba(0, 0, 0, 0.24);
}
`.trim();

export const MOSS_UI_KIT_BASE_SHADOW_CSS = `
${MOSS_UI_KIT_TOKENS_CSS}

:host {
  all: initial;
  display: block;
  font-family: var(--moss-font);
  font-size: 14px;
  line-height: 20px;
  font-weight: 400;
  color: var(--moss-ink);
  -webkit-font-smoothing: antialiased;
}

*, *::before, *::after {
  box-sizing: border-box;
}

button, input, textarea {
  font: inherit;
  color: inherit;
}

button {
  cursor: pointer;
  border: 0;
  background: transparent;
  padding: 0;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.moss-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--moss-radius-control);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-card);
  color: var(--moss-ink);
  font-size: 13px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.moss-btn:hover:not(:disabled) {
  background: var(--moss-hover);
}

.moss-btn:active:not(:disabled) {
  background: var(--moss-active);
}

.moss-btn-primary {
  background: var(--moss-ink);
  color: var(--moss-paper);
  border-color: transparent;
}

.moss-btn-primary:hover:not(:disabled) {
  background: var(--moss-ink);
  color: var(--moss-paper);
  opacity: 0.88;
}

.moss-btn-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--moss-ink-2);
}

.moss-btn-ghost:hover:not(:disabled) {
  background: var(--moss-hover);
  color: var(--moss-ink);
}

.moss-input {
  height: 28px;
  min-width: 0;
  padding: 0 10px;
  border-radius: var(--moss-radius-control);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-paper);
  color: var(--moss-ink);
  font-size: 13px;
  line-height: 17px;
  outline: none;
}

.moss-input::placeholder {
  color: var(--moss-ink-3);
}

.moss-input:focus {
  border-color: var(--moss-accent);
}
`.trim();
