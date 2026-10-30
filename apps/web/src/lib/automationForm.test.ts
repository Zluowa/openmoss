// FILE: automationForm.test.ts
// Purpose: Locks down the inline schedule-field validators — the structural cron check and
// the IANA timezone check that gate commit-on-blur edits on the automation detail page.
// Layer: Web lib test

import {
  AutomationCreateInput,
  SUPPORTED_PROVIDER_KINDS,
  type ModelSelection,
  ThreadId,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  automationCronExpressionError,
  automationTimezoneError,
  createInputFromForm,
  formFromAutomationDraft,
  providerOptionsForAutomationModelSelection,
} from "./automationForm";

describe("contextual automation drafts", () => {
  it("only prefills a paused editor, preserving the selected project's exact provider instance", () => {
    const modelSelection: ModelSelection = {
      provider: "gemini",
      instanceId: "gemini-work",
      model: "gemini-3-pro",
    };
    const projects = [
      {
        id: "first-project",
        defaultModelSelection: { provider: "codex", model: "gpt-5" } as const,
      },
      { id: "page-project", defaultModelSelection: modelSelection },
    ];
    const form = formFromAutomationDraft(projects, {
      projectId: "page-project",
      name: "Page updates",
      prompt: "Update the linked page after checking its current contents.",
      enabled: false,
      mode: "dedicated",
    });
    expect(form).toMatchObject({
      projectId: "page-project",
      modelSelection,
      enabled: false,
      mode: "dedicated",
      scheduleKind: "daily",
    });
    expect(projects[1]?.defaultModelSelection).toBe(modelSelection);
    expect(formFromAutomationDraft(projects).name).toBe("");
  });

  it.each(SUPPORTED_PROVIDER_KINDS)(
    "submits %s with its exact model and instance routing",
    (provider) => {
      const modelSelection = {
        provider,
        instanceId: `${provider}-workspace`,
        model: "configured-runtime-model",
      } as ModelSelection;
      const form = formFromAutomationDraft([{ id: "project-a" }], {
        name: "Check this project",
        prompt: "Check its current state.",
        modelSelection,
        enabled: false,
      });
      const sourceThreadId = ThreadId.makeUnsafe("context-thread");
      const input = createInputFromForm(form, undefined, undefined, sourceThreadId);
      const decoded = Schema.decodeUnknownSync(AutomationCreateInput)(input);
      expect(decoded.modelSelection).toEqual(modelSelection);
      expect(decoded.sourceThreadId).toBe(sourceThreadId);
      expect(decoded.enabled).toBe(false);
      expect(decoded.mode).toBe("standalone");
    },
  );

  it("refreshes start options when switching between instances of the same CLI", () => {
    const savedSelection: ModelSelection = {
      provider: "opencode",
      instanceId: "opencode-personal",
      model: "openai/gpt-5",
    };
    const savedOptions = { opencode: { binaryPath: "/personal/opencode" } };
    const nextOptions = { opencode: { binaryPath: "/work/opencode" } };
    expect(
      providerOptionsForAutomationModelSelection(
        { modelSelection: savedSelection, providerOptions: savedOptions },
        { ...savedSelection, instanceId: "opencode-work" },
        nextOptions,
      ),
    ).toEqual(nextOptions);
  });
});

describe("automationCronExpressionError", () => {
  it("accepts structurally valid 5-field expressions", () => {
    expect(automationCronExpressionError("* * * * *")).toBeNull();
    expect(automationCronExpressionError("*/15 9-17 * * 1-5")).toBeNull();
    expect(automationCronExpressionError("0 0 1,15 * *")).toBeNull();
    expect(automationCronExpressionError("  30 4 * * 0  ")).toBeNull();
  });

  it("rejects the wrong field count", () => {
    expect(automationCronExpressionError("")).not.toBeNull();
    expect(automationCronExpressionError("* * * *")).not.toBeNull();
    expect(automationCronExpressionError("* * * * * *")).not.toBeNull();
  });

  it("rejects fields with characters outside the cron vocabulary", () => {
    expect(automationCronExpressionError("every 5 min * *")).not.toBeNull();
    expect(automationCronExpressionError("0 0 * * MON")).not.toBeNull();
  });
});

describe("automationTimezoneError", () => {
  it("accepts real IANA zones", () => {
    expect(automationTimezoneError("Europe/Rome")).toBeNull();
    expect(automationTimezoneError("UTC")).toBeNull();
    expect(automationTimezoneError("  America/New_York  ")).toBeNull();
  });

  it("rejects an empty value — committing it would unrender the row for good", () => {
    expect(automationTimezoneError("")).toBe("Add a timezone");
    expect(automationTimezoneError("   ")).toBe("Add a timezone");
  });

  it("rejects unknown zones", () => {
    expect(automationTimezoneError("Europe/Atlantis")).toBe("Unknown timezone");
    expect(automationTimezoneError("not a zone")).toBe("Unknown timezone");
  });
});
