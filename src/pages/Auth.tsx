/**
 * Auth page — email-OTP first, guest session second (same UX the Convex-era
 * page had; backend is the Worker now).
 */
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { OtpSentSignal, useAuth } from "@/hooks/use-auth";
import Logo from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Mail, ShieldCheck, UserRound } from "lucide-react";
import { toast } from "sonner";

export default function AuthPage({
  redirectAfterAuth = "/dashboard",
}: {
  redirectAfterAuth?: string;
}) {
  const { isAuthenticated, isLoading, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo =
    new URLSearchParams(location.search).get("returnTo") ?? redirectAfterAuth;

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isLoading && isAuthenticated) navigate(returnTo, { replace: true });
  }, [isAuthenticated, isLoading, navigate, returnTo]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("email", email.trim());
      if (step === "code") fd.set("code", code.trim());
      await signIn("email-otp", fd);
      navigate(returnTo, { replace: true });
    } catch (err) {
      if (err instanceof OtpSentSignal) {
        setStep("code");
        toast.success(`Code sent to ${email.trim()}`);
      } else {
        toast.error(err instanceof Error ? err.message : "Sign-in failed");
      }
    } finally {
      setBusy(false);
    }
  };

  const guest = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("guest", "1");
      await signIn("anonymous", fd);
      navigate(returnTo, { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Guest sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-4">
      <Logo className="h-10" />
      <div className="w-full max-w-sm rounded-2xl border border-border/60 bg-card/70 p-6 shadow-xl">
        <h1 className="font-display text-xl font-bold tracking-tight">
          {step === "email" ? "Sign in to FilmFlix" : "Check your inbox"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {step === "email"
            ? "We'll email you a one-time code — no password needed."
            : `Enter the 6-digit code we sent to ${email.trim()}.`}
        </p>

        <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
          {step === "email" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="code">Verification code</Label>
              <Input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                className="text-center font-mono text-lg tracking-[0.4em]"
              />
              <button
                type="button"
                onClick={() => { setStep("email"); setCode(""); }}
                className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                ← change email
              </button>
            </div>
          )}

          <Button type="submit" disabled={busy} className="mt-2">
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : step === "email" ? (
              <>
                <Mail className="size-4" /> Send code
              </>
            ) : (
              <>
                <ShieldCheck className="size-4" /> Verify & continue
              </>
            )}
          </Button>
        </form>

        <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-wide text-muted-foreground">
          <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
        </div>

        <Button variant="outline" onClick={guest} disabled={busy} className="w-full">
          <UserRound className="size-4" /> Continue as guest
        </Button>
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          Guest accounts can browse and watch, but can't save a watchlist or
          place plan orders.
        </p>
      </div>
    </div>
  );
}
