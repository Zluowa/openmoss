// Observed: CHIP Sx/Cx + skill-exploration-labels. Running generic commands
// never repeat raw argv; settled commands show argv only while collapsed.
// Auto-review-declined and background-terminal branches follow CHIP Sx precedence.
import type { MossLocaleCode } from "../../appSettings";
import type { WorkLogLiveActivity } from "../../workLog";
import { isLiveActivityInProgress } from "../../lib/liveActivityPresentation";
import { literalCommandWords, skillScriptCommand } from "../../lib/commandPresentation";
import { normalizeShellCommand } from "./CommandShellDetails.logic";

export type CommandActivitySummaryOptions = {
  /** CHIP wasDeclinedByAutoReview — only when provider declined + denied review. */
  wasDeclinedByAutoReview?: boolean;
  /**
   * CHIP isBackgroundTerminalRunning / Finished. Only pass when derived from
   * typed processId + turn settlement; never invent from elapsed alone.
   */
  isBackgroundTerminalRunning?: boolean;
  isBackgroundTerminalFinished?: boolean;
  /**
   * When the command has no semantic classification (not declined, no
   * visualization/date/skill/background match), return null instead of the
   * generic "Running command/Ran command" fallback so callers can degrade to
   * the upstream heading+preview display.
   */
  suppressGenericFallback?: boolean;
};

function readsCurrentDateTime(command: string): boolean {
  const tokens = literalCommandWords(command);
  if (!tokens) return false;
  return (
    tokens[0]?.split("/").at(-1) === "date" &&
    tokens
      .slice(1)
      .every(
        (arg) =>
          arg.startsWith("+") ||
          ["-u", "--utc", "--universal", "-R", "--rfc-email", "-I"].includes(arg) ||
          arg.startsWith("-I=") ||
          arg.startsWith("--iso-8601") ||
          arg.startsWith("--rfc-3339"),
      )
  );
}

function visualizationKind(command: string): "create" | "update" | null {
  if (
    !/(?:^|[\\/])visualizations(?:[\\/"'\s;]|$)/i.test(command) ||
    !/(?:^|\s)(?:apply_patch|mkdir|tee|touch|cp|mv|install)(?:\s|$)|(?:^|[^<])>>?/.test(command)
  )
    return null;
  if (/\*\*\* Add File:[^\r\n]*[\\/]visualizations(?:[\\/"'\s;]|$)/i.test(command)) return "create";
  if (/\*\*\* Update File:[^\r\n]*[\\/]visualizations(?:[\\/"'\s;]|$)/i.test(command))
    return "update";
  return /\*\*\* Delete File:[^\r\n]*[\\/]visualizations(?:[\\/"'\s;]|$)/i.test(command)
    ? null
    : "create";
}

export function commandActivitySummary(
  command: string,
  activity: WorkLogLiveActivity | undefined,
  elapsed: string | null,
  locale: MossLocaleCode,
  expanded: boolean,
  options: CommandActivitySummaryOptions = {},
): string | null {
  const zh = locale === "zh-CN";
  const normalized = normalizeShellCommand(command);
  // CHIP Sx: wasDeclinedByAutoReview wins before date/visualization/generic.
  if (options.wasDeclinedByAutoReview) {
    const raw = !expanded && normalized ? normalized : "";
    if (raw) {
      return zh ? `命令已被自动审核拒绝：${raw}` : `Command declined by auto-review: ${raw}`;
    }
    return zh ? "命令已被自动审核拒绝" : "Command declined by auto-review";
  }

  const running = activity ? isLiveActivityInProgress(activity) : false;
  const stopped = activity?.state === "cancelled";

  const kind = !stopped && activity?.state !== "failed" ? visualizationKind(normalized) : null;
  if (kind) {
    return zh
      ? `${kind === "create" ? (running ? "正在创建" : "已创建") : running ? "正在更新" : "已更新"}可视化`
      : `${kind === "create" ? (running ? "Creating" : "Created") : running ? "Updating" : "Updated"} visualization`;
  }
  const date = readsCurrentDateTime(normalized);
  const skill =
    !expanded || options.isBackgroundTerminalRunning || options.isBackgroundTerminalFinished
      ? skillScriptCommand(normalized)
      : null;
  const skillTarget = skill
    ? zh
      ? `${skill.skillName} 技能中的 ${skill.fileName}`
      : `${skill.fileName} from ${skill.skillName} skill`
    : null;
  const scriptTarget = skillTarget ? (zh ? skillTarget : `script ${skillTarget}`) : null;
  // Sx gives visualization and date classifications priority over background.
  if (!date) {
    // Only when caller proved turn settlement + process flags.
    if (running && options.isBackgroundTerminalRunning) {
      if (skillTarget) {
        return zh
          ? `已在后台终端启动 ${skillTarget}`
          : `Started background terminal running ${skillTarget}`;
      }
      if (normalized) {
        return zh
          ? `已在后台终端启动 ${normalized}`
          : `Started background terminal with ${normalized}`;
      }
      return zh ? "已启动后台终端" : "Started background terminal";
    }
    if (options.isBackgroundTerminalFinished) {
      if (stopped && scriptTarget) {
        return zh
          ? `后台终端已停止：${scriptTarget}`
          : `Background terminal stopped with ${scriptTarget}`;
      }
      if (skillTarget) {
        return zh
          ? `后台终端已完成运行 ${skillTarget}`
          : `Background terminal finished running ${skillTarget}`;
      }
      if (stopped && normalized) {
        return zh
          ? `后台终端已停止：${normalized}`
          : `Background terminal stopped with ${normalized}`;
      }
      if (stopped) return zh ? "后台终端已停止" : "Background terminal stopped";
      if (normalized) return zh ? `已运行 ${normalized}` : `Ran ${normalized}`;
      return zh ? "后台终端已完成" : "Background terminal finished";
    }
  }
  // 仅在目标退化为泛化“命令/command”措辞（运行中/展开/无命令文本）时抑制，
  // 让调用方回退上游 heading+preview；已结案的语义摘要（"Ran pwd"）保留。
  if (!date && options.suppressGenericFallback && (running || expanded || !normalized)) {
    return null;
  }
  const target = date
    ? zh
      ? "当前日期和时间"
      : "the current date and time"
    : running || expanded || !normalized
      ? zh
        ? "命令"
        : "command"
      : (scriptTarget ?? normalized);
  const verb = date
    ? zh
      ? running
        ? "正在检查"
        : stopped
          ? "已停止检查"
          : "已检查"
      : running
        ? "Checking"
        : stopped
          ? "Stopped checking"
          : "Checked"
    : zh
      ? running
        ? "正在运行"
        : stopped
          ? "已停止"
          : "已运行"
      : running
        ? "Running"
        : stopped
          ? "Stopped"
          : "Ran";
  const suffix =
    elapsed && elapsed !== "0s"
      ? zh
        ? `（${running || stopped ? "耗时" : "用时"} ${elapsed}）`
        : ` ${running ? "for" : stopped ? "after" : "in"} ${elapsed}`
      : "";
  return `${verb}${zh ? "" : " "}${target}${suffix}`;
}
