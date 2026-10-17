/** Browser-side playback truth: what this machine can decode, and whether the
 *  stream it was handed actually started.
 *
 *  The Worker can only report what a CDN answered to *Cloudflare*. Whether the
 *  viewer can decode the codec, and whether the media element survives the
 *  first seconds, are questions only the page can answer — and both decide if
 *  the player shows a film or a black rectangle. */

let hevc: boolean | null = null;

/** Can this browser decode HEVC/H.265 in a plain media element?
 *
 *  vidlink.pro ships HEVC-only files, and every desktop Chrome or Edge on a
 *  machine without hardware HEVC paints a permanent black player for them. The
 *  stage uses this to keep such viewers off that provider instead of parking
 *  them on a server that can never show a picture. */
export function browserDecodesHevc(): boolean {
  if (hevc !== null) return hevc;
  try {
    const probe = document.createElement("video");
    hevc = [
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
      'video/mp4; codecs="hev1.1.6.L93.B0"',
    ].some((c) => probe.canPlayType(c) !== "");
  } catch {
    /* No DOM to ask (or an ancient browser): assume it can, so a probe failure
       never hides a server that works. */
    hevc = true;
  }
  return hevc;
}

type FailureListener = (url: string) => void;

const listeners = new Set<FailureListener>();

/** Watch for a media element giving up on a URL (dead, blocked, undecodable). */
export function onPlaybackFailure(fn: FailureListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Called by the player surface when its element errors. */
export function reportPlaybackFailure(url: string): void {
  for (const fn of [...listeners]) fn(url);
}
