import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Apple,
  Check,
  Download,
  Laptop,
  Monitor,
  QrCode,
  Smartphone,
  Tv,
} from "lucide-react";
import {
  PLATFORMS,
  detectPlatform,
  formatSize,
  listAppBuilds,
  type AppBuild,
  type AppPlatform,
} from "@/lib/app-builds";

const ICONS: Record<AppPlatform, typeof Smartphone> = {
  android: Smartphone,
  ios: Apple,
  windows: Monitor,
  macos: Laptop,
  tv: Tv,
};

/**
 * "Get the FilmFlix app" — one card per operating system.
 *
 * A card shows a real Download button only while an `app_builds` row exists
 * for that platform; otherwise it offers the browser install (PWA) route with
 * the exact gesture for that OS. The QR always encodes whatever the card would
 * hand out, so a phone can scan its own platform and land on the right thing.
 */
export default function GetTheApp() {
  const [builds, setBuilds] = useState<Record<string, AppBuild>>({});
  const [loaded, setLoaded] = useState(false);
  const [mine, setMine] = useState<AppPlatform | null>(null);
  const [copied, setCopied] = useState("");
  const [deferredPrompt, setDeferredPrompt] = useState<{ prompt: () => void } | null>(null);

  useEffect(() => {
    setMine(detectPlatform());
    listAppBuilds()
      .then((rows) => setBuilds(Object.fromEntries(rows.map((r) => [r.platform, r]))))
      .catch(() => undefined)
      .finally(() => setLoaded(true));

    /* The native install prompt fires once and is gone, so keep whatever the
       browser offers for whichever card the user presses. */
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as unknown as { prompt: () => void });
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const siteUrl = typeof window !== "undefined" ? window.location.origin : "https://filmbd.pages.dev";

  const install = async (platform: AppPlatform) => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      return;
    }
    /* No native prompt (iOS Safari, Firefox, or already installed): the best
       we can do is put the address on the clipboard for that device. */
    try {
      await navigator.clipboard.writeText(siteUrl);
      setCopied(platform);
      setTimeout(() => setCopied(""), 2500);
    } catch {
      // clipboard blocked — the QR on the card still works
    }
  };

  return (
    <section id="get-the-app" className="scroll-mt-24 pt-12 sm:pt-16">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            Get the FilmFlix app
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every operating system, one place — scan the code or hit download.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-secondary/40 px-3 py-1 text-[11px] font-semibold text-muted-foreground">
          <QrCode className="size-3.5" /> Scan with your phone
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PLATFORMS.map((p) => {
          const build = builds[p.key];
          const Icon = ICONS[p.key];
          const isMine = mine === p.key;
          const target = build?.url || siteUrl;
          return (
            <div
              key={p.key}
              className={`flex items-center gap-3 rounded-2xl border p-3.5 transition-colors ${
                build
                  ? "border-primary/45 bg-gradient-to-br from-primary/15 to-transparent"
                  : "border-border/60 bg-card/60 hover:border-border"
              }`}
            >
              <div
                className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${
                  build
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-foreground"
                }`}
              >
                <Icon className="size-5" />
              </div>

              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-display text-sm font-bold">
                  {p.label}
                  {isMine && (
                    <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                      your device
                    </span>
                  )}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {build
                    ? [
                        `${p.file}${build.version ? ` · v${build.version}` : ""}`,
                        formatSize(build.sizeBytes),
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : loaded
                      ? `Browser install — ${p.howTo}`
                      : "Checking published builds…"}
                </p>
                {build?.notes && (
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground/80">
                    {build.notes}
                  </p>
                )}
              </div>

              {build ? (
                <a
                  href={build.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="glow-accent inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-xs font-bold text-primary-foreground transition-transform hover:scale-[1.03]"
                >
                  <Download className="size-3.5" />
                  {p.file}
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => install(p.key)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3.5 py-2 text-xs font-bold transition-colors hover:bg-secondary"
                >
                  {copied === p.key ? (
                    <>
                      <Check className="size-3.5 text-primary" /> Link copied
                    </>
                  ) : (
                    "Install"
                  )}
                </button>
              )}

              <a
                href={target}
                target="_blank"
                rel="noopener noreferrer"
                title={build ? `Scan to download the ${p.label} build` : `Scan to open ${siteUrl}`}
                className="hidden shrink-0 rounded-lg bg-white p-1.5 lg:block"
              >
                <QRCodeSVG value={target} size={44} level="M" />
              </a>
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/80">
        No file published yet for a card? That one installs as a web app: open
        FilmFlix in the device's browser and choose "Add to Home screen" — it
        then runs full-screen with its own icon, and updates itself.
      </p>
    </section>
  );
}
