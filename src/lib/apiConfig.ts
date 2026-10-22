/**
 * Three Workers, one site.
 *
 * Every call the front end makes goes through `fetchWithFailover()` here, so a
 * spent or broken account cannot take the site down: the request the viewer was
 * making anyway is the health check, and the next backend only answers when the
 * one before it refuses it. That is why this costs no extra requests — there is
 * no ping, no heartbeat, no parallel race.
 *
 * The viewer's address never moves: this is still filmbd.pages.dev asking a
 * `*.workers.dev` host for JSON, and the page only ever re-points its own fetch.
 *
 * To move a backend (rename the Worker, new account), change its `url` and
 * nothing else.
 */

export interface ApiBackend {
  name: string;
  url: string;
}

/** `VITE_API_BASE` still wins, so a preview build can point somewhere else. */
const PRIMARY_URL = import.meta.env.VITE_API_BASE?.trim()
  ? import.meta.env.VITE_API_BASE.trim()
  : "https://filmflix-hub.nlnazmulchowdhury.workers.dev";
/** Same escape hatch for the backup — this is how the failover harness gets a
 *  pair of throwaway servers to break instead of the real accounts. */
const BACKUP_URL = import.meta.env.VITE_API_BACKUP?.trim()
  ? import.meta.env.VITE_API_BACKUP.trim()
  : "https://filmbd.nazmul416300.workers.dev";
/** The third account. Free-tier Workers cap out per account, so a third pair of
 *  hands is what actually doubles the site's headroom; it also means a viewer
 *  still gets served when two accounts are down at once. */
const CINEMA_URL = import.meta.env.VITE_API_CINEMA?.trim()
  ? import.meta.env.VITE_API_CINEMA.trim()
  : "https://filmbd1.filmbdcine.workers.dev";

const trim = (u: string) => u.replace(/\/+$/, "");

/** Order matters: index 0 is who gets the first look after the rotation. */
export const API_BACKENDS: ApiBackend[] = [
  { name: "primary", url: trim(PRIMARY_URL) },
  { name: "backup", url: trim(BACKUP_URL) },
  { name: "cinema", url: trim(CINEMA_URL) },
];

const PICK_KEY = "ff-api-backend";

/** How long a working backend keeps its place before the primary gets another
 *  turn. Without this a single bad hour would pin every viewer to the backup
 *  for the rest of the day, and the account we are trying to relieve would
 *  never be tried again. */
export const ROTATE_MS = 60 * 60_000;

/** Long enough for a cold Worker and a D1 read, short enough that a hung
 *  Worker does not leave the page staring at a spinner. */
const ATTEMPT_TIMEOUT_MS = 20_000;

interface Pick {
  name: string;
  at: number;
}

function readPick(): Pick | null {
  try {
    const raw = localStorage.getItem(PICK_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Pick;
    return API_BACKENDS.some((b) => b.name === p.name) && typeof p.at === "number"
      ? p
      : null;
  } catch {
    return null;
  }
}

/** Written when the choice changes, and once per rotation besides: the hour
 *  starts again from whoever just answered, so a burst of concurrent calls does
 *  not each decide the primary still deserves another try. */
function writePick(backend: ApiBackend) {
  try {
    localStorage.setItem(PICK_KEY, JSON.stringify({ name: backend.name, at: Date.now() }));
  } catch {
    /* Private mode: failover still works, it just re-decides next load. */
  }
}

function remember(backend: ApiBackend) {
  const stored = readPick();
  if (!stored || stored.name !== backend.name || Date.now() - stored.at > ROTATE_MS) {
    writePick(backend);
  }
}

/** The backend a call should start on: whoever worked last, unless the primary
 *  is owed another turn. */
export function activeBackend(): ApiBackend {
  const pick = readPick();
  if (!pick) return API_BACKENDS[0];
  if (Date.now() - pick.at > ROTATE_MS) return API_BACKENDS[0];
  return API_BACKENDS.find((b) => b.name === pick.name) ?? API_BACKENDS[0];
}

/** For anything that builds a URL instead of fetching it — a `<video>` source,
 *  an hls.js manifest, a download. Those cannot fail over mid-stream, so they
 *  are pointed at whichever backend is live when playback starts. */
export function apiBase(): string {
  return activeBackend().url;
}

/** 429 = this account is spent for now, 5xx = this account is broken. Anything
 *  else (401, 403, 404, 400) is an answer about the request, and the other
 *  account would give exactly the same one — so it is returned, not retried. */
function isBackendTrouble(status: number): boolean {
  return status === 429 || status >= 500;
}

function abortedByCaller(err: unknown): boolean {
  return (err as { name?: string })?.name === "AbortError";
}

/** Both deadlines at once: the caller's, if it brought one, and ours. */
function withDeadline(caller: AbortSignal | null): AbortSignal {
  const deadline = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
  if (!caller) return deadline;
  /* AbortSignal.any is newer than most of the browsers this site gets, and a
     call that brings its own signal can live without our extra deadline. */
  return typeof AbortSignal.any === "function"
    ? AbortSignal.any([caller, deadline])
    : caller;
}

/** One viewer mounts a dozen queries on a single page load. When the hour turns
 *  over, only the first of them re-asks the primary; the rest keep using the
 *  backend that was working. Otherwise a spent account would take a dozen 429s
 *  an hour per viewer — the exact requests this whole file exists to save. */
let rotationInFlight = false;

/**
 * Fetch `path` against the backends, in order, without spending a request on
 * health checks.
 *
 * A request that already carried a body is only repeated when the backend
 * *answered* with 429/5xx — an order the Worker refused. If the socket died or
 * the attempt timed out, the write may have landed, and repeating it would
 * double it, so the error is thrown instead.
 */
export async function fetchWithFailover(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const saved = readPick();
  const rotate = !!saved && Date.now() - saved.at > ROTATE_MS;
  const leads = rotate && !rotationInFlight;
  if (leads) rotationInFlight = true;
  /* Someone else is already re-trying the primary, so this call keeps using the
     backend that worked. `activeBackend()` would send it to the primary too. */
  const first =
    saved && rotate && !leads
      ? API_BACKENDS.find((b) => b.name === saved.name) ?? API_BACKENDS[0]
      : activeBackend();
  const order = [first, ...API_BACKENDS.filter((b) => b.name !== first.name)];
  const method = (init.method ?? "GET").toUpperCase();
  const wrote = method !== "GET" && method !== "HEAD";
  const caller = init.signal ?? null;
  let lastError: unknown;

  try {
    for (let i = 0; i < order.length; i++) {
      const backend = order[i];
      if (i > 0)
        console.warn(`[api] ${order[i - 1].name} refused ${method} ${path}, asking ${backend.name}`);
      try {
        const res = await fetch(`${backend.url}${path}`, {
          ...init,
          signal: withDeadline(caller),
        });
        if (!isBackendTrouble(res.status)) {
          remember(backend);
          return res;
        }
        /* Nothing downstream will read a body we are throwing away. */
        void res.body?.cancel().catch(() => undefined);
        lastError = new Error(`${backend.name} answered ${res.status} for ${method} ${path}`);
      } catch (err) {
        if (caller?.aborted) {
          /* The page navigated away or its own deadline fired. That is the
             caller's decision, not an outage — asking the other account would be
             a request nobody is waiting for. */
          throw err instanceof Error ? err : new Error(`${method} ${path} was cancelled`);
        }
        if (wrote) {
          /* No answer, so nothing separates a connection refused before the body
             left from one the Worker took, wrote to D1, and never replied on.
             Repeating the second case duplicates an order, so a write only moves
             account when a backend answered it with 429/5xx. */
          throw new Error(
            `${backend.name} did not answer ${method} ${path} and the request may have landed, ` +
              `so it was not resent to the ${order[i + 1]?.name ?? "other"} backend` +
              (abortedByCaller(err) ? ` (waited ${ATTEMPT_TIMEOUT_MS / 1000}s)` : ""),
          );
        }
        lastError = abortedByCaller(err)
          ? new Error(`No API backend answered ${method} ${path} within ${ATTEMPT_TIMEOUT_MS / 1000}s`)
          : err;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Every API backend refused this call");
  } finally {
    if (leads) rotationInFlight = false;
  }
}
