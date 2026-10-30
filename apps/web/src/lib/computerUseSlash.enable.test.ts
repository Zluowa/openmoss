import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadId, type NativeApi } from "@synara/contracts";

import { runComputerUseSlashCommand, type ComputerUseSlashToast } from "./computerUseSlashCommand";

type ComputerApi = {
  getStatus: () => Promise<{
    availability: { kind: string; backend?: string; platform?: string };
    capabilities: { input: boolean };
    health: { captureAvailable: boolean };
  }>;
  provision: () => Promise<{ summary: string }>;
  setControlEnabled: (input: { threadId: string; enabled: boolean }) => Promise<unknown>;
  getState: (input: Record<string, never>) => Promise<unknown>;
};

describe("computer-use enable path", () => {
  const threadId = ThreadId.makeUnsafe("thread-computer-use-1");
  const toastAdd = vi.fn<(toast: ComputerUseSlashToast) => void>();
  const computer = {
    getStatus: vi.fn<ComputerApi["getStatus"]>(),
    provision: vi.fn<ComputerApi["provision"]>(),
    setControlEnabled: vi.fn<ComputerApi["setControlEnabled"]>(),
    getState: vi.fn<ComputerApi["getState"]>(),
  };

  beforeEach(() => {
    toastAdd.mockReset();
    computer.getStatus.mockReset();
    computer.provision.mockReset();
    computer.setControlEnabled.mockReset();
    computer.getState.mockReset();
  });

  it("maps the bare menu selection to enable when Darwin is ready", async () => {
    computer.getStatus.mockResolvedValue({
      availability: { kind: "available", backend: "cua" },
      health: { captureAvailable: true },
      capabilities: { input: true },
    });
    computer.provision.mockResolvedValue({
      summary: "Moss Computer Use is ready on macOS.",
    });
    computer.setControlEnabled.mockResolvedValue({ enabled: true, generation: 1 });
    computer.getState.mockResolvedValue({ ok: true });

    await runComputerUseSlashCommand("", {
      threadId,
      computer: computer as unknown as NonNullable<NativeApi["computer"]>,
      toastAdd,
    });

    expect(computer.setControlEnabled).toHaveBeenCalledWith({ threadId, enabled: true });
    expect(computer.getState).toHaveBeenCalled();
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "Computer control enabled",
      }),
    );
    const description = String(toastAdd.mock.calls[0]?.[0]?.description ?? "");
    expect(description).not.toMatch(/Review Computer control in Settings/i);
  });

  it("surfaces permission guidance instead of enabling", async () => {
    computer.getStatus.mockResolvedValue({
      availability: { kind: "available", backend: "cua" },
      health: { captureAvailable: false },
      capabilities: { input: false },
    });
    computer.provision.mockResolvedValue({
      summary:
        "Moss Computer Use needs permission: Accessibility (System Settings → Privacy & Security → Accessibility → allow Moss).",
    });

    await runComputerUseSlashCommand("on", {
      threadId,
      computer: computer as unknown as NonNullable<NativeApi["computer"]>,
      toastAdd,
    });

    expect(computer.setControlEnabled).not.toHaveBeenCalled();
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Computer control needs permissions",
      }),
    );
  });
});
