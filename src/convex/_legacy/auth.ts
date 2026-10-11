// THIS FILE IS READ ONLY. Do not touch this file unless you are correctly adding a new auth provider in accordance to the vly auth documentation

import Apple from "@auth/core/providers/apple";
import Facebook from "@auth/core/providers/facebook";
import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { Email } from "@convex-dev/auth/providers/Email";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { RandomReader, generateRandomString } from "@oslojs/crypto/random";
import { emailOtp } from "./auth/emailOtp";

/** Same shape as the sign-in codes: six digits, no letters. */
function generateSixDigitCode() {
  const random: RandomReader = {
    read(bytes: Uint8Array) {
      crypto.getRandomValues(bytes);
    },
  };
  return generateRandomString(random, "0123456789", 6);
}

/**
 * Codes for the password flows (email verification, password reset) go out
 * through the very same transactional mailer the email sign-in provider uses
 * — only the provider id differs, so a reset code can never be replayed as a
 * sign-in code (or the other way around).
 */
const passwordCodeEmail = (id: string, name: string) =>
  Email({
    id,
    name,
    maxAge: 60 * 15, // 15 minutes
    generateVerificationToken: generateSixDigitCode,
    sendVerificationRequest: emailOtp.sendVerificationRequest,
  });

/** Deliberately permissive: the real check is the mailbox round-trip. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    emailOtp,
    Anonymous,
    /**
     * Email + password sign-in. `verify` mails a code before a brand new
     * password account becomes usable — that also links the password to an
     * existing account with the same email (e.g. someone who signed in with a
     * code before) instead of creating a duplicate user. `reset` powers
     * "forgot password" with the same kind of 6-digit code.
     */
    Password({
      verify: passwordCodeEmail("password-verify", "FilmFlix verification"),
      reset: passwordCodeEmail("password-reset", "FilmFlix password reset"),
      profile: (params) => {
        const email =
          typeof params.email === "string"
            ? params.email.trim().toLowerCase()
            : "";
        if (!EMAIL_PATTERN.test(email)) {
          throw new Error("Enter a valid email address");
        }
        // Only the email is stored: display names stay user-editable.
        return { email };
      },
    }),
    /**
     * OAuth sign-in. Every provider reads its credentials from the deployment
     * environment (AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET, AUTH_FACEBOOK_ID /
     * AUTH_FACEBOOK_SECRET, AUTH_APPLE_ID / AUTH_APPLE_SECRET,
     * AUTH_GITHUB_ID / AUTH_GITHUB_SECRET); a provider whose credentials are
     * missing refuses to start a flow instead of failing halfway through.
     *
     * Apple is pickier than the rest: AUTH_APPLE_SECRET must be the ES256 JWT
     * generated from an Apple private key (`npx auth add apple`), the callback
     * must be HTTPS (Apple rejects localhost), and it only ever sends the user's
     * name on the very first consent.
     */
    Google,
    Facebook,
    Apple,
    GitHub,
  ],
});
