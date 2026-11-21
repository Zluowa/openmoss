import { ProviderInstanceId } from "@moss/contracts";
import { mossLaneEngineDefaultModel } from "@moss/shared/mossRealmCatalog";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useRef, useState } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

import { MossAuthLoading, MossAuthShell } from "./MossAuthShell";
import { activateMossChatSelection } from "./activateMossChatSelection";
import { mossAccessLaneSummary } from "./mossAccessLanes.logic";
import {
  mossEnterpriseKeyErrorMessage,
  mossEnterpriseKeyStatusNotice,
  validateMossEnterpriseKeyInput,
} from "./mossEnterpriseKey.logic";
import { MOSS_POST_AUTH_CHAT_SEARCH } from "./mossPostAuthLanding";
import {
  serverMossEnterpriseKeyActivateMutationOptions,
  serverMossEnterpriseKeySignInMutationOptions,
  serverMossEnterpriseKeySignOutMutationOptions,
  serverMossEnterpriseKeyStateQueryOptions,
} from "./mossServerReactQuery";

const ENTERPRISE_CODEX_MODEL = mossLaneEngineDefaultModel("enterprise", "codex");
if (!ENTERPRISE_CODEX_MODEL) {
  throw new Error("The enterprise lane needs a default Codex model.");
}

const linkClassName =
  "rounded-inline font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60";

function selectEnterpriseChat(queryClient: QueryClient) {
  activateMossChatSelection(queryClient, {
    provider: "codex",
    instanceId: ProviderInstanceId.makeUnsafe("codex_moss"),
    model: ENTERPRISE_CODEX_MODEL!,
  });
}

function EnterpriseKeyForm({
  pending,
  serverError,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly serverError: string | null;
  readonly onSubmit: (apiKey: string) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const error = validateMossEnterpriseKeyInput(apiKey);
    setFieldError(error);
    if (error) {
      keyRef.current?.focus();
      return;
    }
    void onSubmit(apiKey.trim())
      .then(() => setApiKey(""))
      // React Query owns the visible mutation error.
      .catch(() => undefined);
  };

  return (
    <form
      aria-busy={pending}
      className="flex min-w-0 flex-col gap-5"
      noValidate
      onSubmit={handleSubmit}
    >
      {serverError ? (
        <Alert aria-live="assertive" role="alert" variant="error">
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="moss-enterprise-api-key">企业 API Key</Label>
        <Input
          ref={keyRef}
          aria-describedby={fieldError ? "moss-enterprise-api-key-error" : undefined}
          aria-invalid={Boolean(fieldError)}
          autoComplete="off"
          autoFocus
          id="moss-enterprise-api-key"
          name="apiKey"
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="moss_sk_…"
          spellCheck={false}
          type="password"
          value={apiKey}
        />
        {fieldError ? (
          <p className="text-ui-sm leading-5 text-destructive" id="moss-enterprise-api-key-error">
            {fieldError}
          </p>
        ) : null}
      </div>
      <Button className="w-full" disabled={pending} size="lg" type="submit">
        {pending ? "正在验证…" : "登录"}
      </Button>
      <p className="text-center text-ui-sm leading-5 text-muted-foreground">
        Key 由企业管理员在 Moss 签发，用量按企业合同单独结算
      </p>
    </form>
  );
}

export function MossEnterpriseKeyPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const stateQuery = useQuery(serverMossEnterpriseKeyStateQueryOptions());
  const signIn = useMutation(serverMossEnterpriseKeySignInMutationOptions({ queryClient }));
  const activate = useMutation(serverMossEnterpriseKeyActivateMutationOptions({ queryClient }));
  const signOut = useMutation(serverMossEnterpriseKeySignOutMutationOptions({ queryClient }));
  const pending = signIn.isPending || activate.isPending || signOut.isPending;
  const mutationError = signIn.error ?? activate.error ?? signOut.error;
  const enterChat = async () => {
    selectEnterpriseChat(queryClient);
    await navigate({ to: "/", search: MOSS_POST_AUTH_CHAT_SEARCH, replace: true });
  };
  const state = stateQuery.data;
  const statusNotice = mossEnterpriseKeyStatusNotice(state?.modelGatewayStatus);

  return (
    <MossAuthShell
      title="使用企业 API Key 登录"
      description={`${mossAccessLaneSummary("enterprise")}，无需海外网络`}
      footer={
        <span>
          <Link className={linkClassName} to="/login">
            使用其他方式登录
          </Link>
        </span>
      }
    >
      {stateQuery.isPending ? (
        <MossAuthLoading label="正在检查企业 API Key…" />
      ) : stateQuery.isError ? (
        <Alert variant="error">
          <AlertDescription>无法连接 Moss，请重启后重试。</AlertDescription>
        </Alert>
      ) : state?.configured === false ? (
        <Alert variant="error">
          <AlertDescription>这个版本的 Moss 没有配置企业模型服务，请更新 Moss。</AlertDescription>
        </Alert>
      ) : (
        <div className="flex min-w-0 flex-col gap-6">
          {state?.authenticated ? (
            <section className="flex min-w-0 flex-col gap-3 rounded-card border border-border/70 p-4">
              <p className="text-ui-lg text-muted-foreground" role="status">
                本机已保存 <span className="font-mono text-foreground">{state.keyPrefix}…</span>
                {state.active ? "，正在使用。" : "。"}
              </p>
              {statusNotice ? (
                <Alert role="alert" variant="error">
                  <AlertDescription>{statusNotice}</AlertDescription>
                </Alert>
              ) : null}
              <div className="flex min-w-0 flex-wrap gap-2">
                <Button
                  disabled={pending}
                  onClick={() =>
                    void (state.active ? Promise.resolve() : activate.mutateAsync())
                      .then(enterChat)
                      .catch(() => undefined)
                  }
                  size="sm"
                >
                  {state.active ? "进入 Moss" : "使用已保存的 Key"}
                </Button>
                <Button
                  disabled={pending}
                  onClick={() => signOut.mutate()}
                  size="sm"
                  variant="ghost"
                >
                  移除 Key
                </Button>
              </div>
            </section>
          ) : null}
          <EnterpriseKeyForm
            pending={pending}
            serverError={mutationError ? mossEnterpriseKeyErrorMessage(mutationError) : null}
            onSubmit={async (apiKey) => {
              await signIn.mutateAsync({ apiKey });
              await enterChat();
            }}
          />
        </div>
      )}
    </MossAuthShell>
  );
}
