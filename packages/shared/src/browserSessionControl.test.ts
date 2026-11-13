import { describe, expect, it } from "vitest";

import { BrowserControlRefusedError, BrowserSessionControl } from "./browserSessionControl";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const reasonOf = async (work: Promise<unknown>) => {
  try {
    await work;
    return "resolved";
  } catch (error) {
    return error instanceof BrowserControlRefusedError ? error.reason : "other";
  }
};

describe("BrowserSessionControl", () => {
  it("lets the agent act until a person takes control, then refuses it at once", async () => {
    const control = new BrowserSessionControl();
    await expect(control.agent(async () => 1)).resolves.toBe(1);
    await control.take("viewer");
    expect(control.controller).toBe("viewer");
    expect(control.agentCanAct()).toBe(false);
    expect(await reasonOf(control.agent(async () => 2))).toBe("humanControl");
    await expect(control.human("viewer", async () => 3)).resolves.toBe(3);
    expect(await reasonOf(control.human("other", async () => 4))).toBe("notOwner");
  });

  it("refuses agent work queued before a takeover instead of running it after", async () => {
    const control = new BrowserSessionControl();
    const gate = deferred();
    const started = deferred();
    const running = control.agent(() => {
      started.resolve();
      return gate.promise.then(() => "first");
    });
    const queued = control.agent(async () => "second");
    await started.promise;
    const taking = control.take("viewer");
    gate.resolve();
    await expect(running).resolves.toBe("first");
    expect(await reasonOf(queued)).toBe("interrupted");
    await taking;
    expect(control.controller).toBe("viewer");
  });

  it("drains the person's navigations before control returns, then notifies the agent once", async () => {
    let now = 1_000;
    const control = new BrowserSessionControl({ now: () => now });
    await control.take("viewer");
    const navigation = deferred();
    control.trackUntilHandoff(navigation.promise);
    now = 2_000;
    let drained = false;
    const releasing = control.release("viewer", async () => {
      drained = true;
    });
    expect(control.controller).toBeNull();
    expect(drained).toBe(false);
    navigation.resolve();
    await releasing;
    expect(drained).toBe(true);
    expect(control.consumeHandoffNotice()).toEqual({ viewerId: "viewer", releasedAt: 2_000 });
    expect(control.consumeHandoffNotice()).toBeNull();
  });

  it("advances the generation on every owner change and reports it", async () => {
    let changes = 0;
    const control = new BrowserSessionControl({ onChange: () => (changes += 1) });
    const start = control.generation;
    await control.take("viewer");
    await control.release("viewer");
    expect(control.generation).toBe(start + 2);
    expect(changes).toBe(2);
  });

  it("refuses an agent action that had not started when control was taken", async () => {
    const control = new BrowserSessionControl();
    const notStarted = control.agent(async () => "late");
    await control.take("viewer");
    expect(await reasonOf(notStarted)).toBe("interrupted");
  });

  it("merges adjacent hover input with the same key", async () => {
    const control = new BrowserSessionControl();
    await control.take("viewer");
    const gate = deferred();
    const seen: number[] = [];
    const blocker = control.human("viewer", () => gate.promise);
    const a = control.humanLatest("viewer", "hover", 1, async (x) => {
      seen.push(x);
    });
    const b = control.humanLatest("viewer", "hover", 2, async (x) => {
      seen.push(x);
    });
    gate.resolve();
    await Promise.all([blocker, a, b]);
    expect(seen).toEqual([2]);
  });

  it("hands control back when the viewer disconnects, and refuses everything after close", async () => {
    const control = new BrowserSessionControl();
    await control.take("viewer");
    await control.disconnect("viewer");
    expect(control.controller).toBeNull();
    await control.close();
    expect(await reasonOf(control.agent(async () => 1))).toBe("closed");
    expect(await reasonOf(control.observe(async () => 1))).toBe("closed");
    await expect(control.take("viewer")).rejects.toBeInstanceOf(BrowserControlRefusedError);
  });

  it("refuses a second viewer while another holds control", async () => {
    const control = new BrowserSessionControl();
    await control.take("a");
    expect(await reasonOf(control.take("b"))).toBe("notOwner");
    expect(await reasonOf(control.release("b"))).toBe("notOwner");
  });
});
