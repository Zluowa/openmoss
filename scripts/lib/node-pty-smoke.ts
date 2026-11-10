interface Disposable {
  readonly dispose: () => void;
}

interface PtyExitEvent {
  readonly exitCode: number;
}

export interface PtyTerminal {
  readonly kill: () => void;
  readonly onData: (listener: (chunk: string) => void) => Disposable;
  readonly onExit: (listener: (event: PtyExitEvent) => void) => Disposable;
}

interface PtySmokeOptions {
  readonly terminal: PtyTerminal;
  readonly expectedOutput: string;
  readonly timeoutMs: number;
  readonly inputHandshake?: { readonly readyOutput: string; readonly send: () => void };
}

export function waitForSuccessfulPtyExit({
  terminal,
  expectedOutput,
  timeoutMs,
  inputHandshake,
}: PtySmokeOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let exitCode: number | null = null;
    let settled = false;
    let inputSent = false;
    let dataSubscription: Disposable | null = null;
    let exitSubscription: Disposable | null = null;

    const cleanup = () => {
      clearTimeout(timeout);
      dataSubscription?.dispose();
      exitSubscription?.dispose();
    };

    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };

    const fail = (message: string) => {
      const detail = output.length > 0 ? `\n${output}` : "";
      settle(() => reject(new Error(`${message}${detail}`)));
    };

    const completeWhenReady = () => {
      if (exitCode === null) return;
      if (exitCode !== 0) {
        fail(`PTY process exited with code ${exitCode}.`);
        return;
      }
      if ((inputHandshake && !inputSent) || !output.includes(expectedOutput)) return;
      settle(() => resolve(output));
    };

    const timeout = setTimeout(() => {
      if (exitCode === null) {
        try {
          terminal.kill();
        } catch {
          // The timeout remains the actionable failure when cleanup cannot kill the PTY.
        }
        fail(
          inputHandshake && !inputSent
            ? "Timed out waiting for the Windows PTY input-ready marker."
            : "Timed out waiting for node-pty output.",
        );
        return;
      }
      fail(
        inputHandshake && !inputSent
          ? "The PTY child exited without completing its input-ready handshake."
          : `Expected PTY output "${expectedOutput}" was not observed.`,
      );
    }, timeoutMs);

    dataSubscription = terminal.onData((chunk) => {
      output += chunk;
      if (
        inputHandshake &&
        !inputSent &&
        exitCode === null &&
        output.includes(inputHandshake.readyOutput)
      ) {
        inputSent = true;
        try {
          inputHandshake.send();
        } catch (error) {
          fail(`Failed to write the Windows PTY probe: ${String(error)}`);
          return;
        }
      }
      completeWhenReady();
    });
    exitSubscription = terminal.onExit((event) => {
      exitCode = event.exitCode;
      completeWhenReady();
    });
  });
}
