"use client";

/**
 * useAuth — app-wide auth hook.
 *
 * Backend is the Worker now (@/hooks/use-auth-cf: email-OTP + guest), but
 * this file keeps the exact same external contract so all pages stay
 * untouched. The Convex-era signIn(provider, formData) signature is kept:
 * Auth.tsx calls signIn("email-otp", formData) and OtpSentSignal-driven
 * flow control is preserved by useAuthCf.
 */
export { useAuthCf as useAuth } from "@/hooks/use-auth-cf";
export { OtpSentSignal } from "@/hooks/use-auth-cf";
