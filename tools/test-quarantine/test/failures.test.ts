import { describe, expect, it } from "vitest";

import { classifyFailure, parseVitestFailures, renderFailureSummary } from "../failures.ts";
import type { QuarantineEntry } from "../quarantine.ts";

const entry = (id: string, platform: QuarantineEntry["platform"]): QuarantineEntry => ({
  id,
  platform,
  reason: "r",
  owner: "server",
  added: "2026-11-11",
  expires: "2026-11-25",
  evidence: "e",
});

const transcript = [
  "@moss/cli:test: \u001b[31m FAIL \u001b[39m src/git/GitManager.test.ts > GitManager > rejects push/pr actions from detached HEAD",
  "@moss/cli:test:  FAIL  src/http.test.ts > production Effect HTTP routes > does not serve unsafe project logo content: file symlink",
  "@moss/cli:test:  FAIL  src/broken.test.ts [ src/broken.test.ts ]",
  "@moss/cli:test:  FAIL  src/git/GitManager.test.ts > GitManager > rejects push/pr actions from detached HEAD",
  " FAIL  |components (chromium)| src/components/chat/MessagesTimeline.browser.tsx > timeline > keeps the anchor",
  "[41m[1m FAIL [22m[49m [30m[46m components (chromium) [49m[39m src/components/ThemeCssHooks.browser.tsx[2m > [22mtheme hooks[2m > [22mshows (light, desktop)",
  "^[[41m^[[1m FAIL ^[[22m^[[49m ^[[30m^[[46m chat (chromium) ^[[49m^[[39m src/components/ChatView.browser.tsx^[[2m > ^[[22mshows the plan",
  "  ✓ src/ok.test.ts (3 tests) 12ms",
].join("\n");

describe("parseVitestFailures", () => {
  it("reads turbo-prefixed and browser-project FAIL lines once each, with repository paths", () => {
    expect(parseVitestFailures(transcript, "apps/web")).toEqual([
      {
        file: "apps/server/src/git/GitManager.test.ts",
        name: "GitManager > rejects push/pr actions from detached HEAD",
      },
      {
        file: "apps/server/src/http.test.ts",
        name: "production Effect HTTP routes > does not serve unsafe project logo content: file symlink",
      },
      { file: "apps/server/src/broken.test.ts" },
      {
        file: "apps/web/src/components/chat/MessagesTimeline.browser.tsx",
        name: "timeline > keeps the anchor",
      },
      {
        file: "apps/web/src/components/ThemeCssHooks.browser.tsx",
        name: "theme hooks > shows (light, desktop)",
      },
      { file: "apps/web/src/components/ChatView.browser.tsx", name: "shows the plan" },
    ]);
  });
});

describe("classifyFailure", () => {
  const entries = [
    entry(
      "server:apps/server/src/http.test.ts > production Effect HTTP routes > does not serve unsafe project logo content: $kind symlink",
      "win32",
    ),
    entry("server:apps/server/src/git/GitManager.test.ts", "all"),
  ];
  it("tells a quarantined failure from one quarantined elsewhere and a new one", () => {
    const [git, http, broken] = parseVitestFailures(transcript);
    expect(classifyFailure(git!, entries, "linux").kind).toBe("quarantined");
    expect(classifyFailure(http!, entries, "win32").kind).toBe("quarantined");
    expect(classifyFailure(http!, entries, "linux").kind).toBe("other-platform");
    expect(classifyFailure(broken!, entries, "linux").kind).toBe("not-quarantined");
  });

  it("renders a table that counts the failures nobody has quarantined", () => {
    const summary = renderFailureSummary(
      parseVitestFailures(transcript, "apps/web"),
      entries,
      "linux",
    );
    expect(summary).toContain("### Failed tests (6; 5 not quarantined on linux)");
    expect(summary).toContain("quarantined on win32 only: a real failure here");
    expect(summary).toContain(
      "| `apps/server/src/broken.test.ts` | (whole file) | not quarantined: a real failure |",
    );
    expect(renderFailureSummary([], entries, "linux")).toMatch(/No failing test names/);
  });
});
