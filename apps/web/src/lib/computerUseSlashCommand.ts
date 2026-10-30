import type { NativeApi, ThreadId } from "@synara/contracts";

import {
  looksLikeComputerPermissionsBlocked,
  parseComputerUseSlashAction,
  summarizeComputerControlToast,
} from "../composerSlashCommands";

type ComputerApi = Pick<
  NonNullable<NativeApi["computer"]>,
  "getStatus" | "provision" | "setControlEnabled" | "getState"
>;

export type ComputerUseSlashToast = {
  readonly type: "info" | "success" | "warning";
  readonly title: string;
  readonly description?: string;
};

export async function runComputerUseSlashCommand(
  args: string,
  input: {
    readonly threadId: ThreadId;
    readonly computer: ComputerApi | undefined;
    readonly toastAdd: (toast: ComputerUseSlashToast) => void;
  },
): Promise<void> {
  const { computer, threadId, toastAdd } = input;
  if (!computer) {
    toastAdd({
      type: "warning",
      title: "Computer Use is unavailable",
      description: "Open Moss on a supported desktop to use Computer Use.",
    });
    return;
  }

  const action = parseComputerUseSlashAction(args);
  if (action === "invalid") {
    toastAdd({
      type: "warning",
      title: "Invalid /computer-use command",
      description:
        "Use /computer-use, /computer-use on, /computer-use off, or /computer-use status.",
    });
    return;
  }

  try {
    const status = await computer.getStatus({});
    if (status.availability.kind === "unsupported-platform") {
      toastAdd({
        type: "info",
        title: "Computer Use is coming soon on Linux",
        description: "Moss Computer Use currently supports macOS only.",
      });
      return;
    }

    const provision = await computer.provision({});
    const provisionSummary = provision.summary?.trim() ?? "";
    if (action !== "off" && looksLikeComputerPermissionsBlocked(provisionSummary)) {
      toastAdd({
        type: "warning",
        title: "Computer control needs permissions",
        description:
          provisionSummary ||
          "Grant Accessibility and Screen Recording to Moss in System Settings, then retry.",
      });
      return;
    }

    const availabilityKind = status.availability.kind;
    const backend =
      status.availability.kind === "available" ? status.availability.backend : undefined;
    const inputCapable = status.capabilities.input === true;
    const captureCapable = status.health.captureAvailable === true;

    if (action === "status") {
      toastAdd({
        type: "info",
        title: "Computer control status",
        description: summarizeComputerControlToast({
          enabled: false,
          availabilityKind,
          backend,
          inputCapable,
          captureCapable,
          provisionSummary,
        }),
      });
      return;
    }

    const enabled = action === "on";
    await computer.setControlEnabled({ threadId, enabled });
    try {
      await computer.getState({});
    } catch {
      // Status toast still useful if getState is unavailable.
    }
    toastAdd({
      type: "success",
      title: enabled ? "Computer control enabled" : "Computer control disabled",
      description: summarizeComputerControlToast({
        enabled,
        availabilityKind,
        backend,
        inputCapable,
        captureCapable,
        provisionSummary,
      }),
    });
  } catch (error) {
    toastAdd({
      type: "warning",
      title: "Computer Use is unavailable",
      description:
        error instanceof Error ? error.message : "Moss could not update desktop control status.",
    });
  }
}
