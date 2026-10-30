import type { MossAccountStartPhoneLoginResult, ServerSettings } from "@synara/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { MossOtpInput } from "~/components/ui/input-otp";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossEnterpriseKeyStateQueryOptions,
  serverMossLogoutMutationOptions,
  serverMossPhoneLoginMutationOptions,
  synchronizeMossManagedChatReadiness,
} from "./mossServerReactQuery";
import { MossAuthLoading, MossAuthShell, useMossOpaqueSurface } from "./MossAuthShell";
import { MossCloudAccountPage } from "./MossCloudAuthPages";
import { MossEnterpriseKeyAccountPage } from "./MossEnterpriseKeyPage";
import { MossGoogleOAuthButton } from "./MossGoogleOAuth";
import { MossAccessLanesPanel } from "./MossAccessLanesPanel";
import { mossAccessLaneSummary } from "./mossAccessLanes.logic";
import { MossPayPanel } from "./MossPayPanel";
import type { MossAccountView } from "./mossAccountRoutes.logic";
import {
  normalizeMainlandPhoneInput,
  phoneAuthErrorMessage,
  validateMainlandPhone,
  validatePhoneCode,
} from "./mossPhoneAuth.logic";
import {
  completeMossPhoneLogin,
  resolveMossPhoneAuthenticatedSurface,
} from "./mossPhoneLogin.logic";
import { MOSS_POST_AUTH_CHAT_SEARCH } from "./mossPostAuthLanding";

const fieldClassName = "flex min-w-0 flex-col gap-2";

async function synchronizeMossPhoneLoginSettings(
  queryClient: QueryClient,
): Promise<ServerSettings | null> {
  await synchronizeMossManagedChatReadiness(queryClient);
  return queryClient.getQueryData<ServerSettings>(serverQueryKeys.settings()) ?? null;
}

function FieldError({ id, message }: { readonly id: string; readonly message: string | null }) {
  if (!message) return null;
  return (
    <p className="text-ui-sm leading-5 text-destructive" id={id}>
      {message}
    </p>
  );
}

export function MossPhoneLoginForm({
  pending,
  serverError,
  onSendCode,
  onVerifyCode,
  resendCooldownMs = 60_000,
}: {
  readonly pending: boolean;
  readonly serverError: string | null;
  readonly onSendCode: (phoneNumber: string) => Promise<MossAccountStartPhoneLoginResult>;
  readonly onVerifyCode: (input: {
    readonly challenge: MossAccountStartPhoneLoginResult;
    readonly code: string;
  }) => Promise<void>;
  readonly resendCooldownMs?: number | undefined;
}) {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<MossAccountStartPhoneLoginResult | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [cooldownEndsAt, setCooldownEndsAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const phoneRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const cooldownSeconds = Math.max(0, Math.ceil((cooldownEndsAt - now) / 1_000));
  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [cooldownSeconds]);

  const sendCode = async () => {
    const validationError = validateMainlandPhone(phoneNumber);
    setFieldError(validationError);
    if (validationError) {
      phoneRef.current?.focus();
      return;
    }
    let result: MossAccountStartPhoneLoginResult;
    try {
      result = await onSendCode(normalizeMainlandPhoneInput(phoneNumber));
    } catch {
      return;
    }
    setChallenge(result);
    setPhoneNumber(result.phoneNumber);
    setCode("");
    setCooldownEndsAt(Date.now() + Math.max(0, resendCooldownMs));
    setNow(Date.now());
    requestAnimationFrame(() => codeRef.current?.focus());
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!challenge) {
      await sendCode();
      return;
    }
    const validationError = validatePhoneCode(code);
    setFieldError(validationError);
    if (validationError) {
      codeRef.current?.focus();
      return;
    }
    try {
      await onVerifyCode({ challenge, code: code.trim() });
    } catch {
      setCode("");
      requestAnimationFrame(() => codeRef.current?.focus());
    }
  };

  const changePhone = () => {
    setChallenge(null);
    setCode("");
    setFieldError(null);
    requestAnimationFrame(() => phoneRef.current?.focus());
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

      {!challenge ? (
        <div className={fieldClassName}>
          <Label htmlFor="moss-phone-number">手机号</Label>
          <div className="flex min-w-0 items-center rounded-xl border border-input bg-background focus-within:ring-2 focus-within:ring-ring/60">
            <span className="shrink-0 border-r border-border/70 px-3 text-ui-lg text-muted-foreground">
              +86
            </span>
            <Input
              ref={phoneRef}
              aria-describedby={fieldError ? "moss-phone-number-error" : undefined}
              aria-invalid={Boolean(fieldError)}
              autoComplete="tel-national"
              autoFocus
              className="border-0 shadow-none focus-visible:ring-0"
              disabled={pending}
              id="moss-phone-number"
              inputMode="tel"
              maxLength={18}
              name="phone"
              onChange={(event) => {
                setPhoneNumber(event.target.value);
                setFieldError(null);
              }}
              placeholder="请输入中国大陆手机号"
              value={phoneNumber}
            />
          </div>
          <FieldError id="moss-phone-number-error" message={fieldError} />
        </div>
      ) : (
        <>
          <div className="flex min-h-10 items-center justify-between gap-3 rounded-xl border border-border bg-background px-3 py-2">
            <span className="text-ui-lg text-foreground">{challenge.phoneNumber}</span>
            <Button disabled={pending} onClick={changePhone} size="xs" type="button" variant="link">
              更换手机号
            </Button>
          </div>
          <div className={fieldClassName}>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="moss-phone-code">短信验证码</Label>
              <Button
                className="h-auto min-h-0 px-0 py-0"
                disabled={pending || cooldownSeconds > 0}
                onClick={() => void sendCode()}
                size="xs"
                type="button"
                variant="link"
              >
                {cooldownSeconds > 0 ? `${cooldownSeconds} 秒后重发` : "重新获取"}
              </Button>
            </div>
            <MossOtpInput
              ref={codeRef}
              aria-describedby={fieldError ? "moss-phone-code-error" : undefined}
              aria-invalid={Boolean(fieldError)}
              autoComplete="one-time-code"
              disabled={pending}
              id="moss-phone-code"
              inputMode="numeric"
              name="code"
              onChange={(value) => {
                setCode(value.replace(/\D/gu, "").slice(0, 6));
                setFieldError(null);
              }}
              pasteTransformer={(pasted) => pasted.replace(/\D/gu, "").slice(0, 6)}
              value={code}
            />
            <FieldError id="moss-phone-code-error" message={fieldError} />
          </div>
        </>
      )}

      <Button className="w-full" disabled={pending} size="lg" type="submit">
        {pending ? (challenge ? "正在登录…" : "正在发送…") : challenge ? "登录" : "获取验证码"}
      </Button>
      <p className="text-center text-ui-sm leading-5 text-muted-foreground">
        首次验证将自动创建 Moss 账号 · 短信服务由提市科技提供
      </p>
    </form>
  );
}

export function MossPhoneLoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accountQuery = useQuery(serverMossAccountSessionQueryOptions({ retry: 0 }));
  const mutation = useMutation(serverMossPhoneLoginMutationOptions({ queryClient }));
  const [restorationError, setRestorationError] = useState<string | null>(null);
  const authenticatedByCurrentMutation =
    mutation.data !== undefined && "authenticated" in mutation.data && mutation.data.authenticated;
  const authenticatedSurface = resolveMossPhoneAuthenticatedSurface({
    sessionAuthenticated: Boolean(accountQuery.data?.authenticated),
    currentMutationAuthenticated: authenticatedByCurrentMutation,
    recoveryError: restorationError,
  });

  useEffect(() => {
    if (!accountQuery.data?.authenticated || authenticatedByCurrentMutation) return;
    let active = true;
    setRestorationError(null);
    void completeMossPhoneLogin({
      authenticated: true,
      navigate: () => navigate({ to: "/", search: MOSS_POST_AUTH_CHAT_SEARCH, replace: true }),
      queryClient,
      synchronize: () => synchronizeMossPhoneLoginSettings(queryClient),
    })
      .then((completed) => {
        if (active && !completed) {
          setRestorationError("无法进入 Moss，请重试。");
        }
      })
      .catch(() => {
        if (active) setRestorationError("无法进入 Moss，请重试。");
      });
    return () => {
      active = false;
    };
  }, [accountQuery.data?.authenticated, authenticatedByCurrentMutation, navigate, queryClient]);

  const error = mutation.error ? phoneAuthErrorMessage(mutation.error) : restorationError;

  return (
    <MossAuthShell
      title="登录 Moss"
      description={`中国大陆手机号 · ${mossAccessLaneSummary("cn")}`}
    >
      <div className="flex min-w-0 flex-col gap-5">
        {authenticatedSurface === "preparing" ? (
          <MossAuthLoading label="正在进入 Moss…" />
        ) : authenticatedSurface === "recovery" ? (
          <div className="flex flex-col gap-3">
            <Alert variant="error">
              <AlertDescription>{restorationError}</AlertDescription>
            </Alert>
            <Button onClick={() => void navigate({ to: "/account", replace: true })}>
              前往账号页重试
            </Button>
          </div>
        ) : !accountQuery.isError && accountQuery.data?.configured === false ? (
          <Alert variant="error">
            <AlertDescription>手机号登录服务尚未配置。</AlertDescription>
          </Alert>
        ) : (
          <MossPhoneLoginForm
            pending={mutation.isPending}
            serverError={error}
            onSendCode={async (phoneNumber) => {
              const result = await mutation.mutateAsync({ phoneNumber });
              if (!("challengeId" in result)) throw new Error("验证码请求失败，请重试。");
              return result;
            }}
            onVerifyCode={async ({ challenge, code }) => {
              const result = await mutation.mutateAsync({
                challengeId: challenge.challengeId,
                phoneNumber: challenge.phoneNumber,
                code,
              });
              if ("authenticated" in result && result.authenticated) {
                try {
                  await completeMossPhoneLogin({
                    authenticated: true,
                    navigate: () =>
                      navigate({ to: "/", search: MOSS_POST_AUTH_CHAT_SEARCH, replace: true }),
                    queryClient,
                    synchronize: () => synchronizeMossPhoneLoginSettings(queryClient),
                  });
                } catch {
                  setRestorationError("账号已登录，但暂时无法进入 Moss。请重试。");
                }
              }
            }}
          />
        )}

        <MossOtherLoginOptions />
      </div>
    </MossAuthShell>
  );
}

function LoginLaneCaption({ children }: { readonly children: string }) {
  return <p className="text-center text-ui-sm leading-5 text-muted-foreground">{children}</p>;
}

/**
 * The other two sign-in lanes, offered as another way to sign in:
 * Google reaches every vendor over the user's own overseas network; an
 * enterprise key reaches every vendor through the mainland gateway.
 */
export function MossOtherLoginOptions() {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center gap-3 text-ui-sm text-muted-foreground" role="separator">
        <span className="h-px flex-1 bg-border" />
        其他登录方式
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <MossGoogleOAuthButton />
        <LoginLaneCaption>{mossAccessLaneSummary("global")}</LoginLaneCaption>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Button
          className="w-full"
          render={<Link to="/login/api-key" />}
          size="lg"
          variant="outline"
        >
          使用企业 API Key 登录
        </Button>
        <LoginLaneCaption>{`${mossAccessLaneSummary("enterprise")}，适合团队与企业`}</LoginLaneCaption>
      </div>
    </div>
  );
}

export function MossPhoneAccountPage() {
  useMossOpaqueSurface();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accountQuery = useQuery(serverMossAccountSessionQueryOptions());
  const logoutMutation = useMutation(serverMossLogoutMutationOptions({ queryClient }));
  const session = accountQuery.data?.session;

  return (
    <main className="min-h-dvh w-full overflow-y-auto bg-background px-4 py-8 text-foreground sm:px-8 sm:py-10">
      <div className="mx-auto flex w-full max-w-xl min-w-0 flex-col gap-7">
        <header className="flex min-w-0 items-center justify-between gap-4">
          <Link
            className="text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            to="/"
          >
            Moss
          </Link>
          <Link
            className="text-ui-lg font-medium underline-offset-4 hover:underline"
            to="/settings"
          >
            设置
          </Link>
        </header>

        {accountQuery.isPending ? (
          <MossAuthLoading label="正在加载账号…" />
        ) : accountQuery.isError ? (
          <Alert variant="error">
            <AlertDescription>无法加载手机号账号，请重试。</AlertDescription>
          </Alert>
        ) : !session ? (
          <section className="rounded-xl border border-dashed p-5 text-ui-lg text-muted-foreground">
            当前未登录。{" "}
            <Link className="font-medium text-foreground hover:underline" to="/login">
              前往登录
            </Link>
          </section>
        ) : (
          <>
            <section aria-labelledby="moss-phone-account-heading">
              <p className="text-ui-lg font-medium text-muted-foreground">Moss 账号</p>
              <h1
                id="moss-phone-account-heading"
                className="mt-1 text-2xl font-semibold tracking-tight"
              >
                {session.user.displayName ?? session.user.phoneNumber}
              </h1>
              <p className="mt-2 text-ui-lg text-muted-foreground">
                {session.user.phoneNumber} · 手机号已验证
              </p>
            </section>

            <section className="rounded-xl border border-border/70 p-4">
              <h2 className="text-ui-lg font-medium">国内账号服务</h2>
              <p className="mt-1 text-ui-lg leading-6 text-muted-foreground">
                短信验证由提市科技的阿里云服务处理，账号与积分数据独立存储在 Moss 项目中。
              </p>
            </section>

            <MossAccessLanesPanel />

            <MossPayPanel />
            <section className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
              <div className="min-w-0">
                <h2 className="text-ui-lg font-medium">用量与充值</h2>
                <p className="mt-1 text-ui-lg text-muted-foreground">
                  与 Codex 相同：在设置 → 用量里查看额度并充值。
                </p>
              </div>
              <Button
                onClick={() => void navigate({ to: "/settings", search: { section: "usage" } })}
                size="sm"
              >
                打开用量
              </Button>
            </section>

            <section className="flex min-w-0 flex-wrap items-center justify-between gap-4 border-t pt-5">
              <p aria-live="polite" className="text-ui-lg text-muted-foreground" role="status">
                {logoutMutation.isPending
                  ? "正在退出…"
                  : "登录状态已安全保存在本机；除非主动退出或服务端撤销，否则无需再次验证。"}
              </p>
              <Button
                disabled={logoutMutation.isPending}
                onClick={() =>
                  logoutMutation.mutate(undefined, {
                    onSuccess: () => void navigate({ to: "/login", replace: true }),
                  })
                }
                variant="outline"
              >
                退出登录
              </Button>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

export function MossAccountPage({ view }: { readonly view?: MossAccountView | undefined }) {
  const phoneQuery = useQuery(serverMossAccountSessionQueryOptions());
  const cloudQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const enterpriseQuery = useQuery(serverMossEnterpriseKeyStateQueryOptions());
  if (view === "google") return <MossCloudAccountPage />;
  if (phoneQuery.isPending || enterpriseQuery.isPending) {
    return (
      <MossAuthShell title="Moss 账号">
        <MossAuthLoading label="正在加载账号…" />
      </MossAuthShell>
    );
  }
  if (phoneQuery.data?.authenticated) return <MossPhoneAccountPage />;
  // An enterprise key is a complete sign-in; Google keeps its own page.
  if (enterpriseQuery.data?.authenticated && !cloudQuery.data?.authenticated) {
    return <MossEnterpriseKeyAccountPage />;
  }
  return <MossCloudAccountPage />;
}
