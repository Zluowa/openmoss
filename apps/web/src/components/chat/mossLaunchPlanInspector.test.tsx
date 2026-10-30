import {
  MOSS_CONTROL_PLANE_VERSION,
  ThreadId,
  type MossLaunchPlan,
  type ProviderGetLaunchPlanResult,
} from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  deriveMossLaunchPlanInspectorModel,
  MossLaunchPlanInspector,
  summarizeObjectShape,
} from "./mossLaunchPlanInspector";

const threadId = ThreadId.makeUnsafe("thread-launch-plan-1");

const launchPlan: MossLaunchPlan = {
  version: MOSS_CONTROL_PLANE_VERSION,
  planId: "moss-plan-1",
  planHash: "sha256:launch-plan-hash",
  createdAt: "2026-07-01T00:00:00.000Z",
  provider: "codex",
  model: "gpt-5-codex",
  workspace: {
    cwd: "/Users/moss/Codex/tools/moss",
    projectId: "moss",
    threadId,
  },
  environment: {
    variables: [
      {
        key: "OPENAI_API_KEY",
        redacted: true,
        valueHash: "sha256:env-hash",
        source: "process.env",
      },
      {
        key: "MOSS_BACKEND_NODE_PATH",
        redacted: false,
        source: "launch-env",
      },
    ],
  },
  permissions: {
    runtimeMode: "full-access",
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
  },
  mcp: [{ name: "filesystem", source: ".moss/config.json", enabled: true }],
  skills: [{ name: "continuous-agent-loop", source: ".codex/skills", enabled: true }],
  memory: [{ name: "current-context", source: ".moss/context/current.md", enabled: true }],
  hooks: [{ name: "Stop", source: "/Users/moss/.codex/hooks.json", enabled: true }],
  tools: {
    allow: ["shell", "apply_patch"],
    deny: ["write-global-config"],
  },
  providerStartOptions: {
    codex: {
      apiKey: "sk-live-secret-value",
      model: "gpt-5-codex",
      nested: {
        token: "another-secret",
      },
    },
  },
  configSources: [
    {
      kind: "canonical",
      path: ".moss/config.json",
      required: true,
      hash: "sha256:config-hash",
    },
    {
      kind: "provider",
      path: "~/.codex/config.toml",
      required: false,
    },
  ],
  projectionWarnings: ["claude projection skipped unknown hook field"],
};

describe("mossLaunchPlanInspector", () => {
  it("renders the redacted launch plan control-plane fields", () => {
    const markup = renderToStaticMarkup(<MossLaunchPlanInspector launchPlan={launchPlan} />);

    expect(markup).toContain("data-moss-launch-plan-inspector");
    expect(markup).toContain("sha256:launch-plan-hash");
    expect(markup).toContain("codex");
    expect(markup).toContain("gpt-5-codex");
    expect(markup).toContain("/Users/moss/Codex/tools/moss");
    expect(markup).toContain("full-access");
    expect(markup).toContain("never");
    expect(markup).toContain("danger-full-access");
    expect(markup).toContain("OPENAI_API_KEY");
    expect(markup).toContain("redacted");
    expect(markup).toContain("sha256:env-hash");
    expect(markup).toContain("filesystem");
    expect(markup).toContain("continuous-agent-loop");
    expect(markup).toContain("current-context");
    expect(markup).toContain("Stop");
    expect(markup).toContain("shell, apply_patch");
    expect(markup).toContain("write-global-config");
    expect(markup).toContain("claude projection skipped unknown hook field");
    expect(markup).toContain("codex.apiKey");
    expect(markup).toContain("codex.nested.token");
    expect(markup).toContain('<span data-localization-skip="true">.moss/config.json</span>');
  });

  it("does not display raw environment values or unredacted provider option secrets", () => {
    const markup = renderToStaticMarkup(<MossLaunchPlanInspector launchPlan={launchPlan} />);

    expect(markup).not.toContain("sk-live-secret-value");
    expect(markup).not.toContain("another-secret");
    expect(markup).not.toContain("MOSS_BACKEND_NODE_PATH=");
  });

  it("renders a missing-plan state for the active thread", () => {
    const result: ProviderGetLaunchPlanResult = {
      threadId,
      planHash: null,
      launchPlan: null,
    };
    const markup = renderToStaticMarkup(<MossLaunchPlanInspector result={result} />);

    expect(markup).toContain("data-moss-launch-plan-missing");
    expect(markup).toContain("No launch plan for this session");
    expect(markup).toContain("thread-launch-plan-1");
  });

  it("derives a stable inspector model from rpc results", () => {
    const model = deriveMossLaunchPlanInspectorModel({
      result: {
        threadId,
        planHash: launchPlan.planHash,
        launchPlan,
      },
    });

    expect(model.status).toBe("ready");
    expect(model.planHash).toBe(launchPlan.planHash);
    expect(model.threadId).toBe(String(threadId));
    expect(model.environmentRows).toHaveLength(2);
    expect(model.environmentRows[0]?.valueParts).toEqual([
      { value: "redacted", localize: true },
      { value: "hash sha256:env-hash", localize: true },
      { value: "source process.env", localize: true },
    ]);
    expect(model.configSourceRows[0]?.valueParts).toEqual([
      { value: ".moss/config.json", localize: false },
      { value: "required", localize: true },
      { value: "hash sha256:config-hash", localize: true },
    ]);
    expect(model.providerStartOptionRows.map((row) => row.value)).toEqual([
      "codex.apiKey",
      "codex.model",
      "codex.nested.token",
    ]);
  });

  it("summarizes unknown object shapes by path only", () => {
    expect(
      summarizeObjectShape({
        root: {
          password: "secret",
          children: [{ token: "secret-token" }],
        },
      }),
    ).toEqual(["root.children[]", "root.children[].token", "root.password"]);
  });
});
