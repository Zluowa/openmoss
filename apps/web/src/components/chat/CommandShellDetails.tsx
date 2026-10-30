// FILE: CommandShellDetails.tsx
// Purpose: Render command tool details as the Codex-style inline Shell surface.
// Layer: Chat presentation component
// Exports: CommandShellDetails
// Depends on: normalized tool output, live activity, shared clipboard/localization primitives

import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon } from "~/lib/icons";
import { cx } from "class-variance-authority";
import { useTranslation } from "~/localization";
import { DisclosureRegion } from "../ui/DisclosureRegion";

import type { WorkLogLiveActivity } from "../../workLog";
import type { WorkLogToolOutputDetails } from "../../lib/toolCallDetails";
import {
  formatShellCommandDisplay,
  formatCommandShellCopyPayload,
  normalizeTerminalOutputForRender,
  parseTerminalTextSegments,
  resolveCommandShellCopyPayloads,
  resolveCommandShellOutputText,
  resolveCommandShellStatus,
  type TerminalTextSegment,
} from "./CommandShellDetails.logic";

const COMMAND_SHELL_BORDER_COLOR =
  "var(--color-border-heavy, var(--color-token-border-heavy, var(--color-border)))";
const COMMAND_SHELL_EDGE_FADE_DISTANCE = "2rem";

type ShellOutputFadeState = {
  top: boolean;
  bottom: boolean;
};

export function CommandShellDetails(props: {
  command: string;
  cwd?: string | undefined;
  output?: WorkLogToolOutputDetails | undefined;
  activity?: WorkLogLiveActivity | undefined;
  variant?: "default" | "embedded";
}) {
  const { command, output, activity, variant = "default" } = props;
  const isEmbedded = variant === "embedded";
  const { t, format } = useTranslation();
  const [expandedCommand, setExpandedCommand] = useState<string | null>(null);
  const [shellExpanded, setShellExpanded] = useState(true);
  const [outputFade, setOutputFade] = useState<ShellOutputFadeState>({ top: false, bottom: false });
  const outputScrollRef = useRef<HTMLDivElement | null>(null);
  const commandId = useId();
  const shellBodyId = `${commandId}-body`;
  const copyPayloads = resolveCommandShellCopyPayloads(command, output);
  const normalizedCommand = copyPayloads.command;
  const commandExpanded = expandedCommand === normalizedCommand;
  const commandDisplay = formatShellCommandDisplay(command);
  const renderedOutputText = resolveCommandShellOutputText(
    output,
    activity,
    t("chat.shell.noOutput"),
  );
  const renderedOutputSegments = parseTerminalTextSegments(
    normalizeTerminalOutputForRender(renderedOutputText),
  );
  const status = resolveCommandShellStatus(activity, output);
  const { copyToClipboard: copyCommand, isCopied: commandCopied } = useCopyToClipboard();
  const { copyToClipboard: copyOutput, isCopied: outputCopied } = useCopyToClipboard();
  const { copyToClipboard: copyContents, isCopied: contentsCopied } = useCopyToClipboard();
  // Codex copies the exact visible shell transcript: a prompt-prefixed command,
  // followed by one newline and the captured output (no extra blank line).
  const shellCopyPayload = formatCommandShellCopyPayload(command, copyPayloads.output);

  const updateOutputFade = useCallback(() => {
    const outputScroll = outputScrollRef.current;
    if (!outputScroll) return;
    const maxScrollTop = outputScroll.scrollHeight - outputScroll.clientHeight;
    const overflowing = maxScrollTop > 1;
    const atVisualBottom = -outputScroll.scrollTop >= maxScrollTop - 1;
    const atVisualTop = outputScroll.scrollTop >= -1;
    const next: ShellOutputFadeState = {
      top: overflowing && !atVisualBottom,
      bottom: overflowing && !atVisualTop,
    };
    setOutputFade((current) =>
      current.top === next.top && current.bottom === next.bottom ? current : next,
    );
  }, []);

  useLayoutEffect(() => {
    updateOutputFade();
  }, [renderedOutputText, updateOutputFade]);

  function expandCommand() {
    setExpandedCommand(normalizedCommand);
  }

  function onCommandKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") {
      return;
    }
    event.preventDefault();
    expandCommand();
  }

  const commandBlock =
    isEmbedded && normalizedCommand ? (
      <div className="px-2 pt-2">
        <div className="group/command relative min-w-0 pe-6">
          <div
            id={commandId}
            role="button"
            tabIndex={0}
            aria-expanded={commandExpanded}
            aria-label={format("chat.shell.commandLine", { command: normalizedCommand })}
            className={cx(
              "cursor-interaction rounded-md bg-transparent text-size-chat-sm text-codex-description whitespace-pre-wrap break-words font-vscode-editor focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
              !commandExpanded && "line-clamp-2",
            )}
            data-shell-command="true"
            data-command-expanded={commandExpanded ? "true" : "false"}
            onClick={expandCommand}
            onKeyDown={onCommandKeyDown}
          >
            <span className="me-[1ch] text-tertiary">$</span>
            <code className="contents" data-translation-skip="true">
              <RenderedShellOutput
                segments={parseTerminalTextSegments(commandDisplay.slice(2))}
                fallbackText={commandDisplay.slice(2)}
              />
            </code>
          </div>
          <button
            type="button"
            className="absolute top-0 right-0 inline-flex size-5 items-center justify-center rounded-sm text-tertiary opacity-0 outline-none transition-opacity duration-200 hover:bg-muted hover:text-default group-hover/command:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            aria-label={commandCopied ? t("chat.shell.copied") : t("chat.shell.copyCommand")}
            title={commandCopied ? t("chat.shell.copied") : t("chat.shell.copyCommand")}
            data-shell-copy="command"
            data-shell-copy-state={commandCopied ? "copied" : "idle"}
            onClick={() => copyCommand(normalizedCommand)}
          >
            {commandCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </button>
        </div>
      </div>
    ) : null;

  const shellContent = (
    <>
      {commandBlock}
      <div className="group/output relative min-h-5 pe-0">
        <div
          ref={outputScrollRef}
          className={cx(
            "vertical-scroll-fade-mask scroll-fade-y box-border flex max-h-36 flex-col-reverse overflow-x-auto overflow-y-auto whitespace-pre font-medium [--edge-fade-distance:2rem] [--scroll-fade-size:2rem] [animation-direction:reverse]",
            isEmbedded
              ? "font-vscode-editor text-codex-description text-size-chat-sm"
              : "font-chat-code text-ui-sm leading-relaxed text-muted-foreground opacity-80",
          )}
          data-shell-output-scroll="true"
          data-shell-output-fade-top={outputFade.top ? "true" : "false"}
          data-shell-output-fade-bottom={outputFade.bottom ? "true" : "false"}
          onScroll={updateOutputFade}
          style={
            {
              "--scroll-fade-size": COMMAND_SHELL_EDGE_FADE_DISTANCE,
              "--edge-fade-distance": COMMAND_SHELL_EDGE_FADE_DISTANCE,
            } as CSSProperties
          }
        >
          <div className="w-max min-w-full p-2" data-translation-skip="true">
            <RenderedShellOutput
              segments={renderedOutputSegments}
              fallbackText={renderedOutputText}
            />
          </div>
        </div>
        <button
          type="button"
          className="absolute top-0 right-2.5 inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground/75 opacity-0 outline-none transition-opacity duration-200 hover:bg-muted hover:text-foreground group-hover/output:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          aria-label={outputCopied ? t("chat.shell.copied") : t("chat.shell.copyOutput")}
          title={outputCopied ? t("chat.shell.copied") : t("chat.shell.copyOutput")}
          data-shell-copy="output"
          data-shell-copy-state={outputCopied ? "copied" : "idle"}
          onClick={() => copyOutput(copyPayloads.output)}
        >
          {outputCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </button>
      </div>
      {isEmbedded ? <CommandShellFooter status={status} /> : null}
    </>
  );

  return (
    <div
      className={cx(
        "group flex min-w-0 flex-col overflow-hidden rounded-lg border",
        isEmbedded
          ? "border-strong bg-secondary-soft-alpha"
          : "bg-[var(--color-background-elevated-secondary)]",
      )}
      style={isEmbedded ? undefined : { borderColor: COMMAND_SHELL_BORDER_COLOR }}
      data-command-shell="true"
      data-command-shell-variant={variant}
      data-command-shell-status={status.kind}
    >
      {isEmbedded ? (
        <div
          className="flex items-center justify-between gap-2 px-2 py-1 font-sans text-ui-lg text-codex-description select-none"
          data-shell-label="true"
        >
          <span>{t("chat.shell.label")}</span>
        </div>
      ) : (
        <div
          className="flex min-h-[30px] items-center justify-between gap-2 bg-[var(--color-background-elevated-secondary)] ps-2 text-ui-lg font-medium text-foreground/80 hover:bg-[var(--color-background-elevated-tertiary)]"
          data-shell-header="true"
        >
          <span data-shell-label="true">{t("chat.shell.label")}</span>
          <span className="flex items-center gap-0.5">
            <button
              type="button"
              className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground/75 transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              aria-label={contentsCopied ? t("chat.shell.copied") : t("chat.shell.copyContents")}
              title={contentsCopied ? t("chat.shell.copied") : t("chat.shell.copyContents")}
              data-shell-copy="contents"
              data-shell-copy-state={contentsCopied ? "copied" : "idle"}
              onClick={() => copyContents(shellCopyPayload)}
            >
              {contentsCopied ? (
                <CheckIcon className="icon-2xs" />
              ) : (
                <CopyIcon className="icon-2xs" />
              )}
            </button>
            <button
              type="button"
              className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground/75 transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              aria-label={shellExpanded ? t("chat.shell.collapse") : t("chat.shell.expand")}
              title={shellExpanded ? t("chat.shell.collapse") : t("chat.shell.expand")}
              data-shell-toggle="true"
              aria-expanded={shellExpanded}
              aria-controls={shellBodyId}
              onClick={() => setShellExpanded((current) => !current)}
            >
              {shellExpanded ? (
                <ChevronUpIcon className="icon-2xs" />
              ) : (
                <ChevronDownIcon className="icon-2xs" />
              )}
            </button>
          </span>
        </div>
      )}
      <div id={shellBodyId} data-shell-body="true">
        {isEmbedded ? (
          <div className="relative min-w-0 overflow-hidden">{shellContent}</div>
        ) : (
          <DisclosureRegion open={shellExpanded} className="min-w-0" contentClassName="min-w-0">
            {shellContent}
          </DisclosureRegion>
        )}
      </div>
    </div>
  );
}

function RenderedShellOutput(props: {
  segments: ReadonlyArray<TerminalTextSegment>;
  fallbackText: string;
}) {
  if (props.segments.length === 0) {
    return props.fallbackText;
  }

  return props.segments.map((segment, index) => (
    <span
      key={index}
      className={cx(
        segment.foreground && `${segment.foreground}-fg`,
        segment.background && `${segment.background}-bg`,
      )}
      style={terminalSegmentStyle(segment)}
    >
      {segment.text}
    </span>
  ));
}

function terminalSegmentStyle(segment: TerminalTextSegment): CSSProperties | undefined {
  const style: CSSProperties = {};

  // The frozen Codex bundle stores all active decorations but its `ve` style
  // helper intentionally renders only `segment.decoration`, the last one.
  // Blink has no visual branch there, so preserve the state without inventing
  // a Moss animation that the reference does not show.
  switch (segment.decoration) {
    case "bold":
      style.fontWeight = "bold";
      break;
    case "dim":
      style.opacity = 0.5;
      break;
    case "italic":
      style.fontStyle = "italic";
      break;
    case "hidden":
      style.visibility = "hidden";
      break;
    case "underline":
      style.textDecorationLine = "underline";
      break;
    case "strikethrough":
      style.textDecorationLine = "line-through";
      break;
    case "blink":
    case "reverse":
    case undefined:
      break;
  }

  return Object.keys(style).length > 0 ? style : undefined;
}

function CommandShellFooter({ status }: { status: ReturnType<typeof resolveCommandShellStatus> }) {
  const { t, format } = useTranslation();

  if (status.kind === "running") {
    return (
      <div
        className="px-2.5 pt-0.5 pb-1 text-size-chat"
        aria-hidden="true"
        data-shell-footer="running"
      />
    );
  }

  if (status.kind === "stopped") {
    return (
      <div
        className="flex items-center gap-2 px-2.5 pt-0.5 pb-1 text-size-chat text-tertiary"
        data-shell-footer="stopped"
      >
        <span className="ms-auto">{t("chat.shell.stopped")}</span>
      </div>
    );
  }

  if (status.kind === "success") {
    return (
      <div
        className="flex items-center gap-2 px-2.5 pt-0.5 pb-1 text-size-chat text-tertiary"
        data-shell-footer="success"
      >
        <span className="ms-auto flex items-center gap-1">
          <CheckIcon className="size-3" />
          <span>{t("chat.shell.success")}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-2 px-2.5 pt-0.5 pb-1 text-size-chat text-tertiary"
      data-shell-footer="exit-code"
    >
      <span className="ms-auto">
        {format("chat.shell.exitCode", { code: status.exitCode ?? t("chat.shell.unknown") })}
      </span>
    </div>
  );
}
