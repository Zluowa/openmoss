import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { launchServerBrowser } from "./ServerBrowserRuntime.ts";
import { leaseServerBrowserTab } from "./serverBrowserCdpLease.ts";

const headlessShell = (() => {
  const explicit = process.env.MOSS_TEST_CHROMIUM?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  try {
    for (const entry of readdirSync(root).filter((name) =>
      /^chromium_headless_shell-\d+$/u.test(name),
    )) {
      const candidate = join(root, entry, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // No browsers directory.
  }
  return "";
})();

describe.skipIf(headlessShell === "")("leaseServerBrowserTab", () => {
  it("exposes exactly the leased tab and refuses to reach beyond it", async () => {
    const { browser, cdpUrl } = await launchServerBrowser(headlessShell);
    try {
      const context = await browser.newContext();
      const leased = await context.newPage();
      await leased.setContent("<title>Leased</title>");
      const sibling = await context.newPage();
      await sibling.setContent("<title>Sibling</title>");
      const session = await context.newCDPSession(leased);
      const { targetInfo } = (await session.send("Target.getTargetInfo")) as {
        targetInfo: { targetId: string };
      };
      await session.detach();

      const lease = await leaseServerBrowserTab({
        browserCdpUrl: cdpUrl,
        targetId: targetInfo.targetId,
      });
      const { chromium } = await import("playwright");
      const remote = await chromium.connectOverCDP(lease.url);
      try {
        const pages = remote.contexts().flatMap((candidate) => candidate.pages());
        expect(pages).toHaveLength(1);
        expect(await pages[0]!.title()).toBe("Leased");
        // No new tabs, and closing the remote never closes the real browser.
        await expect(remote.contexts()[0]!.newPage()).rejects.toThrow(/not permitted/u);
        const browserSession = await remote.newBrowserCDPSession();
        const targets = (await browserSession.send("Target.getTargets")) as {
          targetInfos: Array<{ targetId: string }>;
        };
        expect(targets.targetInfos.map((target) => target.targetId)).toEqual([targetInfo.targetId]);
        await expect(
          browserSession.send("Target.closeTarget", { targetId: targetInfo.targetId }),
        ).rejects.toThrow(/not permitted/u);
      } finally {
        await remote.close();
        await lease.close();
      }
      expect(lease.closed).toBe(true);
      expect(browser.isConnected()).toBe(true);
      expect(await leased.title()).toBe("Leased");
      expect(await sibling.title()).toBe("Sibling");
      // A revoked lease admits no new client.
      await expect(
        (await import("playwright")).chromium.connectOverCDP(lease.url, { timeout: 2_000 }),
      ).rejects.toThrow();
    } finally {
      await browser.close();
    }
  }, 30_000);
});
