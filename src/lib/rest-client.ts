/**
 * Convex-shaped client shim on top of the Worker REST API.
 *
 * The 40+ existing components import `useQuery` / `useMutation` / `useAction`
 * from "convex/react" and call `api.<module>.<fn>()`. Replacing all of those
 * call shapes page by page would be a huge, error-prone rewrite — instead
 * this module keeps the same call signatures but routes every call to the
 * Worker over HTTP:
 *
 *   useQuery(api.movies.list)      → GET  /movies            (reactive-ish re-poll)
 *   useMutation(api.orders.create) → POST /orders
 *   useAction(api.vidsrc.search)   → GET  /vidsrc/search?q=…
 *
 * The Worker paths live in WORKER_MAP below. Anything unmapped is a
 * programming error: DEV-only loud reference so a missing route is caught
 * during development, and a rejected promise in production.
 *
 * `useQuery` refetches on mount + focus + every REFRESH_MS while the tab is
 * visible — not Convex's websocket granularity, but plenty for a catalog,
 * watchlist and admin panels (the Worker had no live subscriptions either in
 * its Convex mode? it did; the pages refreshed on route change only).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api as restApi, getToken } from "./api";

const BASE = import.meta.env.VITE_API_BASE ?? "";
const REFRESH_MS = 30_000;

export class NotImplementedError extends Error {
  constructor(fn: string) {
    super(`No Worker route mapped for ${fn}`);
    this.name = "NotImplementedError";
  }
}

/** Every function the UI can reach, with its REST call. Key: `module.fn`. */
export const WORKER_MAP: Record<
  string,
  { method: "GET" | "POST" | "PATCH" | "DELETE"; path: (args?: any) => string; body?: (args?: any) => unknown; action?: boolean }
> = {
  /* auth (sign-in handled by use-auth-cf directly) */
  "users.currentUser": { method: "GET", path: () => "/auth/me", body: (a) => a?.user, action: false },

  /* movies */
  "movies.list": { method: "GET", path: () => "/movies" },
  "movies.get": { method: "GET", path: (a) => `/movies/${a?.id ?? a}` },
  "movies.add": { method: "POST", path: () => "/movies", body: (a) => a },
  "movies.update": { method: "PATCH", path: (a) => `/movies/${a?.id}`, body: (a) => a },
  "movies.remove": { method: "DELETE", path: (a) => `/movies/${a?.id ?? a}` },
  "movies.moveToTop": { method: "PATCH", path: (a) => `/movies/${a?.id}`, body: () => ({ toTop: true }) },
  "movies.moveInOrder": { method: "PATCH", path: (a) => `/movies/${a?.id}`, body: (a) => ({ move: a?.dir }) },
  "movies.removeCategory": { method: "POST", path: () => "/movies/remove-category", body: (a) => a },
  "movies.verifyAdminCode": { method: "POST", path: () => "/movies/verify-admin-code", body: (a) => a },
  "movies.listByContributor": { method: "GET", path: (a) => `/movies?contributorId=${a?.userId ?? ""}` },

  /* categories */
  "categories.listAll": { method: "GET", path: () => "/categories" },
  "categories.create": { method: "POST", path: () => "/categories", body: (a) => a },
  "categories.remove": { method: "DELETE", path: (a) => `/categories/${a?.id ?? a}` },

  /* tv channels */
  "tvChannels.list": { method: "GET", path: () => "/tv/channels" },
  "tvChannels.add": { method: "POST", path: () => "/tv/channels", body: (a) => a },
  "tvChannels.update": { method: "PATCH", path: (a) => `/tv/channels/${a?.id}`, body: (a) => a },
  "tvChannels.remove": { method: "DELETE", path: (a) => `/tv/channels/${a?.id ?? a}` },

  /* tv categories */
  "tvCategories.listAll": { method: "GET", path: () => "/tv/categories" },
  "tvCategories.create": { method: "POST", path: () => "/tv/categories", body: (a) => a },
  "tvCategories.rename": { method: "PATCH", path: (a) => `/tv/categories/${a?.id}`, body: (a) => ({ name: a?.name }) },
  "tvCategories.remove": { method: "DELETE", path: (a) => `/tv/categories/${a?.id ?? a}` },

  /* comments */
  "comments.listByMovie": { method: "GET", path: (a) => `/movies/${a?.movieId ?? a}/comments` },
  "comments.listAll": { method: "GET", path: () => "/comments" },
  "comments.add": { method: "POST", path: (a) => `/movies/${a?.movieId}/comments`, body: (a) => ({ text: a?.text }) },
  "comments.remove": { method: "DELETE", path: (a) => `/comments/${a?.id ?? a}` },

  /* screenings */
  "screenings.listMine": { method: "GET", path: () => "/screenings/mine" },
  "screenings.listAll": { method: "GET", path: () => "/screenings" },
  "screenings.schedule": { method: "POST", path: () => "/screenings", body: (a) => a },
  "screenings.cancel": { method: "DELETE", path: (a) => `/screenings/${a?.id ?? a}` },

  /* orders */
  "orders.listMine": { method: "GET", path: () => "/orders/mine" },
  "orders.listAll": { method: "GET", path: () => "/orders" },
  "orders.create": { method: "POST", path: () => "/orders", body: (a) => a },
  "orders.markPaid": { method: "POST", path: (a) => `/orders/${a?.orderId ?? a?.id}/mark-paid`, body: (a) => a },

  /* watchlist */
  "watchlist.listMine": { method: "GET", path: () => "/watchlist" },
  "watchlist.hasMovie": { method: "GET", path: (a) => `/watchlist/${a?.movieId ?? a}`, action: false },
  "watchlist.add": { method: "POST", path: (a) => `/watchlist/${a?.movieId ?? a}` },
  "watchlist.remove": { method: "DELETE", path: (a) => `/watchlist/${a?.movieId ?? a}` },

  /* support */
  "support.listMine": { method: "GET", path: () => "/support/mine" },
  "support.unreadForUser": { method: "GET", path: () => "/support/unread-for-user", body: (a) => a?.count },
  "support.sendFromUser": { method: "POST", path: () => "/support/send-from-user", body: (a) => a },
  "support.editFromUser": { method: "PATCH", path: (a) => `/support/from-user/${a?.messageId}`, body: (a) => ({ text: a?.text }) },
  "support.deleteFromUser": { method: "DELETE", path: (a) => `/support/from-user/${a?.messageId ?? a}` },
  "support.markSeenByUser": { method: "POST", path: () => "/support/mark-seen-by-user" },
  "support.listConversations": { method: "GET", path: () => "/support/conversations" },
  "support.unreadForAdmin": { method: "GET", path: () => "/support/unread-for-admin", body: (a) => a?.count },
  "support.listThread": { method: "GET", path: (a) => `/support/thread/${a?.userId}` },
  "support.replyFromAdmin": { method: "POST", path: () => "/support/reply-from-admin", body: (a) => a },
  "support.editAsAdmin": { method: "PATCH", path: (a) => `/support/as-admin/${a?.messageId}`, body: (a) => ({ text: a?.text }) },
  "support.deleteAsAdmin": { method: "DELETE", path: (a) => `/support/as-admin/${a?.messageId ?? a}` },
  "support.markSeenByAdmin": { method: "POST", path: () => "/support/mark-seen-by-admin", body: (a) => a },

  /* admin */
  "admin.listUsers": { method: "GET", path: () => "/admin/users" },
  "admin.setRole": { method: "PATCH", path: (a) => `/admin/users/${a?.userId}/role`, body: (a) => ({ role: a?.role }) },

  /* analytics */
  "analytics.summary": { method: "GET", path: () => "/analytics/summary" },
  "analytics.track": { method: "POST", path: () => "/analytics/track", body: (a) => a },

  /* shortlinks */
  "shortlinks.expandBatch": { method: "POST", path: () => "/shortlinks/expand-batch", body: (a) => a, action: true },
  "shortlinks.migrateAllShortLinks": { method: "POST", path: () => "/shortlinks/migrate", action: true },

  /* link health */
  "linkHealth.summary": { method: "GET", path: () => "/link-health/summary" },
  "linkHealth.checkAll": { method: "POST", path: () => "/link-health/check", action: true },
  "linkHealth.setIgnored": { method: "PATCH", path: () => "/link-health/ignored", body: (a) => a },

  /* vidsrc */
  "vidsrc.search": { method: "GET", path: (a) => `/vidsrc/search?q=${encodeURIComponent(a?.q ?? "")}`, action: true },

  /* dubbing */
  "dubbing.listJobsForMovie": { method: "GET", path: (a) => `/dubbing/jobs/${a?.movieId ?? a}` },
  "dubbing.startDub": { method: "POST", path: () => "/dubbing/jobs", body: (a) => a },
  "dubbing.submitDub": { method: "POST", path: (a) => `/dubbing/jobs/${a?.jobId}/submit`, action: true },
  "dubbing.pollDub": { method: "POST", path: (a) => `/dubbing/jobs/${a?.jobId}/poll`, action: true },
  "dubbing.finishDubManually": { method: "POST", path: (a) => `/dubbing/jobs/${a?.jobId}/finish-manually`, body: (a) => a },
  "dubbing.removeDubFromMovie": { method: "DELETE", path: (a) => `/movies/${a?.movieId}/dubs/${encodeURIComponent(a?.label ?? "")}` },
  "dubbing.setJobStatus": { method: "PATCH", path: (a) => `/dubbing/jobs/${a?.jobId}`, body: (a) => a },
  "dubbing.removeJob": { method: "DELETE", path: (a) => `/dubbing/jobs/${a?.jobId}` },

  /* provider import panel (movieApi / elaach / movieBox) */
  "movieApi.getSettings": { method: "GET", path: () => "/provider/settings" },
  "movieApi.probeAction": { method: "POST", path: () => "/provider/probe", body: (a) => a, action: true },
  "movieApi.searchAction": { method: "POST", path: () => "/provider/search", body: (a) => a, action: true },
  "movieApi.importMovie": { method: "POST", path: () => "/provider/import", body: (a) => a },
  "elaach.searchAction": { method: "POST", path: () => "/provider/elaach/search", body: (a) => a, action: true },
  "elaach.importMovie": { method: "POST", path: () => "/provider/elaach/import", body: (a) => a, action: true },
  "movieBox.searchAction": { method: "POST", path: () => "/provider/moviebox/search", body: (a) => a, action: true },
  "movieBox.importMovie": { method: "POST", path: () => "/provider/moviebox/import", body: (a) => a, action: true },

  /* video uploads (R2) */
  "videoUpload.createUploadUrl": { method: "POST", path: () => "/uploads/url", action: true },
  "videoUpload.finishUpload": { method: "POST", path: () => "/uploads/finish", body: (a) => a, action: true },
};

const pending = { read: new Map<string, Promise<any>>() };

/** The REST call behind every shimmed hook. Route table drives it. */
export async function callWorker<T = any>(key: string, args?: any): Promise<T> {
  const route = WORKER_MAP[key];
  if (!route) {
    throw new NotImplementedError(key);
  }
  const method = route.method;
  const url = `${BASE}${route.path(args)}`;
  const token = getToken();
  const hasBody = method === "POST" || method === "PATCH" || method === "DELETE";
  const res = await fetch(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(hasBody && route.body ? { "content-type": "application/json" } : {}),
    },
    body: hasBody && route.body ? JSON.stringify(route.body(args)) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Worker returned non-JSON for ${key}: ${text.slice(0, 160)}`);
    }
  }
  if (!res.ok) {
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  return data;
}
const call = callWorker;

void restApi; // unused for now; kept for future direct fetches

export function useQuery<T = any>(
  fn: { __key: string } | string,
  ...args: unknown[]
): T[] | T | undefined {
  const key = typeof fn === "string" ? fn : (fn as any).__key;
  const arg0 = args[0];
  const skipped = arg0 === "skip";
  const argsKey = JSON.stringify(skipped ? null : (arg0 ?? null));
  const [state, setState] = useState<{ data: any; loading: boolean }>({
    data: undefined,
    loading: !skipped,
  });

  const load = useCallback(async (force = false) => {
    if (skipped) return;
    const cacheKey = `${key}${argsKey}`;
    if (!force && pending.read.has(cacheKey)) {
      const data = await pending.read.get(cacheKey)!;
      setState({ data, loading: false });
      return;
    }
    const prom = call(key, args[0]).catch((err) => {
      pending.read.delete(cacheKey);
      throw err;
    });
    pending.read.set(cacheKey, prom);
    try {
      const data = await prom;
      setState({ data, loading: false });
    } catch (err) {
      console.warn(`query ${key} failed:`, err);
      setState({ data: undefined, loading: false });
    }
  }, [key, argsKey, skipped]);

  useEffect(() => {
    void load(true);
    if (skipped) return;
    const onFocus = () => void load(true);
    window.addEventListener("focus", onFocus);
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, REFRESH_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(t);
    };
  }, [load]);

  return state.data;
}

/** Mutation: a callable that mirrors the Convex useMutation contract. */
export function useMutation(
  fn: { __key: string } | string,
): <T = any>(args?: any) => Promise<T> {
  const key = typeof fn === "string" ? fn : (fn as any).__key;
  return useCallback(
    async <T = any,>(args?: any): Promise<T> => {
      const data = await call(key, args);
      // Cache-bust so dependent queries refetch on their next tick.
      pending.read.clear();
      return (data && typeof data === "object" && "result" in data ? data.result : data) as T;
    },
    [key],
  );
}

/** Action: identical callable contract; useAction just marks long calls. */
export function useAction(
  fn: { __key: string } | string,
): <T = any>(args?: any) => Promise<T> {
  const key = typeof fn === "string" ? fn : (fn as any).__key;
  return useCallback(async <T = any,>(args?: any): Promise<T> => {
    const data = await call(key, args);
    pending.read.clear();
    return (data && typeof data === "object" && "result" in data ? data.result : data) as T;
  }, [key]);
}

/** Give `api.*` references the __key our shim dispatches on. The proxy keeps
 *  `api.movies.list` working without a hand-written module file. */
export function makeApiProxy(): any {
  const cache = new Map<string, any>();
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, moduleProp: string) {
      if (typeof moduleProp !== "string") return undefined;
      if (!cache.has(moduleProp)) {
        cache.set(
          moduleProp,
          new Proxy(
            {},
            {
              get(_t2, fnProp: string) {
                const key = `${moduleProp}.${fnProp}`;
                return Object.assign(async () => void 0, { __key: key });
              },
            },
          ),
        );
      }
      return cache.get(moduleProp);
    },
  };
  return new Proxy({}, handler);
}
