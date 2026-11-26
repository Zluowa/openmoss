// FILE: voice.ts
// Purpose: Native Moss Voice UI components styled identically to Moss's chat voice controls:
//          MossVoiceButton (<moss-voice-button>) and MossRealtimeVoiceBar (<moss-realtime-voice-bar>).
// Layer: Shared Page App UI Kit

import {
  BaseHtmlElement,
  createMicSvg,
  createRealtimeVoiceBarsIcon,
  createShadowHost,
  createSpeakerSvg,
} from "./dom";
import {
  runMossRealtimeVoiceStart,
  runMossRealtimeVoiceStop,
  runMossVoiceSpeak,
  runMossVoiceStartListening,
  runMossVoiceStopAndTranscribe,
  runMossVoiceStopSpeaking,
  type MossRealtimeVoiceOutcome,
  type MossVoiceSpeakOutcome,
  type MossVoiceTranscriptOutcome,
} from "./mossBridge";

export interface MossVoiceButtonOptions {
  readonly container?: HTMLElement | null;
  readonly mode?: "dictate" | "speak";
  readonly appearance?: "circle" | "ghost";
  readonly text?: string;
  readonly theme?: "light" | "dark" | "auto";
  readonly onTranscript?: (outcome: MossVoiceTranscriptOutcome) => void;
  readonly onSpeak?: (outcome: MossVoiceSpeakOutcome) => void;
}

export interface MossRealtimeVoiceBarOptions {
  readonly container?: HTMLElement | null;
  readonly topic?: string;
  readonly theme?: "light" | "dark" | "auto";
  readonly getContext?: () => string;
  readonly getSummaryText?: () => string;
  readonly onStateChange?: (outcome: MossRealtimeVoiceOutcome) => void;
}

const VOICE_BTN_CSS = `
:host { display: inline-flex; align-items: center; gap: 6px; }
.voice-btn {
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
}
.voice-btn:hover:not(:disabled) { background: var(--moss-hover); }
.voice-btn.circle {
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: var(--moss-radius-pill);
}
.voice-btn.recording {
  background: var(--moss-ink);
  color: var(--moss-paper);
  border-color: transparent;
}
.status {
  font-size: 12px;
  color: var(--moss-ink-2);
  font-variant-numeric: tabular-nums;
}
.status.hidden { display: none; }
`;

export class MossVoiceButton extends BaseHtmlElement {
  static get observedAttributes(): string[] {
    return ["mode", "appearance", "text", "label", "theme"];
  }
  private mode: "dictate" | "speak" = "dictate";
  private appearance: "circle" | "ghost" = "ghost";
  private recording = false;
  private speaking = false;
  private busy = false;
  private elapsedSec = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onTranscriptCb: ((outcome: MossVoiceTranscriptOutcome) => void) | null = null;
  private onSpeakCb: ((outcome: MossVoiceSpeakOutcome) => void) | null = null;

  private btnEl!: HTMLButtonElement;
  private iconWrapEl!: HTMLSpanElement;
  private labelEl!: HTMLSpanElement;
  private statusEl!: HTMLSpanElement;

  constructor() {
    super();
    const shadow = createShadowHost(this, VOICE_BTN_CSS);
    this.btnEl = document.createElement("button");
    this.btnEl.type = "button";
    this.btnEl.className = "voice-btn";
    this.btnEl.setAttribute("data-moss-role", "voice-btn");
    this.btnEl.addEventListener("click", () => void this.handlePress());

    this.iconWrapEl = document.createElement("span");
    this.iconWrapEl.style.display = "inline-flex";
    this.labelEl = document.createElement("span");
    this.btnEl.appendChild(this.iconWrapEl);
    this.btnEl.appendChild(this.labelEl);

    this.statusEl = document.createElement("span");
    this.statusEl.className = "status hidden";
    this.statusEl.setAttribute("data-moss-role", "voice-status");

    shadow.appendChild(this.btnEl);
    shadow.appendChild(this.statusEl);
    this.render();
  }

  connectedCallback(): void {
    this.sync();
  }
  disconnectedCallback(): void {
    this.stopTimer();
  }
  attributeChangedCallback(): void {
    this.sync();
  }

  configure(options: MossVoiceButtonOptions): void {
    if (options.mode) {
      this.mode = options.mode;
      this.setAttribute("mode", options.mode);
    }
    if (options.appearance) {
      this.appearance = options.appearance;
      this.setAttribute("appearance", options.appearance);
    }
    if (options.text !== undefined) this.setAttribute("text", options.text);
    if (options.theme && options.theme !== "auto") this.setAttribute("theme", options.theme);
    if (options.onTranscript) this.onTranscriptCb = options.onTranscript;
    if (options.onSpeak) this.onSpeakCb = options.onSpeak;
    this.render();
  }

  async handlePress(): Promise<void> {
    if (this.busy) return;
    if (this.mode === "speak") {
      if (this.speaking) {
        await runMossVoiceStopSpeaking();
        this.speaking = false;
        this.render();
        return;
      }
      const text = this.getAttribute("text") ?? "Moss 语音播报已就绪。";
      this.busy = true;
      this.render();
      try {
        const outcome = await runMossVoiceSpeak({ text });
        this.speaking = outcome.speaking;
        this.statusEl.textContent = outcome.statusText;
        this.statusEl.classList.remove("hidden");
        this.onSpeakCb?.(outcome);
        this.dispatchEvent(
          new CustomEvent("moss-voice-spoken", {
            detail: outcome,
            bubbles: true,
            composed: true,
          }),
        );
      } finally {
        this.busy = false;
        this.render();
      }
      return;
    }

    if (!this.recording) {
      this.busy = true;
      this.render();
      try {
        await runMossVoiceStartListening({ language: "zh-CN" });
        this.recording = true;
        this.elapsedSec = 0;
        this.startTimer();
        this.statusEl.textContent = "00:00";
        this.statusEl.classList.remove("hidden");
        this.dispatchEvent(
          new CustomEvent("moss-voice-state", {
            detail: { recording: true },
            bubbles: true,
            composed: true,
          }),
        );
      } finally {
        this.busy = false;
        this.render();
      }
      return;
    }

    this.recording = false;
    this.stopTimer();
    this.busy = true;
    this.statusEl.textContent = "识别中…";
    this.render();
    try {
      const outcome = await runMossVoiceStopAndTranscribe({ language: "zh-CN" });
      this.statusEl.textContent = outcome.text;
      this.statusEl.classList.remove("hidden");
      this.onTranscriptCb?.(outcome);
      this.dispatchEvent(
        new CustomEvent("moss-voice-transcript", {
          detail: outcome,
          bubbles: true,
          composed: true,
        }),
      );
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      this.elapsedSec += 1;
      const mins = String(Math.floor(this.elapsedSec / 60)).padStart(2, "0");
      const secs = String(this.elapsedSec % 60).padStart(2, "0");
      this.statusEl.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private sync(): void {
    const modeAttr = this.getAttribute("mode");
    if (modeAttr === "speak" || modeAttr === "dictate") this.mode = modeAttr;
    const appAttr = this.getAttribute("appearance");
    if (appAttr === "circle" || appAttr === "ghost") this.appearance = appAttr;
    this.render();
  }

  private render(): void {
    this.iconWrapEl.textContent = "";
    this.iconWrapEl.appendChild(this.mode === "speak" ? createSpeakerSvg(14) : createMicSvg(14));
    this.btnEl.className = `voice-btn${this.appearance === "circle" ? " circle" : ""}${this.recording || this.speaking ? " recording" : ""}`;
    this.btnEl.disabled = this.busy;
    const customLabel = this.getAttribute("label");
    if (this.appearance === "circle") {
      this.labelEl.textContent = "";
      this.btnEl.setAttribute(
        "aria-label",
        this.mode === "speak"
          ? this.speaking
            ? "停止朗读"
            : (customLabel ?? "朗读")
          : this.recording
            ? "完成录音"
            : (customLabel ?? "语音输入"),
      );
    } else {
      this.labelEl.textContent =
        this.mode === "speak"
          ? this.speaking
            ? "停止朗读"
            : (customLabel ?? "朗读")
          : this.recording
            ? "完成录音"
            : (customLabel ?? "语音输入");
    }
  }
}

const REALTIME_VOICE_BAR_CSS = `
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-card);
  color: var(--moss-ink);
}
.left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.waves {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 24px;
}
.wave-bar {
  width: 2px;
  border-radius: 1px;
  background: var(--moss-ink);
  transition: height 160ms ease;
}
.meta {
  font-size: 13px;
  line-height: 17px;
  color: var(--moss-ink-2);
  font-variant-numeric: tabular-nums;
}
.actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
`;

export class MossRealtimeVoiceBar extends BaseHtmlElement {
  static get observedAttributes(): string[] {
    return ["topic", "theme"];
  }
  private active = false;
  private busy = false;
  private sessionId: string | undefined;
  private elapsedSec = 0;
  private waveTimer: ReturnType<typeof setInterval> | null = null;
  private getContextFn: (() => string) | null = null;
  private getSummaryTextFn: (() => string) | null = null;
  private onStateCb: ((outcome: MossRealtimeVoiceOutcome) => void) | null = null;

  private wavesEl!: HTMLDivElement;
  private metaEl!: HTMLSpanElement;
  private toggleBtnEl!: HTMLButtonElement;
  private speakBtnEl!: HTMLButtonElement;

  constructor() {
    super();
    const shadow = createShadowHost(this, REALTIME_VOICE_BAR_CSS);
    const bar = document.createElement("div");
    bar.className = "bar";

    const left = document.createElement("div");
    left.className = "left";
    this.wavesEl = document.createElement("div");
    this.wavesEl.className = "waves";
    this.metaEl = document.createElement("span");
    this.metaEl.className = "meta";
    this.metaEl.setAttribute("data-moss-role", "realtime-status");
    this.metaEl.textContent = "实时语音待命";
    left.appendChild(this.wavesEl);
    left.appendChild(this.metaEl);

    const actions = document.createElement("div");
    actions.className = "actions";

    this.speakBtnEl = document.createElement("button");
    this.speakBtnEl.type = "button";
    this.speakBtnEl.className = "moss-btn";
    this.speakBtnEl.setAttribute("data-moss-role", "speak-summary");
    this.speakBtnEl.appendChild(createSpeakerSvg(13));
    this.speakBtnEl.appendChild(document.createTextNode("朗读纪要"));
    this.speakBtnEl.addEventListener("click", () => void this.speakSummary());

    this.toggleBtnEl = document.createElement("button");
    this.toggleBtnEl.type = "button";
    this.toggleBtnEl.className = "moss-btn moss-btn-primary";
    this.toggleBtnEl.setAttribute("data-moss-role", "toggle-realtime");
    this.toggleBtnEl.addEventListener("click", () => void this.toggleSession());

    actions.appendChild(this.speakBtnEl);
    actions.appendChild(this.toggleBtnEl);
    bar.appendChild(left);
    bar.appendChild(actions);
    shadow.appendChild(bar);
    this.render();
  }

  disconnectedCallback(): void {
    this.stopWaveTimer();
  }

  configure(options: MossRealtimeVoiceBarOptions): void {
    if (options.topic) this.setAttribute("topic", options.topic);
    if (options.theme && options.theme !== "auto") this.setAttribute("theme", options.theme);
    if (options.getContext) this.getContextFn = options.getContext;
    if (options.getSummaryText) this.getSummaryTextFn = options.getSummaryText;
    if (options.onStateChange) this.onStateCb = options.onStateChange;
  }

  async toggleSession(): Promise<MossRealtimeVoiceOutcome> {
    if (this.busy) {
      return { via: "fallback", active: this.active, statusText: this.metaEl.textContent ?? "" };
    }
    this.busy = true;
    this.render();
    try {
      if (!this.active) {
        const outcome = await runMossRealtimeVoiceStart({
          topic: this.getAttribute("topic") ?? document.title,
          context: this.getContextFn?.() ?? "",
        });
        this.active = outcome.active;
        this.sessionId = outcome.sessionId;
        this.elapsedSec = 0;
        if (this.active) this.startWaveTimer();
        this.metaEl.textContent = outcome.statusText;
        this.onStateCb?.(outcome);
        this.dispatchEvent(
          new CustomEvent("moss-realtime-voice-state", {
            detail: outcome,
            bubbles: true,
            composed: true,
          }),
        );
        return outcome;
      }

      const outcome = await runMossRealtimeVoiceStop(
        this.sessionId !== undefined ? { sessionId: this.sessionId } : {},
      );
      this.active = false;
      this.sessionId = undefined;
      this.stopWaveTimer();
      this.metaEl.textContent = outcome.statusText;
      this.onStateCb?.(outcome);
      this.dispatchEvent(
        new CustomEvent("moss-realtime-voice-state", {
          detail: outcome,
          bubbles: true,
          composed: true,
        }),
      );
      return outcome;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async speakSummary(overrideText?: string): Promise<MossVoiceSpeakOutcome> {
    const text = (overrideText ?? this.getSummaryTextFn?.() ?? "会议要点已准备就绪。").trim();
    const outcome = await runMossVoiceSpeak({ text });
    this.metaEl.textContent = outcome.statusText;
    this.dispatchEvent(
      new CustomEvent("moss-voice-spoken", {
        detail: outcome,
        bubbles: true,
        composed: true,
      }),
    );
    return outcome;
  }

  private startWaveTimer(): void {
    this.stopWaveTimer();
    this.waveTimer = setInterval(() => {
      this.elapsedSec += 1;
      const mins = String(Math.floor(this.elapsedSec / 60)).padStart(2, "0");
      const secs = String(this.elapsedSec % 60).padStart(2, "0");
      this.metaEl.textContent = `实时语音中 · ${mins}:${secs}`;
      this.renderWaves();
    }, 500);
  }

  private stopWaveTimer(): void {
    if (this.waveTimer !== null) {
      clearInterval(this.waveTimer);
      this.waveTimer = null;
    }
  }

  private renderWaves(): void {
    this.wavesEl.textContent = "";
    const heights = this.active
      ? [6, 14, 18, 10, 16, 8, 12, 17, 9, 13]
      : [4, 7, 11, 8, 5, 4, 7, 10, 6, 4];
    for (let i = 0; i < heights.length; i += 1) {
      const bar = document.createElement("span");
      bar.className = "wave-bar";
      const jitter = this.active ? ((this.elapsedSec + i) % 3) * 2 : 0;
      bar.style.height = `${Math.min(22, heights[i]! + jitter)}px`;
      bar.style.opacity = this.active ? "0.9" : "0.35";
      this.wavesEl.appendChild(bar);
    }
  }

  private render(): void {
    this.renderWaves();
    this.toggleBtnEl.textContent = "";
    this.toggleBtnEl.appendChild(createRealtimeVoiceBarsIcon(this.busy));
    this.toggleBtnEl.appendChild(
      document.createTextNode(this.active ? "结束实时语音" : "开启实时语音"),
    );
    this.toggleBtnEl.disabled = this.busy;
    this.speakBtnEl.disabled = this.busy;
  }
}

export function registerMossVoiceComponents(): void {
  if (typeof customElements === "undefined") return;
  if (!customElements.get("moss-voice-button")) {
    customElements.define(
      "moss-voice-button",
      MossVoiceButton as unknown as CustomElementConstructor,
    );
  }
  if (!customElements.get("moss-realtime-voice-bar")) {
    customElements.define(
      "moss-realtime-voice-bar",
      MossRealtimeVoiceBar as unknown as CustomElementConstructor,
    );
  }
}

export function mountVoiceButton(options: MossVoiceButtonOptions = {}): MossVoiceButton {
  registerMossVoiceComponents();
  const el = document.createElement("moss-voice-button") as MossVoiceButton;
  el.configure(options);
  (options.container ?? document.body).appendChild(el);
  return el;
}

export function mountRealtimeVoiceBar(
  options: MossRealtimeVoiceBarOptions = {},
): MossRealtimeVoiceBar {
  registerMossVoiceComponents();
  const el = document.createElement("moss-realtime-voice-bar") as MossRealtimeVoiceBar;
  el.configure(options);
  (options.container ?? document.body).appendChild(el);
  return el;
}
