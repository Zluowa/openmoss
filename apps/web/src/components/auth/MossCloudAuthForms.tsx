import { Link } from "@tanstack/react-router";
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  hasMossCloudAuthFieldErrors,
  normalizeMossCloudEmail,
  type MossCloudAuthFieldErrors,
  validateMossCloudEmail,
  validateMossCloudPasswordUpdate,
  validateMossCloudSignIn,
  validateMossCloudSignUp,
} from "./mossCloudAuth.logic";

function useFocusOnMessage(message: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  return ref;
}

function AuthError({ message }: { readonly message: string | null }) {
  const ref = useFocusOnMessage(message);
  if (!message) return null;
  return (
    <Alert
      ref={ref}
      aria-live="assertive"
      className="outline-none"
      role="alert"
      tabIndex={-1}
      variant="error"
    >
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function FieldMessage({
  id,
  message,
}: {
  readonly id: string;
  readonly message: string | undefined;
}) {
  if (!message) return null;
  return (
    <p className="text-ui-sm leading-5 text-destructive" id={id}>
      {message}
    </p>
  );
}

function focusFirstInvalid(
  errors: MossCloudAuthFieldErrors,
  refs: ReadonlyArray<
    readonly [keyof MossCloudAuthFieldErrors, RefObject<HTMLInputElement | null>]
  >,
) {
  refs.find(([field]) => Boolean(errors[field]))?.[1].current?.focus();
}

const formClassName = "flex min-w-0 flex-col gap-5";
const fieldClassName = "flex min-w-0 flex-col gap-2";
const linkClassName =
  "rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60";

export function MossCloudSignInForm({
  pending,
  serverError,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly serverError: string | null;
  readonly onSubmit: (values: { email: string; password: string }) => void | Promise<void>;
}) {
  const [step, setStep] = useState<"email" | "password">("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<MossCloudAuthFieldErrors>({});
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (step === "email") {
      const emailError = validateMossCloudEmail(email);
      setErrors(emailError ? { email: emailError } : {});
      if (emailError) {
        emailRef.current?.focus();
        return;
      }

      setEmail(normalizeMossCloudEmail(email));
      setStep("password");
      return;
    }

    const nextErrors = validateMossCloudSignIn({ email, password });
    setErrors(nextErrors);
    if (hasMossCloudAuthFieldErrors(nextErrors)) {
      if (nextErrors.email) {
        setStep("email");
        return;
      }
      focusFirstInvalid(nextErrors, [["password", passwordRef]]);
      return;
    }
    void onSubmit({ email: normalizeMossCloudEmail(email), password });
  };

  const handleChangeEmail = () => {
    setErrors({});
    setPassword("");
    setStep("email");
  };

  return (
    <form aria-busy={pending} className={formClassName} noValidate onSubmit={handleSubmit}>
      {step === "password" ? <AuthError message={serverError} /> : null}
      {step === "email" ? (
        <div className={fieldClassName}>
          <Label htmlFor="moss-login-email">Email</Label>
          <Input
            ref={emailRef}
            aria-describedby={errors.email ? "moss-login-email-error" : undefined}
            aria-invalid={Boolean(errors.email)}
            autoComplete="email"
            autoFocus
            disabled={pending}
            id="moss-login-email"
            inputMode="email"
            name="email"
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            value={email}
          />
          <FieldMessage id="moss-login-email-error" message={errors.email} />
        </div>
      ) : (
        <>
          <div className={fieldClassName}>
            <span className="text-ui-lg font-medium leading-none">Email</span>
            <div
              aria-label={`Email: ${email}`}
              className="flex min-h-10 min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2 sm:min-h-9"
              role="group"
            >
              <span className="min-w-0 truncate text-ui-lg text-foreground">{email}</span>
              <Button
                aria-label={`Change email from ${email}`}
                className="h-auto min-h-0 px-0 py-0"
                disabled={pending}
                onClick={handleChangeEmail}
                size="xs"
                type="button"
                variant="link"
              >
                Change
              </Button>
            </div>
          </div>
          <div className={fieldClassName}>
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <Label htmlFor="moss-login-password">Password</Label>
              <Link className={linkClassName} to="/forgot-password">
                Forgot password?
              </Link>
            </div>
            <Input
              ref={passwordRef}
              aria-describedby={errors.password ? "moss-login-password-error" : undefined}
              aria-invalid={Boolean(errors.password)}
              autoComplete="current-password"
              autoFocus
              disabled={pending}
              id="moss-login-password"
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
            <FieldMessage id="moss-login-password-error" message={errors.password} />
          </div>
        </>
      )}
      <Button className="w-full" disabled={pending} size="lg" type="submit">
        {step === "password" && pending ? "Signing in…" : "Continue"}
      </Button>
      <p aria-live="polite" className="sr-only" role="status">
        {step === "password" && pending ? "Signing in to Moss." : ""}
      </p>
    </form>
  );
}

export function MossCloudSignUpForm({
  pending,
  serverError,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly serverError: string | null;
  readonly onSubmit: (values: {
    displayName: string;
    email: string;
    password: string;
  }) => void | Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<MossCloudAuthFieldErrors>({});
  const displayNameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateMossCloudSignUp({ displayName, email, password });
    setErrors(nextErrors);
    if (hasMossCloudAuthFieldErrors(nextErrors)) {
      focusFirstInvalid(nextErrors, [
        ["displayName", displayNameRef],
        ["email", emailRef],
        ["password", passwordRef],
      ]);
      return;
    }
    void onSubmit({
      displayName: displayName.trim(),
      email: normalizeMossCloudEmail(email),
      password,
    });
  };

  return (
    <form aria-busy={pending} className={formClassName} noValidate onSubmit={handleSubmit}>
      <AuthError message={serverError} />
      <div className={fieldClassName}>
        <Label htmlFor="moss-signup-name">Name (optional)</Label>
        <Input
          ref={displayNameRef}
          aria-describedby={errors.displayName ? "moss-signup-name-error" : undefined}
          aria-invalid={Boolean(errors.displayName)}
          autoComplete="name"
          autoFocus
          id="moss-signup-name"
          name="name"
          onChange={(event) => setDisplayName(event.target.value)}
          value={displayName}
        />
        <FieldMessage id="moss-signup-name-error" message={errors.displayName} />
      </div>
      <div className={fieldClassName}>
        <Label htmlFor="moss-signup-email">Email</Label>
        <Input
          ref={emailRef}
          aria-describedby={errors.email ? "moss-signup-email-error" : undefined}
          aria-invalid={Boolean(errors.email)}
          autoComplete="email"
          id="moss-signup-email"
          inputMode="email"
          name="email"
          onChange={(event) => setEmail(event.target.value)}
          type="email"
          value={email}
        />
        <FieldMessage id="moss-signup-email-error" message={errors.email} />
      </div>
      <div className={fieldClassName}>
        <Label htmlFor="moss-signup-password">Password</Label>
        <Input
          ref={passwordRef}
          aria-describedby="moss-signup-password-help moss-signup-password-error"
          aria-invalid={Boolean(errors.password)}
          autoComplete="new-password"
          id="moss-signup-password"
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          value={password}
        />
        <p className="text-ui-sm leading-5 text-muted-foreground" id="moss-signup-password-help">
          Use 8–128 characters.
        </p>
        <FieldMessage id="moss-signup-password-error" message={errors.password} />
      </div>
      <Button className="w-full" disabled={pending} size="lg" type="submit">
        {pending ? "Creating account…" : "Create account"}
      </Button>
      <p aria-live="polite" className="sr-only" role="status">
        {pending ? "Creating your Moss account." : ""}
      </p>
    </form>
  );
}

export function MossCloudForgotPasswordForm({
  pending,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly onSubmit: (email: string) => void | Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();
  const emailRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextError = validateMossCloudEmail(email);
    setError(nextError);
    if (nextError) {
      emailRef.current?.focus();
      return;
    }
    void onSubmit(normalizeMossCloudEmail(email));
  };

  return (
    <form aria-busy={pending} className={formClassName} noValidate onSubmit={handleSubmit}>
      <div className={fieldClassName}>
        <Label htmlFor="moss-forgot-email">Email</Label>
        <Input
          ref={emailRef}
          aria-describedby={error ? "moss-forgot-email-error" : undefined}
          aria-invalid={Boolean(error)}
          autoComplete="email"
          autoFocus
          id="moss-forgot-email"
          inputMode="email"
          name="email"
          onChange={(event) => setEmail(event.target.value)}
          type="email"
          value={email}
        />
        <FieldMessage id="moss-forgot-email-error" message={error} />
      </div>
      <Button className="w-full" disabled={pending} size="lg" type="submit">
        {pending ? "Sending link…" : "Send reset link"}
      </Button>
      <p aria-live="polite" className="sr-only" role="status">
        {pending ? "Requesting a password reset link." : ""}
      </p>
    </form>
  );
}

export function MossCloudResetPasswordForm({
  pending,
  serverError,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly serverError: string | null;
  readonly onSubmit: (password: string) => void | Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<MossCloudAuthFieldErrors>({});
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateMossCloudPasswordUpdate({ password, confirmPassword });
    setErrors(nextErrors);
    if (hasMossCloudAuthFieldErrors(nextErrors)) {
      focusFirstInvalid(nextErrors, [
        ["password", passwordRef],
        ["confirmPassword", confirmPasswordRef],
      ]);
      return;
    }
    void onSubmit(password);
  };

  return (
    <form aria-busy={pending} className={formClassName} noValidate onSubmit={handleSubmit}>
      <AuthError message={serverError} />
      <div className={fieldClassName}>
        <Label htmlFor="moss-reset-password">New password</Label>
        <Input
          ref={passwordRef}
          aria-describedby="moss-reset-password-help moss-reset-password-error"
          aria-invalid={Boolean(errors.password)}
          autoComplete="new-password"
          autoFocus
          id="moss-reset-password"
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          value={password}
        />
        <p className="text-ui-sm leading-5 text-muted-foreground" id="moss-reset-password-help">
          Use 8–128 characters.
        </p>
        <FieldMessage id="moss-reset-password-error" message={errors.password} />
      </div>
      <div className={fieldClassName}>
        <Label htmlFor="moss-reset-confirm-password">Confirm new password</Label>
        <Input
          ref={confirmPasswordRef}
          aria-describedby={
            errors.confirmPassword ? "moss-reset-confirm-password-error" : undefined
          }
          aria-invalid={Boolean(errors.confirmPassword)}
          autoComplete="new-password"
          id="moss-reset-confirm-password"
          name="confirmPassword"
          onChange={(event) => setConfirmPassword(event.target.value)}
          type="password"
          value={confirmPassword}
        />
        <FieldMessage id="moss-reset-confirm-password-error" message={errors.confirmPassword} />
      </div>
      <Button className="w-full" disabled={pending} size="lg" type="submit">
        {pending ? "Updating password…" : "Update password"}
      </Button>
      <p aria-live="polite" className="sr-only" role="status">
        {pending ? "Updating your Moss password." : ""}
      </p>
    </form>
  );
}

export { linkClassName };
