import { Link } from "@tanstack/react-router";

import { Logo } from "@/components/logo";
import { ModeToggle } from "@/components/theme";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useWorkspace, type AuthMode } from "@/features/workspace/use-workspace";

function AuthPage({ mode }: { mode: AuthMode }) {
  const {
    email,
    setEmail,
    password,
    setPassword,
    authError,
    setAuthError,
    authBusy,
    handleAuth,
    startGuest,
  } = useWorkspace();
  const register = mode === "register";

  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="absolute top-4 right-4">
        <ModeToggle />
      </div>
      <main className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-heading text-lg font-semibold">
          <Logo className="size-7" />
          CredLens
        </div>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">
              <h1>{register ? "Create your account" : "Welcome back"}</h1>
            </CardTitle>
            <CardDescription>
              {register
                ? "Save businesses, upload statements and share reports."
                : "Sign in to your CredLens account."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(event) => void handleAuth(event, mode)}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="auth-email">Email</FieldLabel>
                  <Input
                    id="auth-email"
                    type="email"
                    placeholder="name@company.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="auth-password">Password</FieldLabel>
                  <Input
                    id="auth-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={register ? "new-password" : "current-password"}
                    minLength={12}
                    maxLength={128}
                    required
                  />
                  {register ? <FieldDescription>12 to 128 characters.</FieldDescription> : null}
                </Field>
                {authError ? <FieldError role="alert">{authError}</FieldError> : null}
                <Field>
                  <Button type="submit" disabled={authBusy}>
                    {authBusy ? <Spinner /> : null}
                    {register ? "Create account" : "Sign in"}
                  </Button>
                  <FieldDescription className="text-center">
                    {register ? "Already have an account? " : "New to CredLens? "}
                    <Link to={register ? "/login" : "/signup"} onClick={() => setAuthError(null)}>
                      {register ? "Sign in" : "Create an account"}
                    </Link>
                  </FieldDescription>
                </Field>
                <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">or</FieldSeparator>
                <Field>
                  <Button type="button" variant="outline" disabled={authBusy} onClick={startGuest}>
                    Continue as guest
                  </Button>
                  <FieldDescription className="text-center">
                    Try it with a fictional company. Nothing is saved.
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
        <FieldDescription className="px-6 text-center">
          Use fictional figures until private-data protection is verified.
        </FieldDescription>
      </main>
    </div>
  );
}

export { AuthPage };
