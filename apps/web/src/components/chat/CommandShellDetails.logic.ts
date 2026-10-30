// FILE: CommandShellDetails.logic.ts
// Purpose: Normalize command payloads and resolve Codex-style shell status/copy text.
// Layer: Chat presentation utility
// Exports: normalizeShellCommand, formatShellCommandDisplay, resolveCommandShellStatus,
//          resolveCommandShellOutputText
// Depends on: WorkLog tool output/live activity shapes

import type { WorkLogLiveActivity } from "../../workLog";
import type { WorkLogToolOutputDetails } from "../../lib/toolCallDetails";
import { formatToolOutputText } from "../../lib/toolCallDetailsFormatting";
import { isLiveActivityInProgress } from "../../lib/liveActivityPresentation";

export type TerminalDecoration =
  | "bold"
  | "dim"
  | "italic"
  | "underline"
  | "blink"
  | "reverse"
  | "hidden"
  | "strikethrough";

export interface TerminalTextSegment {
  text: string;
  /** Codex ansiToJson(use_classes: true) class stems, without -fg/-bg. */
  foreground?: string;
  background?: string;
  /** Only the last active decoration is styled. */
  decoration?: TerminalDecoration;
  /** Retained for parity with ansiToJson; rendering uses `decoration`. */
  decorations?: readonly TerminalDecoration[];
}

/**
 * The command sent to a provider is sometimes wrapped in the shell transport
 * used to launch it. Codex shows the command itself in its shell surface, not
 * that transport wrapper. Keep this parser deliberately narrow: only a pure
 * bash/zsh `-lc` wrapper is removed, while a real command's quoting stays
 * intact.
 */
export function normalizeShellCommand(command: string): string {
  const input = command.trim();
  if (!input) {
    return "";
  }

  const withoutPrompt = input.replace(/^\$\s+/, "").trim();
  const transport = /^(?:(?:\/[^\s/]+)*\/)?(?:bash|zsh)\s+-lc\s+([\s\S]+)$/iu.exec(withoutPrompt);

  return transport?.[1] ? unwrapTransportQuotes(transport[1]) : withoutPrompt;
}

/** The shell prompt is presentation-only and is never duplicated. */
export function formatShellCommandDisplay(command: string): string {
  const normalized = normalizeShellCommand(command);
  return normalized ? `$ ${normalized}` : "";
}

export function resolveCommandShellCopyPayloads(
  command: string,
  output: WorkLogToolOutputDetails | undefined,
): { command: string; output: string } {
  return {
    command: normalizeShellCommand(command),
    output: formatToolOutputText(output) ?? "",
  };
}

/** Combined Shell clipboard payload (`$ raw-command\noutput`). */
export function formatCommandShellCopyPayload(command: string, output: string): string {
  return [command ? `$ ${command}` : "", output].filter(Boolean).join("\n");
}

export type CommandShellStatus =
  | { kind: "running" }
  | { kind: "stopped" }
  | { kind: "success" }
  | { kind: "exit-code"; exitCode: number | undefined };

/**
 * Resolve status in the same priority order as Codex's exec footer. In
 * particular, a running activity wins over a stale exit code and cancellation
 * wins over a zero exit code.
 */
export function resolveCommandShellStatus(
  activity: WorkLogLiveActivity | undefined,
  output: WorkLogToolOutputDetails | undefined,
): CommandShellStatus {
  if (activity && isLiveActivityInProgress(activity)) {
    return { kind: "running" };
  }
  if (activity?.state === "cancelled") {
    return { kind: "stopped" };
  }
  if (output?.exitCode === 0) {
    return { kind: "success" };
  }
  return { kind: "exit-code", exitCode: output?.exitCode };
}

/**
 * A live command with no output intentionally renders a blank output region;
 * settled commands use the localized empty-state copy instead.
 */
export function resolveCommandShellOutputText(
  output: WorkLogToolOutputDetails | undefined,
  activity: WorkLogLiveActivity | undefined,
  noOutputLabel: string,
): string {
  const formattedOutput = formatToolOutputText(output);
  if (formattedOutput && /\S/.test(formattedOutput)) {
    return formattedOutput;
  }
  return activity && isLiveActivityInProgress(activity) ? "" : noOutputLabel;
}

export function normalizeTerminalOutputForRender(text: string): string {
  if (!text) {
    return "";
  }

  // The backspace cleanup runs before the carriage-return pass.
  return normalizeCarriageReturns(stripBackspaces(text));
}

export function parseTerminalTextSegments(text: string): TerminalTextSegment[] {
  if (!text) {
    return [];
  }

  const segments: TerminalTextSegment[] = [];
  const chunks = text.split("\x1b[");
  const initial = chunks.shift() ?? "";
  if (initial) {
    segments.push({ text: initial });
  }

  let state = defaultAnsiState();
  for (const chunk of chunks) {
    const parsed = parseAnsiChunk(chunk);
    if (!parsed) {
      // ansiToJson returns an unprocessed chunk as plain text when the CSI
      // payload is malformed or is not an SGR operation.
      if (chunk) {
        segments.push({ text: chunk });
      }
      continue;
    }

    if (parsed.isSgr) {
      state = applyAnsiCodes(state, parsed.params);
      if (parsed.content) {
        segments.push(segmentFromState(parsed.content, state));
      }
      continue;
    }

    if (parsed.content) {
      segments.push({ text: parsed.content });
    }
  }

  return segments;
}

interface ParsedAnsiChunk {
  content: string;
  isSgr: boolean;
  params: string;
}

function parseAnsiChunk(chunk: string): ParsedAnsiChunk | undefined {
  // This is the exact chunk grammar used by the bundled AnsiTerminal parser:
  // private prefix, numeric params, final/intermediate bytes, then content.
  const match = /^([!\x3c-\x3f]*)([\d;]*)([\x20-\x2c]*[\x40-\x7e])([\s\S]*)/m.exec(chunk);
  if (!match) {
    return undefined;
  }

  const prefix = match[1] ?? "";
  const params = match[2] ?? "";
  const operation = match[3] ?? "";
  return {
    content: match[4] ?? "",
    isSgr: prefix === "" && operation === "m",
    params,
  };
}

function unwrapTransportQuotes(value: string): string {
  let result = value.trim().replace(/'"'"'/g, "'");

  // The provider can add more than one shell quote layer. Unwrap only after a
  // recognized bash/zsh -lc transport; never apply this to arbitrary commands.
  for (;;) {
    if (!result) {
      return "";
    }
    if (result.startsWith("$'") && result.endsWith("'")) {
      result = result.slice(2, -1).replace(/\\'/g, "'").trim();
      continue;
    }

    const first = result[0];
    const last = result.at(-1);
    const isSingleQuoted = first === "'" && last === "'";
    const isDoubleQuoted = first === '"' && last === '"';
    if (!isSingleQuoted && !isDoubleQuoted) {
      return result.trim();
    }

    result = result.slice(1, -1).trim();
    if (isDoubleQuoted) {
      result = result.replace(/\\"/g, '"');
    }
    result = result.replace(/'"'"'/g, "'");
  }
}

interface AnsiState {
  foreground: string | null;
  background: string | null;
  decorations: TerminalDecoration[];
}

function defaultAnsiState(): AnsiState {
  return {
    foreground: null,
    background: null,
    decorations: [],
  };
}

function segmentFromState(text: string, state: AnsiState): TerminalTextSegment {
  let foreground = state.foreground;
  let background = state.background;
  const decorations = [...state.decorations];

  // Codex's `processChunk` resolves every reverse decoration in order. Missing
  // colours are first filled with white/black, then swapped. This matters for
  // the common `\x1b[7m` case: the visible result is black text on white.
  for (const decoration of state.decorations) {
    if (decoration !== "reverse") {
      continue;
    }
    foreground ??= ansiColorVariable(7, false) ?? null;
    background ??= ansiColorVariable(0, false) ?? null;
    [foreground, background] = [background, foreground];
    const index = decorations.indexOf("reverse");
    if (index >= 0) {
      decorations.splice(index, 1);
    }
  }

  const lastDecoration = decorations.at(-1);
  return {
    text,
    ...(foreground !== null ? { foreground } : {}),
    ...(background !== null ? { background } : {}),
    ...(lastDecoration ? { decoration: lastDecoration } : {}),
    ...(decorations.length > 0 ? { decorations } : {}),
  };
}

function applyAnsiCodes(state: AnsiState, params: string): AnsiState {
  const codes = params.length > 0 ? params.split(";") : ["0"];
  let next = { ...state };
  next.decorations = [...state.decorations];

  while (codes.length > 0) {
    const rawCode = codes.shift();
    const code = Number.parseInt(rawCode ?? "0", 10);
    if (!Number.isFinite(code) || code === 0) {
      next = defaultAnsiState();
      continue;
    }
    const decorationByCode: Partial<Record<number, TerminalDecoration>> = {
      1: "bold",
      2: "dim",
      3: "italic",
      4: "underline",
      5: "blink",
      7: "reverse",
      8: "hidden",
      9: "strikethrough",
    };
    const decoration = decorationByCode[code];
    if (decoration) {
      next.decorations.push(decoration);
      continue;
    }
    const resetDecorationByCode: Partial<Record<number, TerminalDecoration>> = {
      21: "bold",
      23: "italic",
      24: "underline",
      25: "blink",
      27: "reverse",
      28: "hidden",
      29: "strikethrough",
    };
    const resetDecoration = resetDecorationByCode[code];
    if (resetDecoration) {
      removeDecoration(next.decorations, resetDecoration);
      continue;
    }
    if (code === 22) {
      removeDecoration(next.decorations, "bold");
      removeDecoration(next.decorations, "dim");
      continue;
    }
    if (code === 39) {
      next.foreground = null;
      continue;
    }
    if (code === 49) {
      next.background = null;
      continue;
    }
    if (code >= 30 && code <= 37) {
      next.foreground = ansiColorVariable(code - 30, false) ?? null;
      continue;
    }
    if (code >= 90 && code <= 97) {
      next.foreground = ansiColorVariable(code - 90, true) ?? null;
      continue;
    }
    if (code >= 40 && code <= 47) {
      next.background = ansiColorVariable(code - 40, false) ?? null;
      continue;
    }
    if (code >= 100 && code <= 107) {
      next.background = ansiColorVariable(code - 100, true) ?? null;
      continue;
    }
    if (code === 38 || code === 48) {
      const mode = codes.shift();
      if (mode === "5") {
        const paletteIndex = Number.parseInt(codes.shift() ?? "", 10);
        const paletteColor = ansiPaletteColor(paletteIndex);
        if (paletteColor) {
          if (code === 38) {
            next.foreground = paletteColor;
          } else {
            next.background = paletteColor;
          }
        }
        continue;
      }
      if (mode === "2") {
        const red = Number.parseInt(codes.shift() ?? "", 10);
        const green = Number.parseInt(codes.shift() ?? "", 10);
        const blue = Number.parseInt(codes.shift() ?? "", 10);
        const truecolor = ansiTruecolor(red, green, blue);
        if (truecolor) {
          if (code === 38) {
            next.foreground = truecolor;
          } else {
            next.background = truecolor;
          }
        }
        continue;
      }
    }
  }

  return next;
}

function removeDecoration(decorations: TerminalDecoration[], decoration: TerminalDecoration): void {
  const index = decorations.indexOf(decoration);
  if (index >= 0) {
    decorations.splice(index, 1);
  }
}

function ansiColorVariable(index: number, bright: boolean): string | undefined {
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  const name = names[index];
  if (!name) {
    return undefined;
  }
  return bright ? `ansi-bright-${name}` : `ansi-${name}`;
}

function ansiPaletteColor(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    return undefined;
  }
  if (index < 16) {
    return ansiColorVariable(index % 8, index >= 8);
  }

  // Emit the palette class, with no inline RGB fallback.
  return `ansi-palette-${index}`;
}

function ansiTruecolor(red: number, green: number, blue: number): string | undefined {
  return [red, green, blue].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? "ansi-truecolor"
    : undefined;
}

function stripBackspaces(text: string): string {
  let previous = text;
  let next = previous;
  do {
    previous = next;
    next = previous.replace(/[^\n]\x08/g, "");
  } while (next.length < previous.length);
  return next;
}

function normalizeCarriageReturns(text: string): string {
  if (!/\r/.test(text)) {
    return text;
  }

  let current = text.replace(/\r+\n/gm, "\n");
  while (/\r./.test(current)) {
    current = current.replace(/^([^\r\n]*)\r+([^\r\n]+)/gm, (_match, before, replacement) => {
      const replacementLength = replacement.replace(ANSI_CSI_SEQUENCE, "").length;
      const sgrPrefix = before.match(ANSI_SGR_SEQUENCE)?.join("") ?? "";
      let consumed = 0;
      const suffix = ANSI_ERASE_LINE.test(replacement)
        ? ""
        : before.replace(new RegExp(`${ANSI_CSI_SEQUENCE.source}|.`, "g"), (token: string) => {
            if (token.startsWith("\x1b")) {
              return token;
            }
            return consumed++ >= replacementLength ? token : "";
          });

      return `${sgrPrefix}${replacement}${suffix && replacement.match(ANSI_SGR_SEQUENCE) ? "\x1b[0m" : ""}${suffix}`;
    });
  }
  return current;
}

const ANSI_CSI_SEQUENCE = /\x1b\[[\d;]*[A-Za-z]/g;
const ANSI_SGR_SEQUENCE = /\x1b\[[\d;]*m/g;
const ANSI_ERASE_LINE = /\x1b\[(?:0|2)?K/;
