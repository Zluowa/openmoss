import { useMutation } from "@tanstack/react-query";
import { serverMossCloudStartGoogleOAuthMutationOptions } from "./mossServerReactQuery";
import { useState } from "react";
import { SiGoogle } from "react-icons/si";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { ensureNativeApi } from "~/nativeApi";

import { beginMossGoogleOAuth } from "./mossGoogleOAuth.logic";
import {
  type MossGoogleOAuthPurpose,
  recordMossGoogleOAuthPurpose,
} from "./mossGoogleOAuthPurpose";

export function MossGoogleOAuthButton({
  purpose = "login",
}: {
  readonly purpose?: MossGoogleOAuthPurpose | undefined;
}) {
  const mutation = useMutation(serverMossCloudStartGoogleOAuthMutationOptions());
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    try {
      await beginMossGoogleOAuth({
        start: () => mutation.mutateAsync(),
        openExternal: (authorizationUrl) => ensureNativeApi().shell.openExternal(authorizationUrl),
        onFlowOpened: ({ flowId, expiresAt }) =>
          recordMossGoogleOAuthPurpose({ flowId, purpose, expiresAt }),
      });
    } catch {
      setError("无法安全打开 Google 登录，请稍后重试。");
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {error ? (
        <Alert aria-live="assertive" role="alert" variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button
        aria-label="使用 Google 继续"
        className="w-full gap-2"
        disabled={mutation.isPending}
        onClick={() => void start()}
        size="lg"
        type="button"
        variant="outline"
      >
        <SiGoogle aria-hidden="true" className="size-4" />
        {mutation.isPending ? "正在打开 Google…" : "使用 Google 继续"}
      </Button>
    </div>
  );
}
