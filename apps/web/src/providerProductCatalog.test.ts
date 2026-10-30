import { describe, expect, it } from "vitest";
import { SUPPORTED_PROVIDER_KINDS } from "@synara/contracts";

import {
  MOSS_ACTIVE_PROVIDER_KINDS,
  MOSS_DEFAULT_PROVIDER_KINDS,
  MOSS_OPTIONAL_PROVIDER_KINDS,
  MOSS_RETIRED_PROVIDER_KINDS,
  MOSS_UPCOMING_PROVIDERS,
  isMossActiveProvider,
} from "./providerProductCatalog";

describe("Moss provider product catalog", () => {
  it("launches with four default CLIs and keeps native-login CLIs opt-in", () => {
    expect(MOSS_DEFAULT_PROVIDER_KINDS).toEqual(["codex", "claudeAgent", "opencode", "grok"]);
    expect(MOSS_OPTIONAL_PROVIDER_KINDS).toEqual([
      "cursor",
      "gemini",
      "antigravity",
      "pi",
      "omp",
      "devin",
      "hermes",
      "kimi",
      "minimax",
      "zcode",
    ]);
    expect(MOSS_ACTIVE_PROVIDER_KINDS).toEqual([
      ...MOSS_DEFAULT_PROVIDER_KINDS,
      ...MOSS_OPTIONAL_PROVIDER_KINDS,
    ]);
  });

  it("removes retired providers from new provider surfaces", () => {
    expect(MOSS_RETIRED_PROVIDER_KINDS).toEqual(["droid", "kilo"]);
    expect(MOSS_ACTIVE_PROVIDER_KINDS).not.toContain("droid");
    expect(MOSS_ACTIVE_PROVIDER_KINDS).not.toContain("kilo");
    expect(isMossActiveProvider("codex")).toBe(true);
    expect(isMossActiveProvider("droid")).toBe(false);
  });

  it("offers every registered active CLI exactly once without enabling optional CLIs by default", () => {
    expect([...MOSS_ACTIVE_PROVIDER_KINDS].sort()).toEqual([...SUPPORTED_PROVIDER_KINDS].sort());
    expect(new Set(MOSS_ACTIVE_PROVIDER_KINDS).size).toBe(MOSS_ACTIVE_PROVIDER_KINDS.length);
    expect(MOSS_DEFAULT_PROVIDER_KINDS).not.toContain("antigravity");
    expect(MOSS_DEFAULT_PROVIDER_KINDS).not.toContain("omp");
    expect(isMossActiveProvider("antigravity")).toBe(true);
    expect(isMossActiveProvider("omp")).toBe(true);
    expect(isMossActiveProvider("customAcp")).toBe(false);
  });

  it("keeps the announced providers disabled as in-development entries", () => {
    expect(MOSS_UPCOMING_PROVIDERS).toEqual([
      { id: "deepseek-harness", title: "DeepSeek Harness", status: "in-development" },
    ]);
  });

  it("ships Kimi Code, MiniMax Code and ZCode as opt-in CLIs instead of announcements", () => {
    for (const provider of ["kimi", "minimax", "zcode"] as const) {
      expect(MOSS_OPTIONAL_PROVIDER_KINDS).toContain(provider);
      expect(MOSS_DEFAULT_PROVIDER_KINDS).not.toContain(provider);
      expect(isMossActiveProvider(provider)).toBe(true);
    }
    const upcomingIds = MOSS_UPCOMING_PROVIDERS.map((entry) => entry.id);
    expect(upcomingIds).not.toContain("kimi");
    expect(upcomingIds).not.toContain("chatglm");
    expect(upcomingIds).not.toContain("minimax");
  });
});
