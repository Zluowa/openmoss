import { assert, describe, expect, it } from "vitest";

import { type PtyTerminal, waitForSuccessfulPtyExit } from "./node-pty-smoke.ts";

class FakePtyTerminal implements PtyTerminal {
  private dataListener: (chunk: string) => void = () => {};
  private exitListener: (event: { readonly exitCode: number }) => void = () => {};

  readonly kill = () => {};

  readonly onData = (listener: (chunk: string) => void) => {
    this.dataListener = listener;
    return { dispose: () => (this.dataListener = () => {}) };
  };

  readonly onExit = (listener: (event: { readonly exitCode: number }) => void) => {
    this.exitListener = listener;
    return { dispose: () => (this.exitListener = () => {}) };
  };

  emitData(chunk: string) {
    this.dataListener(chunk);
  }

  emitExit(exitCode: number) {
    this.exitListener({ exitCode });
  }
}

describe("waitForSuccessfulPtyExit", () => {
  it("writes once after a complete ready marker and still requires a successful response", async () => {
    const terminal = new FakePtyTerminal();
    let writes = 0;
    const result = waitForSuccessfulPtyExit({
      terminal,
      expectedOutput: "response",
      timeoutMs: 200,
      inputHandshake: {
        readyOutput: "input-ready",
        send: () => {
          writes++;
        },
      },
    });
    terminal.emitData("\u001b[?25hinput-");
    assert.equal(writes, 0);
    terminal.emitData("ready\r\ninput-ready\r\n");
    assert.equal(writes, 1);
    terminal.emitData("response");
    terminal.emitExit(1);
    await expect(result).rejects.toThrow(/exited with code 1/);
  });

  it("refuses an echoed or unrequested response even when the child exits cleanly", async () => {
    const terminal = new FakePtyTerminal();
    const result = waitForSuccessfulPtyExit({
      terminal,
      expectedOutput: "response",
      timeoutMs: 40,
      inputHandshake: {
        readyOutput: "input-ready",
        send: () => {
          throw new Error("unexpected input");
        },
      },
    });
    terminal.emitData("response");
    terminal.emitExit(0);
    await expect(result).rejects.toThrow(/input-ready handshake/);
  });

  it("accepts output delivered after the PTY exit event", async () => {
    const terminal = new FakePtyTerminal();
    const result = waitForSuccessfulPtyExit({
      terminal,
      expectedOutput: "moss-node-pty-smoke",
      timeoutMs: 1_000,
    });

    terminal.emitExit(0);
    terminal.emitData("moss-node-pty-smoke");

    assert.equal(await result, "moss-node-pty-smoke");
  });

  it("still accepts the usual output-before-exit ordering", async () => {
    const terminal = new FakePtyTerminal();
    const result = waitForSuccessfulPtyExit({
      terminal,
      expectedOutput: "moss-node-pty-smoke",
      timeoutMs: 1_000,
    });

    terminal.emitData("moss-node-pty-smoke");
    terminal.emitExit(0);

    assert.equal(await result, "moss-node-pty-smoke");
  });
});
