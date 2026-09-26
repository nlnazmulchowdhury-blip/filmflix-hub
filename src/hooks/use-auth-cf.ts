import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken, type ApiUser } from "@/lib/api";

export interface AuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: (ApiUser & { _id?: string }) | null;
  signIn: (step: string, formData: FormData) => Promise<void>;
  signOut: () => Promise<void>;
}

/**
 * Same external contract as the Convex use-auth hook:
 *  - signIn("email-otp", formData with email) → sends the OTP
 *  - signIn("email-otp", formData with email + code) → verifies, stores token
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

  const signIn = useCallback(async (_provider: string, formData: FormData) => {
    const email = formData.get("email") as string | null;
    const code = formData.get("code") as string | null;
    if (formData.get("guest") === "1" || (!email && !code)) {
      const res = await api.post<{ token: string }>("/auth/guest");
      setToken(res.token);
      const me = await api.get<{ user: ApiUser | null }>("/auth/me");
      setUser(me.user);
      return;
    }
    if (!code) {
      await api.post("/auth/request-otp", { email });
      throw new OtpSentSignal();
    }
    const res = await api.post<{ token: string }>("/auth/verify-otp", { email, code });
    setToken(res.token);
    const me = await api.get<{ user: ApiUser | null }>("/auth/me");
    setUser(me.user);
  }, []);

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
