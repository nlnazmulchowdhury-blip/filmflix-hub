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
import { useAuth } from "@/hooks/use-auth";
import { movieCategoryNames } from "@/lib/categories";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Film,
  KeyRound,
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

/** Mirrors the minimum enforced server-side by the Convex Auth Password provider. */
const MIN_PASSWORD_LENGTH = 8;

type Mode = "signin" | "signup";

/** Which screen the card is showing. */
type Step =
  /** Email + password (sign in or create account). */
  | { kind: "form" }
  /** 6-digit code: `sign-in` = email OTP, `verify` = confirm a new password account. */
  | { kind: "code"; email: string; purpose: "sign-in" | "verify" }
  /** Ask for the address that should receive a password reset code. */
  | { kind: "forgot" }
  /** Enter the reset code plus the new password. */
  | { kind: "reset"; email: string };

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
 * The backend reports machine-ish reasons ("InvalidSecret",
 * "InvalidAccountId", "TooManyFailedAttempts", "Account x already exists").
 * Translate them into something a viewer can act on.
 */
function friendlyAuthError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  if (raw.includes("InvalidSecret")) {
    return "That password doesn't match this email.";
  }
  if (raw.includes("InvalidAccountId")) {
    return "We couldn't find an account with that email address.";
  }
  if (raw.includes("TooManyFailedAttempts")) {
    return "Too many failed attempts. Please wait a few minutes and try again.";
  }
  if (raw.includes("already exists")) {
    return "That email already has an account — sign in instead.";
  }
  if (raw.includes("Invalid credentials")) {
    return "Incorrect email or password.";
  }
  if (raw.includes("Invalid code")) {
    return "That code isn't right. Check the email and try again.";
  }
  if (raw.includes("Invalid password")) {
    // The only server-side rule for new passwords is the 8 character minimum.
    return `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (raw.includes("Missing `password`")) {
    return "Enter a password to continue.";
  }
  if (raw.includes("Enter a valid email")) {
    return "Enter a valid email address.";
  }
  // Everything below is infrastructure, not something the viewer did: a mailer
  // outage, a deployment missing an env var, or a dropped connection. These
  // arrive as long machine blobs ("Uncaught Error: {\"message\":..."), which are
  // useless on screen — say what happened instead.
  if (/send_otp|Request failed with status code|ERR_BAD_RESPONSE/i.test(raw)) {
    return "We couldn't send that email just now. Please try again in a moment.";
  }
  if (
    /Missing environment variable|Network Error|Failed to fetch|ECONN|timed out|Uncaught Error|axios/i.test(
      raw,
    ) ||
    raw.length > 200
  ) {
    return "Sign-in is temporarily unavailable. Please try again in a moment.";
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

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4">
      <path
        fill="#4285F4"
        d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.63h6.2a5.3 5.3 0 0 1-2.3 3.48v2.9h3.72c2.18-2.01 3.44-4.97 3.44-8.56Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.11 0 5.72-1.03 7.62-2.79l-3.72-2.9c-1.03.7-2.35 1.11-3.9 1.11-3 0-5.54-2.02-6.45-4.75H1.7v3c1.9 3.77 5.8 6.33 10.3 6.33Z"
      />
      <path
        fill="#FBBC05"
        d="M5.55 14.67a7.2 7.2 0 0 1 0-4.6V7.06H1.7a12 12 0 0 0 0 10.62l3.85-3.01Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.69 0 3.21.58 4.4 1.72l3.3-3.3C17.71 1.2 15.1 0 12 0 7.5 0 3.6 2.56 1.7 6.33l3.85 3.01C6.46 6.77 9 4.75 12 4.75Z"
      />
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4 fill-current">
      <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07Z" />
    </svg>
  );
}

/** Apple's mark: fill-current keeps it legible in both themes. */
function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4 fill-current">
      <path d="M16.36 12.72c.02 2.65 2.32 3.53 2.35 3.54-.02.06-.37 1.26-1.22 2.5-.74 1.07-1.5 2.13-2.71 2.15-1.19.02-1.57-.7-2.92-.7-1.36 0-1.78.68-2.9.72-1.16.05-2.05-1.15-2.79-2.21C4.85 16.62 3.76 12.96 5.3 10.53a4.6 4.6 0 0 1 3.9-2.36c1.15-.02 2.24.77 2.94.77.7 0 2-.95 3.38-.81.58.02 2.2.23 3.24 1.76-.08.05-1.93 1.13-1.9 2.83M14.18 6.42c.63-.76 1.06-1.82.94-2.88-.91.04-2.02.61-2.68 1.37-.58.67-1.09 1.75-.96 2.78 1.02.08 2.07-.51 2.7-1.27" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4 fill-current">
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.2 11.39.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.96 0-1.32.47-2.4 1.24-3.24-.13-.3-.54-1.53.12-3.19 0 0 1.01-.32 3.3 1.24a11.5 11.5 0 0 1 6 0c2.29-1.56 3.3-1.24 3.3-1.24.66 1.66.25 2.89.12 3.19.77.84 1.24 1.92 1.24 3.24 0 4.63-2.81 5.65-5.49 5.95.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5Z" />
    </svg>
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
    text: "Google, Apple, GitHub, Facebook, a password or a one-time email code.",
  },
  {
    icon: Tv,
    title: "Any screen, any time",
    text: "Phone, tablet, laptop or TV — resume right where you stopped.",
  },
];

/** Every social provider the auth page offers, in display order. */
const OAUTH_PROVIDERS = [
  { id: "google", label: "Google", icon: <GoogleIcon /> },
  { id: "apple", label: "Apple", icon: <AppleIcon /> },
  { id: "github", label: "GitHub", icon: <GitHubIcon /> },
  {
    id: "facebook",
    label: "Facebook",
    icon: <span className="text-[#1877F2]"><FacebookIcon /></span>,
  },
] as const satisfies readonly {
  id: "google" | "apple" | "github" | "facebook";
  label: string;
  icon: React.ReactNode;
}[];

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
  const [code, setCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [oauthPending, setOauthPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  const busy = isLoading || oauthPending !== null;

  // Live catalog drives the decorative poster wall and the stats row.
  const movies = useQuery(api.movies.list);

  const posters = useMemo(
    () =>
      (movies ?? [])
        .map((m) => m.posterUrl)
        .filter((url): url is string => Boolean(url))
        .slice(0, 18),
    [movies],
  );

  const stats = useMemo(() => {
    if (!movies || movies.length === 0) return null;
    const categories = new Set<string>();
    let series = 0;
    for (const m of movies) {
      for (const c of movieCategoryNames(m)) categories.add(c);
      if (m.kind === "series") series++;
    }
    return { titles: movies.length, categories: categories.size, series };
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
      console.error("Auth error:", err);
      setError(friendlyAuthError(err));
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  /* ── Email + password ───────────────────────────────────────────────── */

  const handlePasswordSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (mode === "signup" && password !== confirmPassword) {
      setError("Those passwords don't match.");
      return;
    }
    if (mode === "signup" && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    const result = await run(() =>
      signIn("password", {
        email: trimmedEmail,
        password,
        flow: mode === "signup" ? "signUp" : "signIn",
      }),
    );
    if (result === null) return;

    setPassword("");
    setConfirmPassword("");
    const signingIn =
      typeof result === "object" && result !== null && "signingIn" in result
        ? Boolean((result as { signingIn?: boolean }).signingIn)
        : false;
    if (signingIn) {
      navigate(redirect);
      return;
    }
    // No session yet: the backend mailed a 6-digit code we have to confirm.
    setCode("");
    setStep({ kind: "code", email: trimmedEmail, purpose: "verify" });
    setResendIn(RESEND_COOLDOWN_SECONDS);
  };

  /* ── 6-digit codes (sign-in and account verification) ───────────────── */

  const handleCodeSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (step.kind !== "code") return;

    const result = await run(() =>
      step.purpose === "sign-in"
        ? signIn("email-otp", { email: step.email, code })
        : signIn("password", {
            email: step.email,
            code,
            flow: "email-verification",
          }),
    );
    if (result === null) {
      setCode("");
      return;
    }
    navigate(redirect);
  };

  /* ── Password reset ─────────────────────────────────────────────────── */

  const handleForgotSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    const result = await run(() =>
      signIn("password", { email: trimmedEmail, flow: "reset" }),
    );
    if (result === null) return;
    setCode("");
    setPassword("");
    setConfirmPassword("");
    setStep({ kind: "reset", email: trimmedEmail });
    setResendIn(RESEND_COOLDOWN_SECONDS);
  };

  const handleResetSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (step.kind !== "reset") return;
    if (password !== confirmPassword) {
      setError("Those passwords don't match.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    const result = await run(() =>
      signIn("password", {
        email: step.email,
        code,
        newPassword: password,
        flow: "reset-verification",
      }),
    );
    if (result === null) {
      setCode("");
      return;
    }
    setPassword("");
    setConfirmPassword("");
    navigate(redirect);
  };

  /* ── Resend, guest and OAuth ────────────────────────────────────────── */

  const handleResendCode = async () => {
    if (step.kind !== "code" && step.kind !== "reset") return;
    if (resendIn > 0) return;
    const target = step.email;
    const result = await run(() =>
      step.kind === "reset"
        ? signIn("password", { email: target, flow: "reset" })
        : step.purpose === "sign-in"
          ? signIn("email-otp", { email: target })
          : signIn("password", { email: target, flow: "email-verification" }),
    );
    if (result === null) return;
    setResendIn(RESEND_COOLDOWN_SECONDS);
  };

  const handleGuestLogin = async () => {
    const result = await run(() => signIn("anonymous"));
    if (result === null) return;
    navigate(redirect);
  };

  const handleOAuth = async (provider: (typeof OAUTH_PROVIDERS)[number]["id"]) => {
    setOauthPending(provider);
    setError(null);
    try {
      // The client sends the browser to the provider and returns to
      // `redirect`, where it exchanges the one-time code for a session.
      await signIn(provider, { redirectTo: redirect });
    } catch (err) {
      console.error("OAuth error:", err);
      setError(friendlyAuthError(err));
      setOauthPending(null);
    }
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
        className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
      >
        Password
      </label>
      <div className="relative mt-2">
        <Lock className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="auth-password"
          name="password"
          type={showPassword ? "text" : "password"}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-11 rounded-lg pl-10 pr-11 text-sm"
          disabled={busy}
          required
          minLength={MIN_PASSWORD_LENGTH}
        />
        <button
          type="button"
          onClick={() => setShowPassword((v) => !v)}
          aria-label={showPassword ? "Hide password" : "Show password"}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground"
        >
          {showPassword ? (
            <EyeOff className="size-4" />
          ) : (
            <Eye className="size-4" />
          )}
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
            <Link
              to="/"
              aria-label="FilmFlix home"
              className="transition-opacity hover:opacity-90"
            >
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
                    <span className="block text-sm font-semibold">
                      {title}
                    </span>
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
                    <dd className="font-display text-2xl font-bold tabular-nums">
                      {value}
                    </dd>
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

                      <div className="mt-5 grid grid-cols-2 gap-2.5">
                        {OAUTH_PROVIDERS.map((provider) => (
                          <Button
                            key={provider.id}
                            type="button"
                            variant="outline"
                            className="h-11 w-full justify-center rounded-lg text-sm cursor-pointer"
                            onClick={() => handleOAuth(provider.id)}
                            disabled={busy}
                          >
                            {oauthPending === provider.id ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              provider.icon
                            )}
                            {provider.label}
                          </Button>
                        ))}
                      </div>

                      <div className="my-5 flex items-center gap-3">
                        <span className="h-px flex-1 bg-border" />
                        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                          or use email
                        </span>
                        <span className="h-px flex-1 bg-border" />
                      </div>

                      <form onSubmit={handlePasswordSubmit}>
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

                        <div className="mt-4">{passwordField}</div>

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
                                onChange={(e) =>
                                  setConfirmPassword(e.target.value)
                                }
                                className="h-11 rounded-lg pl-10 text-sm"
                                disabled={busy}
                                required
                                minLength={MIN_PASSWORD_LENGTH}
                              />
                            </div>
                            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                              At least {MIN_PASSWORD_LENGTH} characters. We'll
                              email a 6-digit code to confirm your address.
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
                              {mode === "signup"
                                ? "Creating account…"
                                : "Signing in…"}
                            </>
                          ) : (
                            <>
                              {mode === "signup" ? "Create account" : "Sign in"}
                              <ArrowRight className="size-4" />
                            </>
                          )}
                        </Button>
                      </form>

                      <div className="mt-4 flex items-center justify-between gap-3 text-xs">
                        <button
                          type="button"
                          onClick={() => {
                            setError(null);
                            setStep({ kind: "forgot" });
                          }}
                          className="font-medium text-muted-foreground transition-colors hover:text-foreground"
                        >
                          Forgot password?
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setError(null);
                            setCode("");
                            setStep({
                              kind: "code",
                              email: email.trim(),
                              purpose: "sign-in",
                            });
                          }}
                          disabled={email.trim().length === 0}
                          title={
                            email.trim().length === 0
                              ? "Enter your email first"
                              : undefined
                          }
                          className="font-medium text-primary hover:underline disabled:opacity-40"
                        >
                          Email me a sign-in code
                        </button>
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
                          {step.purpose === "sign-in"
                            ? "Check your inbox"
                            : "Confirm your email"}
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

                        {step.purpose === "verify" && (
                          <p className="mt-4 text-center text-xs leading-relaxed text-muted-foreground">
                            Already have an account with this address?{" "}
                            <button
                              type="button"
                              onClick={() => {
                                setError(null);
                                setCode("");
                                setMode("signin");
                                setStep({ kind: "form" });
                              }}
                              disabled={busy}
                              className="font-medium text-primary hover:underline disabled:opacity-50"
                            >
                              Sign in with your password
                            </button>
                          </p>
                        )}

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

                  {step.kind === "forgot" && (
                    <>
                      <div className="flex flex-col items-center text-center">
                        <StepBadge>
                          <KeyRound className="size-5" />
                        </StepBadge>
                        <h2 className="font-display mt-4 text-2xl font-semibold tracking-tight">
                          Reset your password
                        </h2>
                        <p className="mt-1.5 text-sm text-foreground/80">
                          We'll email a 6-digit code to choose a new password.
                        </p>
                      </div>

                      <form onSubmit={handleForgotSubmit} className="mt-7">
                        <label
                          htmlFor="auth-forgot-email"
                          className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
                        >
                          Email address
                        </label>
                        <div className="relative mt-2">
                          <Mail className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            id="auth-forgot-email"
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

                        {error && <FormError message={error} />}

                        <Button
                          type="submit"
                          className="glow-accent mt-4 h-11 w-full rounded-lg text-sm font-semibold"
                          disabled={busy}
                        >
                          {isLoading ? (
                            <>
                              <Loader2 className="size-4 animate-spin" />
                              Sending code…
                            </>
                          ) : (
                            <>
                              Send reset code
                              <ArrowRight className="size-4" />
                            </>
                          )}
                        </Button>

                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            setError(null);
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

                  {step.kind === "reset" && (
                    <>
                      <div className="flex flex-col items-center text-center">
                        <StepBadge>
                          <KeyRound className="size-5" />
                        </StepBadge>
                        <h2 className="font-display mt-4 text-2xl font-semibold tracking-tight">
                          Choose a new password
                        </h2>
                        <p className="mt-1.5 text-sm text-foreground/80">
                          Enter the reset code we emailed you, then pick a new
                          password.
                        </p>
                        {emailPill(step.email)}
                      </div>

                      <form onSubmit={handleResetSubmit} className="mt-7">
                        {codeSlots}

                        <div className="mt-5">{passwordField}</div>

                        <label
                          htmlFor="auth-new-password-confirm"
                          className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
                        >
                          Confirm new password
                        </label>
                        <div className="relative mt-2">
                          <Lock className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            id="auth-new-password-confirm"
                            name="confirm-password"
                            type={showPassword ? "text" : "password"}
                            autoComplete="new-password"
                            placeholder="••••••••"
                            value={confirmPassword}
                            onChange={(e) =>
                              setConfirmPassword(e.target.value)
                            }
                            className="h-11 rounded-lg pl-10 text-sm"
                            disabled={busy}
                            required
                            minLength={MIN_PASSWORD_LENGTH}
                          />
                        </div>

                        {error && <FormError message={error} />}

                        <Button
                          type="submit"
                          className="glow-accent mt-4 h-11 w-full rounded-lg text-sm font-semibold"
                          disabled={busy || code.length !== 6}
                        >
                          {isLoading ? (
                            <>
                              <Loader2 className="size-4 animate-spin" />
                              Saving…
                            </>
                          ) : (
                            <>
                              Set new password
                              <CheckCircle2 className="size-4" />
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
