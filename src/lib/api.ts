/**
 * FilmFlix API client — talks to the Cloudflare Worker (D1) backend.
 * Session token lives in localStorage; the worker enforces roles.
 *
 * There is no fixed base URL here any more: every call goes through
 * `fetchWithFailover()` (lib/apiConfig.ts), which asks whichever Worker is
 * answering first and falls over to the other account on a 429, a 5xx or a
 * dead socket — on the request the viewer was making anyway, never a probe.
 *
 * Falling back to "" (same-origin) serves the Pages SPA for every API
 * call — the browser asked for /movies and got index.html (405/HTML).
 */

import { fetchWithFailover } from "./apiConfig";

const TOKEN_KEY = "ff-session-token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = getToken();
  const res = await fetchWithFailover(path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  /* Pages answers any unknown path with index.html. When that happens the
     call never reached the Worker (stale cached bundle, wrong base URL), and
     "Unexpected token '<'" is what the JSON parse would have reported. */
  if (text.trimStart().startsWith("<")) {
    throw new ApiError(
      res.status,
      "The API returned a web page instead of data (status " +
        res.status +
        " for " +
        path +
        ") — a stale bundle or wrong API origin. Hard-reload (Ctrl+Shift+R).",
    );
  }
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export interface ApiUser {
  id: string;
  email: string | null;
  name: string | null;
  role: string | null;
  isAnonymous: boolean;
}
