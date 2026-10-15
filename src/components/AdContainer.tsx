import { useMemo } from "react";
import { PRCONTAINER } from "@/lib/ad-banners";

/**
 * profitableratecpmnetwork container (in-page) banner. The network's async
 * invoke.js writes into a `container-<hash>` div, so we run it inside a
 * dedicated srcdoc iframe — the div and the script share that isolated
 * document, and multiple instances never collide on the same id.
 */
export default function AdContainer({
  className = "",
  width = PRCONTAINER.width,
  height = PRCONTAINER.height,
}: {
  className?: string;
  width?: number;
  height?: number;
}) {
  const html = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}</style></head><body>` +
      `<script async src="${PRCONTAINER.invokeSrc}"></script>` +
      `<div id="container-${PRCONTAINER.hash}"></div>` +
      `</body></html>`,
    [],
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
