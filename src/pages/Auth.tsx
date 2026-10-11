import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";

import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import { api } from "@/convex/_generated/api";
import { OtpSentSignal, useAuth } from "@/hooks/use-auth";
import { movieCategoryNames } from "@/lib/categories";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Film,
  Loader2,
  Lock,
  Mail,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Tv,
  UserX,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

/** How long the user must wait before another code can be requested. */
const RESEND_COOLDOWN_SECONDS = 30;

type Mode = "signin" | "signup";

/** Which screen the card is showing. */
type Step =
  /** Email (→ first visit mails a code) or email + password (returning). */
  | { kind: "form" }
  /** 6-digit code entry. */
  | { kind: "code"; email: string; purpose: "sign-in" | "verify" };

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/dashboard",
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

/**
 * The backend reports machine-ish reasons. Translate them into something a
 * viewer can act on.
 */
function friendlyAuthError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  if (raw.includes("Incorrect") || raw.toLowerCase().includes("incorrect")) {
    return "That code isn't right. Check the email and try again.";
  }
  if (raw.includes("Enter a valid email")) {
    return "Enter a valid email address.";
  }
  if (
    /Missing environment variable|Network Error|Failed to fetch|ECONN|timed out|RESEND_API_KEY/i.test(
      raw,
    ) ||
    raw.length > 200
  ) {
    return "We couldn't send that email just now. Please try again in a moment.";
  }
  if (raw.trim().length > 0) {
    return raw;
  }
  return "Something went wrong. Please try again.";
}

/** Readable error note for every step. */
function FormError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span className="leading-snug">{message}</span>
    </div>
  );
}

/** Small gradient chip used above each step's heading. */
function StepBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
      {children}
    </span>
  );
}

const FEATURES = [
  {
    icon: Film,
    title: "Movies, series & anime",
    text: "Bangla, Hindi, English and more — all under one roof.",
  },
  {
    icon: ShieldCheck,
    title: "Sign in your way",
    text: "A one-time email code — no password to remember or leak.",
  },
  {
    icon: Tv,
    title: "Any screen, any time",
    text: "Phone, tablet, laptop or TV — resume right where you stopped.",
  },
];

/**
 * Cinematic poster wall behind the pitch panel. Posters come from the live
 * catalog, so the page looks like the rest of the site the moment it loads.
 * Purely decorative: hidden from assistive tech and never interactive.
 */
function PosterWall({ posters }: { posters: string[] }) {
  const tiles = useMemo(
    () => Array.from({ length: 20 }, (_, i) => posters[i % posters.length]),
    [posters],
  );

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 select-none overflow-hidden"
    >
      <div className="absolute left-1/2 top-1/2 h-[165%] w-[155%] -translate-x-1/2 -translate-y-1/2 -rotate-12 opacity-90">
        <div className="grid size-full grid-cols-4 grid-rows-5 gap-3 xl:gap-4">
          {tiles.map((src, i) => (
            <div
              key={`${src}-${i}`}
              className="relative overflow-hidden rounded-xl border border-border/40 bg-muted shadow-lg"
            >
              <img
                src={src}
                alt=""
                loading="lazy"
                decoding="async"
                className="size-full object-cover"
              />
            </div>
          ))}
        </div>
      </div>
      {/* Scrims keep the copy readable: strongest behind the headline on the
          left, letting the poster art show through along the right edge. */}
      <div className="absolute inset-0 bg-gradient-to-r from-background via-background/95 to-background/15" />
      <div className="absolute inset-0 bg-gradient-to-b from-background/85 via-background/10 to-background/80" />
    </div>
  );
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );

  const [step, setStep] = useState<Step>({ kind: "form" });
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  const busy = isLoading;

  // Live catalog drives the decorative poster wall and the stats row.
  const movies = useQuery(api.movies.list);

  const posters = useMemo(
    () =>
      ((movies ?? []) as any[])
        .map((m: any) => m.posterUrl as string | undefined)
        .filter((url): url is string => Boolean(url))
        .slice(0, 18),
    [movies],
  );

  const stats = useMemo(() => {
    const rows = (movies ?? []) as any[];
    if (rows.length === 0) return null;
    const categories = new Set<string>();
    let series = 0;
    for (const m of rows) {
      for (const c of movieCategoryNames(m)) categories.add(c);
      if (m.kind === "series") series++;
    }
    return { titles: rows.length, categories: categories.size, series };
  }, [movies]);

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate(redirect);
    }
  }, [authLoading, isAuthenticated, navigate, redirect]);

  // Tick the resend cooldown down to zero, one second at a time.
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(
      () => setResendIn((s) => Math.max(0, s - 1)),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  /** One place for loading + error bookkeeping around an auth call. */
  const run = async (fn: () => Promise<unknown>) => {
    setIsLoading(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(friendlyAuthError(err));
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  /* ── Email (+ optional password for new accounts) ───────────────────── */

  const handleEmailSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (mode === "signup") {
      if (password !== confirmPassword) {
        setError("Those passwords don't match.");
        return;
      }
      if (password.length < 8) {
        setError("Use at least 8 characters for your password.");
        return;
      }
    }

    const fd = new FormData();
    fd.set("email", trimmedEmail);
    if (mode === "signup") fd.set("name", trimmedEmail.split("@")[0]);
    if (mode === "signup" && password) fd.set("password", password);

    const result = await run(() => signIn("email-otp", fd));
    if (result === null) return;
    // OtpSentSignal → the code screen; otherwise already signed in.
    setCode("");
    setStep({ kind: "code", email: trimmedEmail, purpose: mode === "signup" ? "verify" : "sign-in" });
    setResendIn(RESEND_COOLDOWN_SECONDS);
  };

  /* ── 6-digit code sign-in ───────────────────────────────────────────── */

  const handleCodeSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (step.kind !== "code") return;

    const fd = new FormData();
    fd.set("email", step.email);
    fd.set("code", code);
    const result = await run(() => signIn("email-otp", fd));
    if (result === null) {
      setCode("");
      return;
    }
    navigate(redirect);
  };

  /* ── Resend + guest ─────────────────────────────────────────────────── */

  const handleResendCode = async () => {
    if (step.kind !== "code") return;
    if (resendIn > 0) return;
    const result = await run(() => {
      const fd = new FormData();
      fd.set("email", step.email);
      return signIn("email-otp", fd);
    });
    if (result === null) return;
    setResendIn(RESEND_COOLDOWN_SECONDS);
  };

  const handleGuestLogin = async () => {
    const result = await run(() => {
      const fd = new FormData();
      fd.set("guest", "1");
      return signIn("anonymous", fd);
    });
    if (result === null) return;
    navigate(redirect);
  };

  /* ── Shared pieces ──────────────────────────────────────────────────── */

  const resendRow = (
    <div className="mt-4 text-center text-xs text-muted-foreground">
      {resendIn > 0 ? (
        <span>
          Didn't get it? Resend in{" "}
          <span className="font-semibold tabular-nums text-foreground">
            {resendIn}s
          </span>
        </span>
      ) : (
        <button
          type="button"
          onClick={handleResendCode}
          disabled={busy}
          className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline disabled:opacity-50"
        >
          <RotateCcw className="size-3" />
          Resend code
        </button>
      )}
    </div>
  );

  const codeSlots = (
    <div className="flex justify-center">
      <InputOTP
        value={code}
        onChange={setCode}
        maxLength={6}
        disabled={busy}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter" && code.length === 6 && !busy) {
            const form = (e.target as HTMLElement).closest("form");
            if (form) form.requestSubmit();
          }
        }}
      >
        <InputOTPGroup className="gap-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <InputOTPSlot
              key={index}
              index={index}
              className="size-10 rounded-lg text-base font-semibold sm:size-12 sm:text-lg"
            />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  );

  const emailPill = (address: string) => (
    <span className="mt-2 inline-flex max-w-full items-center gap-2 rounded-full border border-border/70 bg-muted/60 px-3 py-1 text-xs font-medium">
      <Mail className="size-3.5 shrink-0 text-primary" />
      <span className="truncate">{address}</span>
    </span>
  );

  const passwordField = (
    <>
      <label
        htmlFor="auth-password"
        className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
      >
        Password <span className="normal-case text-muted-foreground/70">(optional — secures the account)</span>
      </label>
      <div className="relative mt-2">
        <Lock className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="auth-password"
          name="password"
          type={showPassword ? "text" : "password"}
          autoComplete="new-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-11 rounded-lg pl-10 pr-10 text-sm"
          disabled={busy}
          minLength={8}
        />
        <button
          type="button"
          onClick={() => setShowPassword((s) => !s)}
          aria-label={showPassword ? "Hide password" : "Show password"}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    </>
  );

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      {/* Ambient glow — matches the landing page's lighting. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-[30%] top-[-25%] h-[520px] w-[720px] -translate-x-1/2 rounded-full bg-primary/12 blur-[140px]" />
        <div className="absolute bottom-[-20%] right-[-10%] h-[420px] w-[520px] rounded-full bg-chart-2/12 blur-[140px]" />
      </div>

      <div className="relative grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
        {/* ── Cinematic pitch panel (desktop only) ───────────────────────── */}
        <aside className="relative hidden overflow-hidden border-r border-border/60 lg:flex lg:flex-col lg:justify-between lg:gap-10 lg:p-10 xl:p-14">
          <div className="absolute inset-0 -z-10 bg-gradient-to-br from-card via-background to-secondary/50" />
          {posters.length > 0 && <PosterWall posters={posters} />}

          <div className="relative z-10 flex items-center justify-between gap-4">
            <Link to="/" aria-label="FilmFlix home" className="transition-opacity hover:opacity-90">
              <Logo />
            </Link>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
              <Sparkles className="size-3" />
              Now streaming
            </span>
          </div>

          <div className="relative z-10 max-w-xl">
            <h1 className="font-display text-4xl font-bold leading-[1.08] tracking-tight xl:text-5xl">
              Every story you love,
              <br />
              <span className="text-gradient">one login away.</span>
            </h1>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-foreground/80 xl:text-base">
              Sign in to FilmFlix and dive straight back into a hand-picked
              catalog of movies, series and anime — on every screen you own.
            </p>

            <ul className="mt-8 grid gap-3.5">
              {FEATURES.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card/70 text-primary">
                    <Icon className="size-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold">{title}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-foreground/80">
                      {text}
                    </span>
                  </span>
                </li>
              ))}
            </ul>

            {stats && (
              <dl className="mt-9 grid grid-cols-3 gap-4 border-t border-border/60 pt-6">
                {[
                  { label: "Titles", value: stats.titles },
                  { label: "Categories", value: stats.categories },
                  { label: "Series", value: stats.series },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <dd className="font-display text-2xl font-bold tabular-nums">{value}</dd>
                    <dt className="mt-0.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      {label}
                    </dt>
                  </div>
                ))}
              </dl>
            )}
          </div>

          <p className="relative z-10 text-xs text-muted-foreground">
            © 2026 FilmFlix · Stream responsibly — no titles are hosted on our
            servers.
          </p>
        </aside>

        {/* ── Auth panel ─────────────────────────────────────────────────── */}
        <main className="relative z-10 flex flex-1 flex-col">
          <div className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-10">
            <Link
              to="/"
              aria-label="FilmFlix home"
              className="transition-opacity hover:opacity-90 lg:hidden"
            >
              <Logo />
            </Link>
            <Link
              to="/"
              className="hidden items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground lg:inline-flex"
            >
              <ArrowLeft className="size-4" />
              Back to home
            </Link>
            <ThemeToggle />
          </div>

          <div className="flex flex-1 items-center justify-center px-4 pb-10 pt-2 sm:px-6">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: "easeOut" }}
              className="w-full max-w-[26rem]"
            >
              <div className="glass-panel relative overflow-hidden rounded-2xl shadow-[0_30px_90px_-40px_rgba(0,0,0,0.65)]">
                {/* Brand hairline along the top edge. */}
                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent" />

                <div className="p-6 sm:p-7">
                  {step.kind === "form" && (
                    <>
                      <div className="grid grid-cols-2 gap-1 rounded-xl border border-border/60 bg-muted/40 p-1">
                        {(["signin", "signup"] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            aria-pressed={mode === m}
                            onClick={() => {
                              setMode(m);
                              setError(null);
                            }}
                            className={cn(
                              "h-9 rounded-lg text-sm font-medium transition-colors",
                              mode === m
                                ? "bg-card text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {m === "signin" ? "Sign in" : "Create account"}
                          </button>
                        ))}
                      </div>

                      <h2 className="font-display mt-5 text-2xl font-semibold tracking-tight">
                        {mode === "signin" ? "Welcome back" : "Create your account"}
                      </h2>
                      <p className="mt-1.5 text-sm leading-relaxed text-foreground/80">
                        {mode === "signin"
                          ? "We'll email you a 6-digit code — no password needed."
                          : "Pick an email and an optional password, then confirm the 6-digit code we'll email."}
                      </p>

                      <div className="mt-5">
                        <form onSubmit={handleEmailSubmit}>
                          <label
                            htmlFor="auth-email"
                            className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
                          >
                            Email address
                          </label>
                          <div className="relative mt-2">
                            <Mail className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                              id="auth-email"
                              name="email"
                              type="email"
                              inputMode="email"
                              autoComplete="email"
                              placeholder="you@example.com"
                              value={email}
                              onChange={(e) => setEmail(e.target.value)}
                              className="h-11 rounded-lg pl-10 text-sm"
                              disabled={busy}
                              required
                            />
                          </div>

                          {mode === "signup" && passwordField}

                          {mode === "signup" && (
                            <>
                              <label
                                htmlFor="auth-password-confirm"
                                className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
                              >
                                Confirm password
                              </label>
                              <div className="relative mt-2">
                                <Lock className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                  id="auth-password-confirm"
                                  name="confirm-password"
                                  type={showPassword ? "text" : "password"}
                                  autoComplete="new-password"
                                  placeholder="••••••••"
                                  value={confirmPassword}
                                  onChange={(e) => setConfirmPassword(e.target.value)}
                                  className="h-11 rounded-lg pl-10 text-sm"
                                  disabled={busy}
                                />
                              </div>
                              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                                We'll email a 6-digit code to confirm your
                                address either way.
                              </p>
                            </>
                          )}

                          {error && <FormError message={error} />}

                          <Button
                            type="submit"
                            className="glow-accent mt-4 h-11 w-full rounded-lg text-sm font-semibold"
                            disabled={busy}
                          >
                            {isLoading ? (
                              <>
                                <Loader2 className="size-4 animate-spin" />
                                {mode === "signup" ? "Creating account…" : "Signing in…"}
                              </>
                            ) : (
                              <>
                                {mode === "signup" ? "Create account" : "Email me a sign-in code"}
                                <ArrowRight className="size-4" />
                              </>
                            )}
                          </Button>
                        </form>
                      </div>

                      <div className="mt-5 border-t border-border/60 pt-5">
                        <Button
                          type="button"
                          variant="outline"
                          className="h-11 w-full rounded-lg text-sm"
                          onClick={handleGuestLogin}
                          disabled={busy}
                        >
                          <UserX className="size-4" />
                          Continue as guest
                        </Button>
                        <p className="mt-3 text-center text-xs leading-relaxed text-foreground/80">
                          Continue as a guest to look around without an email
                          address.
                        </p>
                      </div>
                    </>
                  )}

                  {step.kind === "code" && (
                    <>
                      <div className="flex flex-col items-center text-center">
                        <StepBadge>
                          <ShieldCheck className="size-5" />
                        </StepBadge>
                        <h2 className="font-display mt-4 text-2xl font-semibold tracking-tight">
                          Check your inbox
                        </h2>
                        <p className="mt-1.5 text-sm text-foreground/80">
                          {step.purpose === "sign-in"
                            ? "We sent a 6-digit sign-in code to"
                            : "Enter the 6-digit code we sent to finish creating your account:"}
                        </p>
                        {emailPill(step.email)}
                      </div>

                      <form onSubmit={handleCodeSubmit} className="mt-7">
                        {codeSlots}
                        {error && <FormError message={error} />}

                        <Button
                          type="submit"
                          className="glow-accent mt-5 h-11 w-full rounded-lg text-sm font-semibold"
                          disabled={busy || code.length !== 6}
                        >
                          {isLoading ? (
                            <>
                              <Loader2 className="size-4 animate-spin" />
                              Verifying…
                            </>
                          ) : (
                            <>
                              Verify code
                              <ArrowRight className="size-4" />
                            </>
                          )}
                        </Button>

                        {resendRow}

                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            setError(null);
                            setCode("");
                            setStep({ kind: "form" });
                          }}
                          disabled={busy}
                          className="mt-2 h-9 w-full rounded-lg text-sm text-muted-foreground hover:text-foreground"
                        >
                          <ArrowLeft className="size-4" />
                          Back to sign in
                        </Button>
                      </form>
                    </>
                  )}
                </div>

              </div>

              <p className="mt-6 text-center text-[11px] leading-relaxed text-muted-foreground lg:hidden">
                © 2026 FilmFlix · Stream responsibly — no titles are hosted on
                our servers.
              </p>
            </motion.div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
