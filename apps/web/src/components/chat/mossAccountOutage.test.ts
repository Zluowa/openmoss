import { TurnId, type MossAccountSessionState } from "@moss/contracts";
import { MOSS_ACCOUNT_SERVICE_UNAVAILABLE_MESSAGE } from "@moss/shared/mossManagedSession";
import { describe, expect, it } from "vitest";

import { resolveWorkingLabel } from "../ChatView.logic";
import {
  isMossAccountServiceUnavailable,
  mossAccountOutageCheckDelayMs,
  nextMossAccountOutageStep,
  resolveAccountOutageThreadError,
} from "./mossAccountOutage";
import { resolveThreadErrorPresentation } from "./threadErrorPresentation";
import { workingStatusKey } from "./transcript/workingStatus";

const signedIn: MossAccountSessionState = {
  configured: true,
  authenticated: true,
  session: null,
  smsProvider: "aliyun",
  aliyunSmsConfigured: true,
};
// What Codex reported to the owner while MemFire answered 503.
const codexGatewayRejection =
  "unexpected status 401 Unauthorized: The Moss account session is invalid or expired., url: https://moss-cn-models.example.cn/v1/responses";
const failed = TurnId.makeUnsafe("turn-failed");

describe("a Moss lane while the account service is down", () => {
  it("knows the service is down only from a signed-in session that says so", () => {
    expect(isMossAccountServiceUnavailable({ ...signedIn, accountService: "unavailable" })).toBe(
      true,
    );
    expect(isMossAccountServiceUnavailable(signedIn)).toBe(false);
    expect(
      isMossAccountServiceUnavailable({
        ...signedIn,
        authenticated: false,
        accountService: "unavailable",
      }),
    ).toBe(false);
    expect(isMossAccountServiceUnavailable(undefined)).toBe(false);
  });

  it("says so plainly, in Chinese first, without the gateway's status line or address", () => {
    const text = resolveAccountOutageThreadError(codexGatewayRejection, true)!;
    const zh = resolveThreadErrorPresentation(text, "zh-CN");
    expect(zh.title).toBe("Moss 账号服务暂时不可用，恢复后会自动继续。");
    expect(zh.copyText).toBe(zh.title);
    expect(zh.retryable).toBeFalsy();
    expect(resolveThreadErrorPresentation(text, "en").title).toBe(
      MOSS_ACCOUNT_SERVICE_UNAVAILABLE_MESSAGE,
    );
    for (const presentation of [zh, resolveThreadErrorPresentation(text, "en")])
      expect(`${presentation.title} ${presentation.copyText}`).not.toMatch(/401|https?:|url/iu);
    // While the service works, the rejection keeps its own "send again" wording.
    expect(resolveAccountOutageThreadError(codexGatewayRejection, false)).toBe(
      codexGatewayRejection,
    );
    expect(resolveAccountOutageThreadError("Some other failure", true)).toBe("Some other failure");
  });

  it("shows the outage instead of a start that would spin as 'slower than usual'", () => {
    const label = resolveWorkingLabel({
      accountServiceUnavailable: true,
      isSendBusy: false,
      turnTakenOver: false,
      isConnecting: true,
      providerName: "Codex",
    });
    expect(label).toBe("Waiting for the Moss account service");
    expect(workingStatusKey(label, 600)).toBe("transcript.working.accountServiceUnavailable");
    expect(
      resolveWorkingLabel({
        isSendBusy: false,
        turnTakenOver: false,
        isConnecting: true,
        providerName: "Codex",
      }),
    ).toBe("Starting Codex…");
  });

  it("asks again often at first, then less often, never less than every five minutes", () => {
    expect(mossAccountOutageCheckDelayMs(0)).toBe(15_000);
    expect(mossAccountOutageCheckDelayMs(2 * 60_000)).toBe(30_000);
    expect(mossAccountOutageCheckDelayMs(10 * 60_000)).toBe(60_000);
    expect(mossAccountOutageCheckDelayMs(30 * 60_000)).toBe(120_000);
    expect(mossAccountOutageCheckDelayMs(24 * 3_600_000)).toBe(300_000);
  });

  it("continues the failed task once when the service is back, and nothing else", () => {
    let step = nextMossAccountOutageStep({
      unavailable: true,
      waitingTurnId: null,
      recoverableTurnId: failed,
    });
    expect(step).toEqual({ waitingTurnId: failed, resumeTurnId: null });
    step = nextMossAccountOutageStep({
      unavailable: true,
      waitingTurnId: step.waitingTurnId,
      recoverableTurnId: failed,
    });
    expect(step).toEqual({ waitingTurnId: failed, resumeTurnId: null });
    step = nextMossAccountOutageStep({
      unavailable: false,
      waitingTurnId: step.waitingTurnId,
      recoverableTurnId: failed,
    });
    expect(step).toEqual({ waitingTurnId: null, resumeTurnId: failed });
    // Already continued: nothing is sent twice.
    expect(
      nextMossAccountOutageStep({
        unavailable: false,
        waitingTurnId: step.waitingTurnId,
        recoverableTurnId: failed,
      }),
    ).toEqual({ waitingTurnId: null, resumeTurnId: null });
    // The person sent something else meanwhile: Moss does not continue the old task.
    expect(
      nextMossAccountOutageStep({
        unavailable: false,
        waitingTurnId: failed,
        recoverableTurnId: null,
      }),
    ).toEqual({ waitingTurnId: null, resumeTurnId: null });
    // A failure without an outage is the person's to retry.
    expect(
      nextMossAccountOutageStep({
        unavailable: false,
        waitingTurnId: null,
        recoverableTurnId: failed,
      }),
    ).toEqual({ waitingTurnId: null, resumeTurnId: null });
  });
});
