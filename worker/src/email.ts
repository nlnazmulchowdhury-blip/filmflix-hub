import type { Bindings } from "./index";

/**
 * OTP delivery. Uses the same freebuff.com email service the app already
 * relies on for Convex auth — no new provider needed.
 */
export async function sendOtpEmail(
  env: Bindings,
  email: string,
  otp: string,
): Promise<void> {
  const res = await fetch("https://auth.freebuff.app/send_otp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "fb_email_2crN1hqIArZP2bEfvjp5Qik4",
    },
    body: JSON.stringify({
      to: email,
      otp,
      appName: env.OTP_FROM_NAME || "FilmFlix",
    }),
  });
  if (!res.ok) {
    throw new Error(`OTP email failed (${res.status})`);
  }
}
