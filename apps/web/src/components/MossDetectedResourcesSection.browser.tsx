// CLI-native skills found on this computer are adopted into the canonical Moss
// source through the reversible resource-import plan.
import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossDetectedResourcesSection } from "./MossDetectedResourcesSection";

const api = vi.hoisted(() => ({
  resourceImportInventory: vi.fn(),
  resourceImportPlan: vi.fn(),
  resourceImportApply: vi.fn(),
}));
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  ensureNativeApi: () => ({ provider: api }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function renderWithQuery(children: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
}

it("adopts a skill found in several CLIs into the canonical source", async () => {
  const sha = "a".repeat(64);
  api.resourceImportInventory.mockResolvedValue({
    inventoryId: "inv",
    cwd: "/work",
    generatedAt: "2026-10-28T00:00:00.000Z",
    roots: [],
    issues: [],
    resources: ["codex", "grok"].map((provider, index) => ({
      id: `skill-${index}`,
      kind: "skill",
      provider,
      scope: "user",
      name: "dst-atlas",
      description: "Atlas of things",
      sourcePath: `/home/u/.${provider}/skills/dst-atlas/SKILL.md`,
      sourceSha256: sha,
      sizeBytes: 10,
      format: "markdown",
      secretFields: [],
      warnings: [],
    })),
  });
  const plan = { operations: [{ action: "copy" }] };
  api.resourceImportPlan.mockResolvedValue({ plan });
  api.resourceImportApply.mockResolvedValue({ status: "applied" });

  const screen = await renderWithQuery(<MossDetectedResourcesSection cwd="/work" search="" />);
  await expect.element(screen.getByText("On this computer")).toBeVisible();
  await expect.element(screen.getByText("Codex", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Grok", { exact: true })).toBeVisible();

  await screen.getByRole("button", { name: "Use dst-atlas in every agent" }).click();
  await expect
    .poll(() => api.resourceImportPlan.mock.calls[0]?.[0])
    .toEqual({
      cwd: "/work",
      resourceIds: ["skill-0"],
      kinds: ["skill"],
    });
  await expect
    .poll(() => api.resourceImportApply.mock.calls[0]?.[0])
    .toEqual({ cwd: "/work", plan });
});
