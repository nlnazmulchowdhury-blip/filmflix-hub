import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken, type ApiUser } from "@/lib/api";

export interface AuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: (ApiUser & { _id?: string }) | null;
  signIn: (step: string, formData: FormData) => Promise<void>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

/**
 * Same external contract as the Convex use-auth hook:
 *  - signIn("password", formData with email + password) → session (or error)
 *  - signIn("register", formData with email + password + name) → session
 *  - signIn("email-otp", formData with email) → sends the OTP (OtpSentSignal)
 *  - signIn("email-otp", formData with email + code) → verifies, stores token
 *  - signIn("forgot", formData with email) → mails a reset code (OtpSentSignal)
 *  - signIn("reset", formData with email + code + password) → session
 *  - signIn("anonymous", ...) → guest session
 */
export function useAuthCf(): AuthState {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!getToken()) {
        if (alive) { setUser(null); setIsLoading(false); }
        return;
      }
      try {
        const res = await api.get<{ user: ApiUser | null }>("/auth/me");
        if (alive) { setUser(res.user); setIsLoading(false); }
      } catch {
        setToken(null);
        if (alive) { setUser(null); setIsLoading(false); }
      }
    })();
    return () => { alive = false; };
  }, []);

  const acceptSession = useCallback(async (token: string) => {
    setToken(token);
    const me = await api.get<{ user: ApiUser | null }>("/auth/me");
    setUser(me.user);
  }, []);

  /* Role changes happen server-side only (the admin-code unlock, for one), so
     the UI has to re-read /auth/me to notice them. */
  const refreshUser = useCallback(async () => {
    try {
      const me = await api.get<{ user: ApiUser | null }>("/auth/me");
      setUser(me.user);
    } catch {
      // A blip here must not sign the visitor out — keep the cached user.
    }
  }, []);

  const signIn = useCallback(async (provider: string, formData: FormData) => {
    const email = formData.get("email") as string | null;
    const code = formData.get("code") as string | null;
    const password = formData.get("password") as string | null;
    const name = formData.get("name") as string | null;

    if (formData.get("guest") === "1" || (!email && !code && !password)) {
      const res = await api.post<{ token: string }>("/auth/guest");
      setToken(res.token);
      const me = await api.get<{ user: ApiUser | null }>("/auth/me");
      setUser(me.user);
      return;
    }

    switch (provider) {
      case "password": {
        const res = await api.post<{ token: string }>("/auth/login", { email, password });
        await acceptSession(res.token);
        return;
      }
      case "register": {
        const res = await api.post<{ token: string }>("/auth/register", { email, password, name });
        await acceptSession(res.token);
        return;
      }
      case "forgot": {
        await api.post("/auth/forgot", { email });
        throw new OtpSentSignal();
      }
      case "reset": {
        const res = await api.post<{ token: string }>("/auth/reset", { email, code, password });
        await acceptSession(res.token);
        return;
      }
      case "email-otp":
      default: {
        if (!code) {
          await api.post("/auth/request-otp", { email });
          throw new OtpSentSignal();
        }
        const res = await api.post<{ token: string }>("/auth/verify-otp", { email, code });
        await acceptSession(res.token);
        return;
      }
    }
  }, [acceptSession]);

  const signOut = useCallback(async () => {
    try { await api.post("/auth/sign-out"); } catch { /* ignore */ }
    setToken(null);
    setUser(null);
  }, []);

  return {
    isLoading,
    isAuthenticated: user !== null,
    user: user ? { ...user, _id: user.id } : null,
    signIn,
    signOut,
    refreshUser,
  };
}

/** Auth.tsx currently treats any thrown error as "OTP sent" and moves to the
 *  code step. This tiny marker keeps that flow working without rewriting the
 *  page — the message is never shown. */
export class OtpSentSignal extends Error {
  constructor() {
    super("otp-sent");
    this.name = "OtpSentSignal";
  }
}
