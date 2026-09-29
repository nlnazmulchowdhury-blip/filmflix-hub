/**
 * Auto-refresh for IP-bound HLS streams (vidbox/vidsrc-style hosts).
 *
 * The stream host issues a per-viewer JWT whose payload pins an IP CIDR
 * (e.g. "103.127.5.0/24") and expires after 4 hours. The playlist and all
 * segment URLs embed `?token=<jwt>` — playback dies when the token expires.
 *
 * 1. `/generate.php` on the stream host answers with `Access-Control-Allow-
 *    Origin: *`, so the BROWSER fetches a token bound to the viewer's own
 *    network. (A server proxy would bind the host's IP, and every viewer
 *    would then 403 with "ip not in range".)
 * 2. The playlist URL is rewritten with the fresh token and reloaded, and
 *    hls.js rewrites every segment/variant URL it resolves (loader below).
 *
 * `preserve` keeps the playback position across the reload.
 */
import Hls from "hls.js";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // well before the 4h expiry

/** Fetch a fresh playback token from the stream host's token endpoint. */
async function fetchToken(origin: string): Promise<string | null> {
  try {
    const r = await fetch(`${origin}/generate.php`, {
      credentials: "omit",
      headers: { accept: "application/json, text/plain, */*" },
    });
    if (!r.ok) return null;
    const text = (await r.text()).trim();
    // Plain token, JSON envelope ({token|data|string|result}), or junk.
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const j = JSON.parse(text) as unknown;
        const t =
          typeof j === "string"
            ? j
            : ((j as Record<string, string>).token ??
              (j as Record<string, string>).data ??
              (j as Record<string, string>).string ??
              (j as Record<string, string>).result ??
              "");
        return t || null;
      } catch {
        return null;
      }
    }
    return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Append/replace ?token= on a URL (preserving any fragment). */
export function applyToken(url: string, token: string): string {
  if (!token) return url;
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const cleaned = base
    .replace(/([?&])token=[^&]*/, "$1")
    .replace(/[?&]+$/, "");
  const sep = cleaned.includes("?") ? "&" : "?";
  return `${cleaned}${sep}token=${encodeURIComponent(token)}${hash}`;
}

/** Everything the HLS engine needs to stamp the current token onto every
 *  playlist/segment/variant request for the stream's host. */
export type TokenContext = {
  /** Latest token ("" until the first fetch resolves). */
  token: { current: string };
  /** Stream hosts whose URLs get stamped. */
  hosts: Set<string>;
};

/** hls.js loader subclass that rewrites resolved URLs with the live token. */
export function makeTokenLoader(
  ctx: TokenContext,
): (typeof Hls.DefaultConfig)["loader"] {
  // hls.js's loader generics are internal; we only touch `context.url` and
  // defer everything else to the stock loader, so the boundary is `any`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Base = Hls.DefaultConfig.loader as any;
  return class TokenLoader extends Base {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    load(context: any, config: any, callbacks: any) {
      const url: string = context?.url ?? "";
      try {
        const u = new URL(url, location.href);
        const stamped = [...ctx.hosts].some(
          (h) => u.host === h || u.host.endsWith("." + h),
        );
        if (ctx.token.current && stamped) {
          u.searchParams.set("token", ctx.token.current);
          context.url = u.toString();
        }
      } catch {
        // non-absolute URIs etc. — pass through untouched
      }
      super.load(context, config, callbacks);
    }
  } as unknown as (typeof Hls.DefaultConfig)["loader"];
}

/**
 * Fetch a token now and refresh it hourly; each fresh token triggers
 * `rebuild(freshPlaylistUrl)` so the engine reloads before the old JWT dies.
 * Returns a disposer.
 */
export function attachTokenRefresh(
  playlistUrl: string,
  ctx: TokenContext,
  rebuild: (freshUrl: string) => void,
): () => void {
  let host = "";
  try {
    host = new URL(playlistUrl).host;
  } catch {
    return () => {};
  }
  ctx.hosts.add(host);

  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const token = await fetchToken(`https://${host}`);
    if (stopped || !token || token === ctx.token.current) return;
    ctx.token.current = token;
    rebuild(applyToken(playlistUrl, token));
  };
  void tick();
  const timer = setInterval(tick, REFRESH_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
