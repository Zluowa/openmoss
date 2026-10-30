import { describe, expect, it } from "vitest";

import {
  aggregateMultiAgentActionStatus,
  countMultiAgentActionAgents,
  normalizeMultiAgentAction,
  normalizeMultiAgentActionStatus,
} from "../../lib/multiAgentAction";
import { formatMossTranslation, translateMoss } from "~/localization";
import {
  multiAgentCountLabelKey,
  multiAgentHeaderVerbKey,
  multiAgentRowVerbKey,
  multiAgentSendPromptVerbKey,
} from "./MultiAgentActionDisclosure.logic";

describe("multi-agent action disclosure copy", () => {
  it.each([
    ["spawnAgent", "Creating", "Created", "Failed to create"],
    ["sendInput", "Messaging", "Messaged", "Failed to message"],
    ["sendMessage", "Messaging", "Messaged", "Failed to message"],
    ["followupTask", "Messaging", "Messaged", "Failed to message"],
    ["resumeAgent", "Resuming", "Resumed", "Failed to resume"],
    ["closeAgent", "Closing", "Closed", "Failed to close"],
    ["interruptAgent", "Interrupting", "Interrupted", "Failed to interrupt"],
    ["listAgents", "Listing", "Listed", "Failed to list"],
  ] as const)("matches every header state for %s", (action, running, completed, failed) => {
    expect(translateMoss("en", multiAgentHeaderVerbKey(action, "inProgress"))).toBe(running);
    expect(translateMoss("en", multiAgentHeaderVerbKey(action, "completed"))).toBe(completed);
    expect(translateMoss("en", multiAgentHeaderVerbKey(action, "failed"))).toBe(failed);
    expect(translateMoss("en", multiAgentHeaderVerbKey(action, "interrupted"))).toBe("Interrupted");
  });

  it.each([
    ["spawn_agent", "spawnAgent"],
    ["sendInput", "sendInput"],
    ["send_message", "sendMessage"],
    ["followup-task", "followupTask"],
    ["resume_agent", "resumeAgent"],
    ["closeAgent", "closeAgent"],
    ["interrupt_agent", "interruptAgent"],
    ["list_agents", "listAgents"],
    ["wait_agent", "waitAgent"],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizeMultiAgentAction(input)).toBe(expected);
  });

  it.each([
    ["in_progress", "inProgress"],
    ["running", "inProgress"],
    ["succeeded", "completed"],
    ["error", "failed"],
    ["cancelled", "interrupted"],
  ] as const)("normalizes status %s to %s", (input, expected) => {
    expect(normalizeMultiAgentActionStatus(input)).toBe(expected);
  });

  it("uses the exact header and differing failed row verbs", () => {
    expect(translateMoss("en", multiAgentHeaderVerbKey("spawnAgent", "failed"))).toBe(
      "Failed to create",
    );
    expect(translateMoss("en", multiAgentRowVerbKey("spawnAgent", "failed"))).toBe(
      "Failed creating",
    );
    expect(translateMoss("en", multiAgentHeaderVerbKey("sendMessage", "failed"))).toBe(
      "Failed to message",
    );
    expect(translateMoss("en", multiAgentRowVerbKey("sendMessage", "failed"))).toBe(
      "Failed messaging",
    );
    expect(translateMoss("en", multiAgentSendPromptVerbKey("failed"))).toBe("Failed to message");
    expect(translateMoss("en", multiAgentHeaderVerbKey("resumeAgent", "completed"))).toBe(
      "Resumed",
    );
    expect(translateMoss("en", multiAgentHeaderVerbKey("closeAgent", "inProgress"))).toBe(
      "Closing",
    );
  });

  it("applies in-progress, failed, interrupted, completed aggregate priority", () => {
    expect(aggregateMultiAgentActionStatus(["completed", "interrupted", "failed", "running"])).toBe(
      "inProgress",
    );
    expect(aggregateMultiAgentActionStatus(["completed", "interrupted", "failed"])).toBe("failed");
    expect(aggregateMultiAgentActionStatus(["completed", "interrupted"])).toBe("interrupted");
    expect(aggregateMultiAgentActionStatus(["completed", "succeeded"])).toBe("completed");
  });

  it("counts unique agents and falls back to item count before formatting the suffix", () => {
    expect(
      countMultiAgentActionAgents([
        { subagents: [{ threadId: "one" }, { threadId: "one" }] },
        { subagents: [{ threadId: "local", providerThreadId: "two" }] },
      ]),
    ).toBe(2);
    expect(countMultiAgentActionAgents([{}, {}, {}])).toBe(3);
    expect(translateMoss("en", multiAgentCountLabelKey(1))).toBe(" an agent");
    expect(translateMoss("en", multiAgentCountLabelKey(2))).toBe(" {count} agents");
    expect(formatMossTranslation("en", multiAgentCountLabelKey(3), { count: 3 })).toBe(" 3 agents");
    expect(countMultiAgentActionAgents([])).toBe(0);
  });
});
