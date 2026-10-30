import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { runInNewContext } from "node:vm";

// Isolate the real waiter without executing the production script's main().
const source = readFileSync(
  new URL("./moss-cn-managed-matrix-ui-e2e.mjs", import.meta.url),
  "utf8",
);
const start = source.indexOf("async function waitForReplyOrProviderFailure(");
const end = source.indexOf("\nfunction markerFor(", start);
assert.ok(start >= 0 && end > start, "matrix reply waiter must remain testable");
const waitForReplyOrProviderFailure = runInNewContext(`(${source.slice(start, end)})`, {
  UI: { providerFailure: /Provider unavailable/iu },
  REPLY_TIMEOUT_MS: 100,
});

function pageWithResult(result, { unpackError, disposeError } = {}) {
  const events = [];
  return {
    events,
    page: {
      waitForFunction: async () => ({
        jsonValue: async () => {
          events.push("unpack");
          if (unpackError) throw unpackError;
          return result;
        },
        dispose: async () => {
          events.push("dispose");
          if (disposeError) throw disposeError;
        },
      }),
      evaluate: async () => {
        events.push("diagnostic");
        return "Provider unavailable";
      },
    },
  };
}

test("a provider failure carried by a Playwright JSHandle rejects the matrix case", async () => {
  const { page, events } = pageWithResult("provider_failure");
  await assert.rejects(waitForReplyOrProviderFailure(page, "EXPECTED"), /provider failure:/u);
  assert.deepEqual(events, ["unpack", "dispose", "diagnostic"]);
});

test("a completed marker reply releases the handle and succeeds", async () => {
  const { page, events } = pageWithResult("ok");
  await waitForReplyOrProviderFailure(page, "EXPECTED");
  assert.deepEqual(events, ["unpack", "dispose"]);
});

test("an unreadable result rejects and still releases the handle", async () => {
  const unpackError = new Error("execution context destroyed");
  const { page, events } = pageWithResult(undefined, {
    unpackError,
    disposeError: new Error("handle already disposed"),
  });
  await assert.rejects(
    waitForReplyOrProviderFailure(page, "EXPECTED"),
    (cause) => cause === unpackError,
  );
  assert.deepEqual(events, ["unpack", "dispose"]);
});

test("a dispose failure never hides the provider failure", async () => {
  const { page, events } = pageWithResult("provider_failure", {
    disposeError: new Error("handle already disposed"),
  });
  await assert.rejects(waitForReplyOrProviderFailure(page, "EXPECTED"), /provider failure:/u);
  assert.deepEqual(events, ["unpack", "dispose", "diagnostic"]);
});

const mainStart = source.indexOf("async function main()");
const mainEnd = source.indexOf("\nmain().catch(", mainStart);
assert.ok(mainStart >= 0 && mainEnd > mainStart);
const stopStart = source.indexOf("async function stopFailedCase(");
const stopEnd = source.indexOf("\nasync function runCase(", stopStart);
assert.ok(stopStart >= 0 && stopEnd > stopStart);

function matrixFixture({
  setupError,
  caseError,
  reportError,
  closeError,
  runningAfterCaseFailure = false,
  pageClosed = false,
  stopError,
  stopWaitError,
  noVisibleStop = false,
  staysActiveAfterStop = false,
  statusWithoutActiveTurn,
} = {}) {
  const reports = [];
  const events = [];
  const logs = [];
  const trace = [];
  let running = false;
  let stopClicked = false;
  const composerElement = {
    getClientRects: () => [{}],
    getAttribute: (name) => {
      if (name === "data-moss-visible-thread-id") return "current-thread";
      if (name === "data-moss-visible-session-status")
        return running ? "running" : (statusWithoutActiveTurn ?? "ready");
      if (name === "data-moss-visible-active-turn-id") return running ? "active-turn" : "";
      throw new Error(`unexpected attribute: ${name}`);
    },
  };
  const stopFailedCase = runInNewContext(`(${source.slice(stopStart, stopEnd)})`, {
    document: {
      querySelectorAll: () => [
        {
          getClientRects: () => [],
          getAttribute: () => {
            throw new Error("hidden composer inspected");
          },
        },
        composerElement,
      ],
    },
  });
  const stopControl = {
    isVisible: async () => !noVisibleStop && !stopClicked && running,
    click: async (options) => {
      assert.equal(options.timeout, 5_000);
      trace.push("stop-click");
      if (stopError) throw stopError;
      stopClicked = true;
    },
  };
  const page = {
    isClosed: () => pageClosed,
    locator: (selector) => {
      assert.equal(pageClosed, false, "closed pages must not be inspected");
      assert.equal(selector, 'form[data-moss-visible-composer-shell="true"]:visible');
      return {
        last: () => ({
          evaluate: async (fn, _arg, options) => {
            assert.equal(options.timeout, 5_000);
            return fn(composerElement);
          },
          locator: (stopSelector) => {
            assert.equal(stopSelector, '[data-moss-visible-stop-control="true"]:visible');
            return { last: () => stopControl };
          },
        }),
      };
    },
    waitForFunction: async (predicate, arg, options) => {
      assert.equal(options.timeout, 10_000);
      trace.push("stop-wait");
      if (stopWaitError) throw stopWaitError;
      if (!staysActiveAfterStop) running = false;
      if (!predicate(arg)) throw new Error("Timed out waiting for idle session state");
      return { dispose: async () => undefined };
    },
  };
  const process = {};
  const main = runInNewContext(`(${source.slice(mainStart, mainEnd)})`, {
    loadMatrix: () => [
      { id: "first", modelId: "one" },
      { id: "second", modelId: "two" },
    ],
    log: (event, detail) => logs.push({ event, detail }),
    CASE_FILTER: "",
    SHARD_COUNT: 1,
    SHARD_INDEX: 0,
    CDP_URL: "http://127.0.0.1:9229",
    APP_URL: "moss://app/index.html",
    REPORT_PATH: "/tmp/unused-matrix-report.json",
    WORKER_TAG: "test",
    connectToExistingAppPage: async () => ({
      browser: {
        close: async () => {
          events.push("disconnect");
          if (closeError) throw closeError;
        },
      },
      page,
    }),
    dismissAppSnapWelcomeIfPresent: async () => {
      if (setupError) throw setupError;
    },
    waitForAgentCatalog: async () => undefined,
    runCase: async (_page, entry) => {
      assert.equal(running, false, "next case must not start while previous case is running");
      trace.push(`case:${entry.id}`);
      stopClicked = false;
      if (caseError) {
        running = runningAfterCaseFailure;
        throw caseError;
      }
      return { ok: true, label: entry.id };
    },
    stopFailedCase,
    closeOpenMenus: async () => undefined,
    dirname: () => "/tmp",
    mkdirSync: () => undefined,
    writeFileSync: (_path, contents) => {
      if (reportError) throw reportError;
      reports.push(JSON.parse(contents));
    },
    console: { log: () => undefined },
    process,
  });
  return { main, reports, events, logs, trace, process };
}

test("matrix reports success only after all cases pass and releases CDP on completion", async () => {
  const { main, reports, events, process } = matrixFixture();
  await main();
  assert.equal(reports[0].ok, false);
  assert.equal(reports[0].passed, 1);
  assert.equal(reports.at(-1).ok, true);
  assert.equal(reports.at(-1).passed, 2);
  assert.ok(reports.at(-1).finishedAt);
  assert.deepEqual(events, ["disconnect"]);
  assert.equal(process.exitCode, undefined);
});

test("matrix releases CDP when a case fails", async () => {
  const { main, reports, events, process } = matrixFixture({
    caseError: new Error("provider failed"),
  });
  await main();
  assert.equal(reports.at(-1).ok, false);
  assert.equal(reports.at(-1).failed, 2);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(events, ["disconnect"]);
});

test("matrix stops a failed running case before starting the next case", async () => {
  const { main, trace, reports } = matrixFixture({
    caseError: new Error("reply timeout"),
    runningAfterCaseFailure: true,
  });
  await main();
  assert.deepEqual(trace, [
    "case:first",
    "stop-click",
    "stop-wait",
    "case:second",
    "stop-click",
    "stop-wait",
  ]);
  assert.equal(reports.at(-1).failed, 2);
});

test("matrix preserves the case failure and aborts if stop or settlement fails", async () => {
  for (const cleanupKey of ["stopError", "stopWaitError"]) {
    const caseError = new Error("original reply timeout");
    const { main, trace, reports, logs, events } = matrixFixture({
      caseError,
      runningAfterCaseFailure: true,
      [cleanupKey]: new Error("stop failed"),
    });
    await assert.rejects(main(), (cause) => cause === caseError);
    assert.equal(trace.includes("case:second"), false);
    const report = reports.at(-1);
    assert.equal(report.failed, 1);
    assert.equal(report.ok, false);
    assert.match(report.results[0].message, /original reply timeout/u);
    assert.match(report.results[0].cleanupMessage, /stop failed/u);
    assert.equal(logs.at(-1).event, "case_stop_failed");
    assert.deepEqual(events, ["disconnect"]);
  }
});

test("matrix skips stop controls when the page has closed", async () => {
  const { main, trace } = matrixFixture({ caseError: new Error("page closed"), pageClosed: true });
  await main();
  assert.deepEqual(trace, ["case:first", "case:second"]);
});

test("a running case waiting for user input without Stop aborts the matrix", async () => {
  const caseError = new Error("AskUserQuestion reply timeout");
  const { main, trace, reports } = matrixFixture({
    caseError,
    runningAfterCaseFailure: true,
    noVisibleStop: true,
  });
  await assert.rejects(main(), (cause) => cause === caseError);
  assert.deepEqual(trace, ["case:first"]);
  assert.match(reports.at(-1).results[0].cleanupMessage, /still active without a visible stop/u);
});

test("a disappearing Stop button does not count as a settled turn", async () => {
  const caseError = new Error("reply timeout");
  const { main, trace, reports } = matrixFixture({
    caseError,
    runningAfterCaseFailure: true,
    staysActiveAfterStop: true,
  });
  await assert.rejects(main(), (cause) => cause === caseError);
  assert.deepEqual(trace, ["case:first", "stop-click", "stop-wait"]);
  assert.match(reports.at(-1).results[0].cleanupMessage, /idle session state/u);
});

test("a connecting session without an active turn still blocks advancing", async () => {
  const caseError = new Error("startup timeout");
  const { main, trace } = matrixFixture({ caseError, statusWithoutActiveTurn: "connecting" });
  await assert.rejects(main(), (cause) => cause === caseError);
  assert.deepEqual(trace, ["case:first"]);
});

test("a failure report write cannot mask a case whose stop also failed", async () => {
  const caseError = new Error("original reply timeout");
  const { main, trace, logs } = matrixFixture({
    caseError,
    runningAfterCaseFailure: true,
    stopError: new Error("stop failed"),
    reportError: new Error("report write failed"),
  });
  await assert.rejects(main(), (cause) => cause === caseError);
  assert.equal(trace.includes("case:second"), false);
  assert.equal(logs.at(-1).event, "case_report_failed");
});

test("matrix setup and report-write errors also release CDP", async () => {
  for (const errorKey of ["setupError", "reportError"]) {
    const error = new Error(errorKey);
    const { main, events } = matrixFixture({ [errorKey]: error });
    await assert.rejects(main(), (cause) => cause === error);
    assert.deepEqual(events, ["disconnect"]);
  }
});

test("matrix preserves its primary failure when CDP cleanup also fails", async () => {
  for (const errorKey of ["setupError", "reportError"]) {
    const error = new Error(errorKey);
    const { main, events, logs } = matrixFixture({
      [errorKey]: error,
      closeError: new Error("CDP disconnect failed"),
    });
    await assert.rejects(main(), (cause) => cause === error);
    assert.deepEqual(events, ["disconnect"]);
    assert.equal(logs.at(-1).event, "cdp_disconnect_failed");
    assert.match(logs.at(-1).detail.message, /CDP disconnect failed/u);
  }
});

test("a standalone CDP cleanup failure rejects matrix completion", async () => {
  const closeError = new Error("CDP disconnect failed");
  const { main, events } = matrixFixture({ closeError });
  await assert.rejects(main(), (cause) => cause === closeError);
  assert.deepEqual(events, ["disconnect"]);
});
