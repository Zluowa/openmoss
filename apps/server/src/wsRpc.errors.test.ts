import { describe, expect, it } from "vitest";
import { ServerProviderInstallError } from "@moss/contracts";
import { toWsRpcError } from "./wsRpc";
import { ProviderInstallationError } from "./provider/managedProviderInstallation";
import { ProjectImportError, toProjectImportError } from "./orchestration/projectImportHistory";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandTimeoutError,
} from "./orchestration/Errors";

describe("orchestration RPC rejection evidence", () => {
  it.each([
    new OrchestrationCommandInvariantError({
      commandType: "thread.turn.start",
      detail: "Task is unavailable",
    }),
    new OrchestrationCommandPreviouslyRejectedError({
      commandId: "compact",
      detail: "Task was unavailable",
    }),
  ])("reports a proven rejection for $name", (error) => {
    expect(toWsRpcError(error, "Dispatch failed")).toMatchObject({
      code: "ORCHESTRATION_COMMAND_REJECTED",
      retryable: false,
    });
  });
  it.each([
    new OrchestrationCommandTimeoutError({
      commandId: "compact",
      commandType: "thread.turn.start",
      timeoutMs: 1000,
    }),
  ])("does not turn ambiguous errors into rejection evidence: $name", (error) => {
    expect(toWsRpcError(error, "Dispatch failed").code).toBeUndefined();
  });
});

describe("agent installation refusals", () => {
  it("keep the code the settings dialog explains in plain words", () => {
    expect(
      toWsRpcError(
        new ProviderInstallationError(
          "PROVIDER_INSTALLATION_SESSIONS_RUNNING",
          "Finish this agent's running sessions before uninstalling it.",
        ),
        "Could not manage the agent installation",
      ),
    ).toMatchObject({ code: "PROVIDER_INSTALLATION_SESSIONS_RUNNING", retryable: false });
    expect(
      toWsRpcError(
        new ServerProviderInstallError({
          provider: "opencode",
          reason: "Turn this agent off before removing its Moss-managed installation.",
          code: "PROVIDER_INSTALLATION_AGENT_ENABLED",
        }),
        "Could not manage the agent installation",
      ),
    ).toMatchObject({ code: "PROVIDER_INSTALLATION_AGENT_ENABLED" });
    expect(
      toWsRpcError(
        new ServerProviderInstallError({ provider: "opencode", reason: "Unexpected failure." }),
        "Could not manage the agent installation",
      ).code,
    ).toBeUndefined();
  });
});

describe("project import failures", () => {
  it("reach the client in plain words with whether a retry can help", () => {
    const failure = toProjectImportError(
      Object.assign(new Error("EISDIR: illegal operation on a directory, stat 'E:'"), {
        code: "EISDIR",
      }),
    );
    expect(failure.message).toBe("Moss couldn't read this conversation's files.");
    expect(toWsRpcError(failure, "Failed to import project")).toMatchObject({
      message: "Moss couldn't read this conversation's files.",
      code: "PROJECT_IMPORT_FAILED",
      retryable: false,
    });
    expect(
      toWsRpcError(
        toProjectImportError(Object.assign(new Error("resource busy"), { code: "EBUSY" })),
        "Failed to import project",
      ),
    ).toMatchObject({ code: "PROJECT_IMPORT_FAILED", retryable: true });
    // Moss's own errors are already written for people and pass through unchanged.
    expect(
      toProjectImportError(new Error("The conversation file is no longer on this computer."))
        .message,
    ).toBe("The conversation file is no longer on this computer.");
    expect(
      toWsRpcError(
        new ProjectImportError({ message: "Refresh the project list before importing." }),
        "Failed to import project",
      ),
    ).toMatchObject({ retryable: false });
  });
});
