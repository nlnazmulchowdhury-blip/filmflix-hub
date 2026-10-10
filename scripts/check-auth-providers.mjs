#!/usr/bin/env node
/**
 * Report what a Convex deployment actually has for each auth provider, and the
 * exact callback URI each one must be registered with.
 *
 * Needs no Convex account or deploy key: it walks the same two public hops the
 * browser takes —
 *   1. POST the `auth:signIn` action   → "is not configured" means the deployed
 *      `src/convex/auth.ts` does not register that provider at all (stale
 *      backend, `npx convex deploy` needed), whereas a real authorize URL means
 *      the code is there;
 *   2. GET the site-side sign-in URL   → the redirect it answers points at the
 *      provider with `client_id` and `redirect_uri`. `client_id=undefined`
 *      means the code is deployed but AUTH_<PROVIDER>_ID / _SECRET are unset.
 *
 * Usage:
 *   node scripts/check-auth-providers.mjs https://energetic-pig-301.convex.cloud
 *   node scripts/check-auth-providers.mjs http://127.0.0.1:3210 http://127.0.0.1:3211
 */

const CLOUD = process.argv[2];
if (!CLOUD) {
  console.error(
    "usage: node scripts/check-auth-providers.mjs <convex-url> [convex-site-url]",
  );
  process.exit(2);
}
const SITE = process.argv[3] ?? CLOUD.replace(".convex.cloud", ".convex.site");

/** Providers the app registers, with the env vars each OAuth one needs. */
const PROVIDERS = [
  { id: "anonymous", oauth: false },
  { id: "email-otp", oauth: false },
  { id: "password", oauth: false },
  { id: "google", oauth: true },
  { id: "github", oauth: true },
  { id: "facebook", oauth: true },
  { id: "apple", oauth: true },
];

const envVarName = (id) => `AUTH_${id.toUpperCase()}_ID`;

/** Step 1: does the deployment's auth config contain this provider? */
async function startSignIn(provider) {
  const res = await fetch(`${CLOUD}/api/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Convex-Client": "cli-1.0.0" },
    body: JSON.stringify({
      path: "auth:signIn",
      args: { provider, params: { redirectTo: "/" } },
      format: "json",
    }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { state: "unknown", detail: text.slice(0, 100) };
  }
  if (body.status === "success") {
    return { state: "registered", redirect: body.value?.redirect };
  }
  const message = String(body.errorMessage ?? "");
  if (/is not configured/.test(message)) return { state: "MISSING" };
  // Any other error means the provider exists and rejected the empty params.
  return { state: "registered" };
}

/** Step 2: follow the site sign-in URL to see the provider's own redirect. */
async function inspectProviderRedirect(url) {
  const res = await fetch(url, { redirect: "manual" });
  const location = res.headers.get("location");
  if (!location) return { state: "no-redirect", status: res.status };
  const query = new URLSearchParams(location.split("?")[1] ?? "");
  return {
    state: query.get("client_id") === "undefined" ? "no-credentials" : "ready",
    host: new URL(location).host,
    redirectUri: query.get("redirect_uri") ?? undefined,
  };
}

console.log(`deployment : ${CLOUD}`);
console.log(`site       : ${SITE}\n`);

let missingCode = 0;
let missingCreds = 0;
const callbacks = [];

for (const { id, oauth } of PROVIDERS) {
  const start = await startSignIn(id);
  if (start.state === "MISSING") {
    missingCode += 1;
    console.log(`MISSING       ${id}`);
    if (oauth) callbacks.push(`${SITE}/api/auth/callback/${id}`);
    continue;
  }
  if (!oauth || !start.redirect) {
    console.log(`registered    ${id}`);
    continue;
  }
  const detail = await inspectProviderRedirect(start.redirect);
  if (detail.state === "no-credentials") {
    missingCreds += 1;
    console.log(
      `no creds      ${id}   set ${envVarName(id)} / AUTH_${id.toUpperCase()}_SECRET (deployment env)`,
    );
  } else {
    console.log(
      `ready         ${id}   -> ${detail.host}   callback registered with the provider: ${detail.redirectUri}`,
    );
  }
  callbacks.push(`${SITE}/api/auth/callback/${id}`);
}

if (callbacks.length) {
  console.log("\ncallback URLs this deployment uses (register these at each provider):");
  for (const url of [...new Set(callbacks)]) console.log(`  ${url}`);
}

console.log(
  missingCode
    ? `\n${missingCode} provider(s) missing from the deployment — it runs older code: run \`npx convex deploy\`.`
    : missingCreds
      ? `\nCode is current; ${missingCreds} provider(s) still need their AUTH_* credentials set on the deployment.`
      : "\nAll providers are registered and configured on this deployment.",
);
