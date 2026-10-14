/**
 * Local override of "convex/react".
 *
 * Vite aliases `convex/react` here (see vite.config.ts), so every existing
 * `import { useQuery, useMutation, useAction } from "convex/react"` now runs
 * on the Worker REST client without touching the components. ConvexAuthState
 * exports that the auth provider used are no-ops — auth goes through
 * @/hooks/use-auth-cf now.
 */

export { useQuery, useMutation, useAction, makeApiProxy } from "@/lib/rest-client";

/* ---- no-op auth hooks (the ConvexAuthProvider is gone) ---- */

export function useConvexAuth() {
  return { isLoading: false, isAuthenticated: false };
}

export const Authenticated = (p: { children?: unknown }) => null;
export const Unauthenticated = (p: { children?: unknown }) => null;
export const AuthLoading = (p: { children?: unknown }) => null;
export const ConvexAuthProvider = (p: { children?: unknown; client?: unknown }) => null;
export const ConvexProviderWithAuth = (p: { children?: unknown }) => p.children ?? null;
export function useConvex() {
  return null as unknown;
}
export function ConvexReactClient() {
  return null as unknown;
}
