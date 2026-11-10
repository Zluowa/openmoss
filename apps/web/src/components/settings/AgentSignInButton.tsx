// FILE: AgentSignInButton.tsx
// Purpose: The one 登录 button on an agent's Settings row: Moss runs the agent's own sign-in
//   in the background and the browser opens. While it waits the row says so, with a way to
//   cancel; once the credential lands the row reads 已连接.
// Layer: Settings UI components
// Depends on: the agent sign-in adapter, the shared sign-in copy.

import type { ProviderInstanceId, ProviderKind, ServerProviderStatus } from "@moss/contracts";

import { useAgentSignIn } from "~/lib/agentSignIn";
import { Loader2Icon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { Button } from "../ui/button";

export function AgentSignInButton(props: {
  provider: ProviderKind;
  instanceId?: ProviderInstanceId | undefined;
  /** The agent's name, as the copy names it. */
  providerLabel: string;
  /** The agent's provider status: the sign-in the server is running shows here. */
  status: Pick<ServerProviderStatus, "loginState"> | undefined;
}) {
  const { t, format } = useTranslation();
  const signIn = useAgentSignIn({
    provider: props.provider,
    instanceId: props.instanceId,
    status: props.status,
  });
  if (signIn.state === "signingIn" || signIn.state === "verifying") {
    return (
      <span className="inline-flex items-center gap-2" data-agent-sign-in="waiting">
        <span className="inline-flex items-center gap-1.5 text-ui-sm text-muted-foreground">
          <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
          <span role="status">
            {signIn.state === "verifying"
              ? t("provider.signIn.verifying")
              : t("provider.signIn.waiting")}
          </span>
        </span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-label={format("chat.modelSource.cancelSignInFor", { provider: props.providerLabel })}
          onClick={() => void signIn.cancel()}
        >
          {t("provider.signIn.cancel")}
        </Button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2" data-agent-sign-in={signIn.state}>
      {signIn.state === "failed" ? (
        <span className="text-ui-sm text-destructive" role="status">
          {t("provider.signIn.failed")}
        </span>
      ) : null}
      <Button
        type="button"
        size="xs"
        aria-label={format("chat.modelSource.signInFor", { provider: props.providerLabel })}
        onClick={() => void signIn.start()}
      >
        {signIn.state === "failed"
          ? t("provider.install.retry")
          : t("provider.readiness.signInAction")}
      </Button>
    </span>
  );
}
