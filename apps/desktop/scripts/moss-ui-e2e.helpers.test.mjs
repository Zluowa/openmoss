import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { runInNewContext } from "node:vm";

const { selectComposerAccountSource } = await import("./moss-ui-e2e.helpers.mjs");

// Exercise connection ownership without attaching to a user's Electron app.
const helperSource = readFileSync(new URL("./moss-ui-e2e.helpers.mjs", import.meta.url), "utf8");
const connectStart = helperSource.indexOf("export async function connectToExistingAppPage(");
const connectEnd = helperSource.indexOf(
  "\nexport function readChatSubmissionSnapshot(",
  connectStart,
);
assert.ok(connectStart >= 0 && connectEnd > connectStart);

function connectionFixture({ isElectron = true, evaluateError, closeError } = {}) {
  let closeCount = 0;
  const page = {
    url: () => "moss://app/index.html",
    evaluate: async () => {
      if (evaluateError) throw evaluateError;
      return isElectron;
    },
    setDefaultTimeout: () => undefined,
    setDefaultNavigationTimeout: () => undefined,
  };
  const browser = {
    contexts: () => [{ pages: () => [page] }],
    close: async () => {
      closeCount += 1;
      if (closeError) throw closeError;
    },
  };
  const connect = runInNewContext(`(${helperSource.slice(connectStart + 7, connectEnd)})`, {
    importPlaywrightChromium: async () => ({ connectOverCDP: async () => browser }),
    appPageMatches: (url, expected) => url === expected,
    setTimeout,
  });
  return {
    browser,
    page,
    closeCount: () => closeCount,
    connect: (timeoutMs = 1_000) =>
      connect({ cdpUrl: "http://127.0.0.1:9229", appUrl: page.url(), timeoutMs }),
  };
}

test("a successful Electron attachment transfers connection ownership to its caller", async () => {
  const fixture = connectionFixture();
  const result = await fixture.connect();
  assert.equal(result.browser, fixture.browser);
  assert.equal(result.page, fixture.page);
  assert.equal(fixture.closeCount(), 0);
});

test("missing Electron pages and non-Electron targets release their CDP connection", async () => {
  const missing = connectionFixture();
  await assert.rejects(missing.connect(0), /matching Electron page unavailable/u);
  assert.equal(missing.closeCount(), 1);

  const wrongTarget = connectionFixture({ isElectron: false });
  await assert.rejects(wrongTarget.connect(), /CDP target is not Electron/u);
  assert.equal(wrongTarget.closeCount(), 1);
});

test("attachment failure releases CDP without masking the original error", async () => {
  const evaluateError = new Error("execution context destroyed");
  const fixture = connectionFixture({
    evaluateError,
    closeError: new Error("already disconnected"),
  });
  await assert.rejects(fixture.connect(), (cause) => cause === evaluateError);
  assert.equal(fixture.closeCount(), 1);
});

test("selectComposerAccountSource uses the model source panel, not the Agent menu", async () => {
  const events = [];
  const source = {
    count: async () => 1,
    isEnabled: async () => true,
    click: async () => events.push("source-click"),
  };
  const page = {
    keyboard: { press: async (key) => events.push(`key:${key}`) },
    waitForTimeout: async () => undefined,
    evaluate: async () => ({ instanceId: "claudeAgent", provider: "claudeAgent" }),
    waitForFunction: async (_fn, expected) => events.push(`selected:${expected}`),
    locator: (selector) => {
      if (selector.includes('control="combined"')) {
        return { count: async () => 0 };
      }
      if (selector.includes('control="model"')) {
        return {
          count: async () => 1,
          last: () => ({ click: async () => events.push("model-menu") }),
        };
      }
      if (selector.includes("menu-sub-trigger")) {
        return { filter: () => ({ first: () => ({ count: async () => 0 }) }) };
      }
      if (selector.includes("data-moss-model-source-panel")) {
        return {
          waitFor: async () => events.push("sources-panel"),
          getByRole: () => source,
        };
      }
      throw new Error(`unexpected locator: ${selector}`);
    },
    getByRole: (role) => {
      assert.equal(role, "button");
      return {
        waitFor: async () => events.push("change-source"),
        click: async () => events.push("change-source-click"),
      };
    },
  };

  await selectComposerAccountSource(page, {
    provider: "claudeAgent",
    instanceId: "claude_moss",
    sourceName: "Moss",
  });

  assert.ok(events.includes("model-menu"));
  assert.ok(events.includes("change-source-click"));
  assert.ok(events.includes("sources-panel"));
  assert.ok(events.includes("source-click"));
  assert.ok(events.includes("selected:claude_moss"));
  assert.equal(
    events.some((event) => event.includes("Agent")),
    false,
  );
});

test("selectComposerAccountSource fails closed when Moss is disabled", async () => {
  const source = {
    count: async () => 1,
    isEnabled: async () => false,
    click: async () => {
      throw new Error("disabled source must not be clicked");
    },
  };
  const page = {
    keyboard: { press: async () => undefined },
    waitForTimeout: async () => undefined,
    evaluate: async () => ({ instanceId: "claudeAgent", provider: "claudeAgent" }),
    locator: (selector) => {
      if (selector.includes('control="combined"')) return { count: async () => 0 };
      if (selector.includes('control="model"')) {
        return { count: async () => 1, last: () => ({ click: async () => undefined }) };
      }
      if (selector.includes("menu-sub-trigger"))
        return { filter: () => ({ first: () => ({ count: async () => 0 }) }) };
      if (selector.includes("data-moss-model-source-panel")) {
        return { waitFor: async () => undefined, getByRole: () => source };
      }
      throw new Error(`unexpected locator: ${selector}`);
    },
    getByRole: () => ({ waitFor: async () => undefined, click: async () => undefined }),
  };

  await assert.rejects(
    selectComposerAccountSource(page, {
      provider: "claudeAgent",
      instanceId: "claude_moss",
      sourceName: "Moss",
    }),
    /account source disabled: Moss/u,
  );
});
