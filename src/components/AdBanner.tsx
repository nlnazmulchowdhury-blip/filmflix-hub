import { useMemo } from "react";
import type { AdBannerDef } from "@/lib/ad-banners";

/**
 * One banner ad unit. The network's snippet (atOptions + invoke.js) runs
 * inside a dedicated srcdoc iframe, so every unit gets its own document
 * scope — the global `atOptions` variable can never collide when several
 * banners are on the same page. The iframe is lazy and sized exactly to
 * the unit so layout never shifts.
 */
export default function AdBanner({
  id,
  width,
  height,
  className = "",
}: AdBannerDef & { className?: string }) {
  const html = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}` +
      `iframe{border:0;display:block}</style></head><body>` +
      `<script>atOptions={'key':'${id}','format':'iframe','height':${height},'width':${width},'params':{}};</script>` +
      `<script src="https://www.highrevenueformat.com/${id}/invoke.js"></script>` +
      `</body></html>`,
    [id, width, height],
  );

  return (
    <iframe
      title="Advertisement"
      srcDoc={html}
      width={width}
      height={height}
      loading="lazy"
      scrolling="no"
      className={className}
      style={{ border: 0, display: "block", maxWidth: "100%" }}
    />
  );
}
