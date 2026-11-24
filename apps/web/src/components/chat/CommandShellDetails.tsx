// FILE: CommandShellDetails.tsx
// Purpose: Render command tool details as the inline Shell result: the shared card, the command
//          and its output in the code type role, copy controls as shared icon buttons.
// Layer: Chat presentation component
// Exports: CommandShellDetails
// Depends on: normalized tool output, live activity, shared clipboard/localization primitives

import { Card } from "~/components/ui/card";
import { IconButton } from "~/components/ui/icon-button";
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

/** The code type role (13/19) in muted ink, for the command and its output. */
const SHELL_CODE_CLASS_NAME = "font-chat-code text-chat-code text-muted-foreground";
/** Hover- and focus-revealed copy control in the top-right corner of its block. */
const SHELL_COPY_CLASS_NAME =
  "absolute top-0 opacity-0 transition-opacity duration-200 group-hover/command:opacity-100 group-hover/output:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none";
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
  // The row and this card show what the shell ran; the full launcher line
  // (PowerShell or cmd and its options) stays one click away.
  const launcherLine = command
    .trim()
    .replace(/^\$\s+/u, "")
    .trim();
  const showsLauncher = launcherLine.length > 0 && launcherLine !== normalizedCommand;
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
      <div className="px-3 pt-1">
        <div className="group/command relative min-w-0 pe-7">
          <div
            id={commandId}
            role="button"
            tabIndex={0}
            aria-expanded={commandExpanded}
            aria-label={format("chat.shell.commandLine", { command: normalizedCommand })}
            className={cx(
              "cursor-interaction rounded-control bg-transparent whitespace-pre-wrap break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
              SHELL_CODE_CLASS_NAME,
              !commandExpanded && "line-clamp-2",
            )}
            data-shell-command="true"
            data-command-expanded={commandExpanded ? "true" : "false"}
            onClick={expandCommand}
            onKeyDown={onCommandKeyDown}
          >
            <span className="me-[1ch]">$</span>
            <code className="contents" data-translation-skip="true">
              <RenderedShellOutput
                segments={parseTerminalTextSegments(commandDisplay.slice(2))}
                fallbackText={commandDisplay.slice(2)}
              />
            </code>
          </div>
          {showsLauncher && commandExpanded ? (
            <p
              className={cx(
                "mt-1 whitespace-pre-wrap break-words select-text",
                SHELL_CODE_CLASS_NAME,
              )}
              data-shell-launcher="true"
              data-translation-skip="true"
            >
              {format("chat.shell.launcher", { command: launcherLine })}
            </p>
          ) : null}
          <IconButton
            className={cx(SHELL_COPY_CLASS_NAME, "right-0")}
            label={commandCopied ? t("chat.shell.copied") : t("chat.shell.copyCommand")}
            tooltip={commandCopied ? t("chat.shell.copied") : t("chat.shell.copyCommand")}
            data-shell-copy="command"
            data-shell-copy-state={commandCopied ? "copied" : "idle"}
            onClick={() => copyCommand(normalizedCommand)}
          >
            {commandCopied ? <CheckIcon /> : <CopyIcon />}
          </IconButton>
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
            "vertical-scroll-fade-mask scroll-fade-y box-border flex max-h-36 flex-col-reverse overflow-x-auto overflow-y-auto whitespace-pre [--edge-fade-distance:2rem] [--scroll-fade-size:2rem] [animation-direction:reverse]",
            SHELL_CODE_CLASS_NAME,
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
          <div className="w-max min-w-full px-3 py-2" data-translation-skip="true">
            <RenderedShellOutput
              segments={renderedOutputSegments}
              fallbackText={renderedOutputText}
            />
          </div>
        </div>
        <IconButton
          className={cx(SHELL_COPY_CLASS_NAME, "right-1")}
          label={outputCopied ? t("chat.shell.copied") : t("chat.shell.copyOutput")}
          tooltip={outputCopied ? t("chat.shell.copied") : t("chat.shell.copyOutput")}
          data-shell-copy="output"
          data-shell-copy-state={outputCopied ? "copied" : "idle"}
          onClick={() => copyOutput(copyPayloads.output)}
        >
          {outputCopied ? <CheckIcon /> : <CopyIcon />}
        </IconButton>
      </div>
      {isEmbedded ? <CommandShellFooter status={status} /> : null}
    </>
  );

  return (
    <Card
      className="group flex min-w-0 flex-col"
      data-command-shell="true"
      data-command-shell-variant={variant}
      data-command-shell-status={status.kind}
    >
      {isEmbedded ? (
        <div
          className="flex items-center px-3 pt-2 text-ui-sm text-muted-foreground select-none"
          data-shell-label="true"
        >
          <span>{t("chat.shell.label")}</span>
        </div>
      ) : (
        <div
          className="flex min-h-8 items-center justify-between gap-2 ps-3 pe-1 text-ui-sm text-muted-foreground"
          data-shell-header="true"
        >
          <span data-shell-label="true">{t("chat.shell.label")}</span>
          <span className="flex items-center gap-0.5">
            <IconButton
              label={contentsCopied ? t("chat.shell.copied") : t("chat.shell.copyContents")}
              tooltip={contentsCopied ? t("chat.shell.copied") : t("chat.shell.copyContents")}
              data-shell-copy="contents"
              data-shell-copy-state={contentsCopied ? "copied" : "idle"}
              onClick={() => copyContents(shellCopyPayload)}
            >
              {contentsCopied ? <CheckIcon /> : <CopyIcon />}
            </IconButton>
            <IconButton
              label={shellExpanded ? t("chat.shell.collapse") : t("chat.shell.expand")}
              tooltip={shellExpanded ? t("chat.shell.collapse") : t("chat.shell.expand")}
              data-shell-toggle="true"
              aria-expanded={shellExpanded}
              aria-controls={shellBodyId}
              onClick={() => setShellExpanded((current) => !current)}
            >
              {shellExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
            </IconButton>
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
    </Card>
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

  // Only `segment.decoration`, the last active decoration, is rendered. Blink has
  // no visual branch here, so the state is preserved without adding an animation.
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
    return <div className="pb-2" aria-hidden="true" data-shell-footer="running" />;
  }

  if (status.kind === "stopped") {
    return (
      <div
        className="flex items-center gap-2 px-3 pt-0.5 pb-2 text-ui-sm text-muted-foreground"
        data-shell-footer="stopped"
      >
        <span className="ms-auto">{t("chat.shell.stopped")}</span>
      </div>
    );
  }

  if (status.kind === "success") {
    return (
      <div
        className="flex items-center gap-2 px-3 pt-0.5 pb-2 text-ui-sm text-muted-foreground"
        data-shell-footer="success"
      >
        <span className="ms-auto flex items-center gap-1">
          <CheckIcon className="size-ui-icon-sm" />
          <span>{t("chat.shell.success")}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-2 px-3 pt-0.5 pb-2 text-ui-sm text-muted-foreground"
      data-shell-footer="exit-code"
    >
      <span className="ms-auto">
        {format("chat.shell.exitCode", { code: status.exitCode ?? t("chat.shell.unknown") })}
      </span>
    </div>
  );
}
