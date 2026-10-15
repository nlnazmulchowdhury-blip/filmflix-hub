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
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import {
  PLATFORMS,
  detectPlatform,
  formatSize,
  listAppBuilds,
  type AppBuild,
  type AppPlatform,
} from "@/lib/app-builds";
import { useEffect, useState } from "react";
import { Link } from "react-router";

const ICONS: Record<AppPlatform, typeof Smartphone> = {
  android: Smartphone,
  ios: Apple,
  windows: Monitor,
  macos: Laptop,
  tv: Tv,
};

const navLinkClass =
  "text-sm font-medium text-muted-foreground transition-colors hover:text-foreground";

/**
 * Every published FilmFlix binary in one place.
 *
 * A platform only offers a real download while an `app_builds` row exists for
 * it; the rest install as a web app, so the page can never promise a file that
 * was never published.
 */
export default function Downloads() {
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

    /* The native install prompt fires once and disappears, so hold on to
       whichever card the user presses it for. */
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
    /* iOS Safari and Firefox never hand us a prompt: the next best thing is
       putting the address on the clipboard for that device. */
    try {
      await navigator.clipboard.writeText(siteUrl);
      setCopied(platform);
      setTimeout(() => setCopied(""), 2500);
    } catch {
      // clipboard blocked — the QR on the card still works
    }
  };

  const published = PLATFORMS.filter((p) => builds[p.key]).length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute left-1/2 top-[-20%] h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-primary/14 blur-[140px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-[380px] w-[520px] rounded-full bg-primary/8 blur-[120px]" />
      </div>

      <header className="sticky top-0 z-40 glass-panel border-b">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-2 px-3 sm:gap-4 sm:px-6">
          <Link to="/" aria-label="FilmFlix home" className="shrink-0">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-6 md:flex">
            <Link to="/" className={navLinkClass}>
              Home
            </Link>
            <Link to="/tv" className={navLinkClass}>
              TV
            </Link>
            <span className="text-sm font-semibold">Download</span>
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link to="/" className="text-sm font-medium text-muted-foreground hover:text-foreground md:hidden">
              Home
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 pb-16 pt-10 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Download FilmFlix
            </h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Every operating system, one page — grab the published build or scan
              its code with the device you want it on.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-secondary/40 px-3 py-1 text-[11px] font-semibold text-muted-foreground">
            <QrCode className="size-3.5" /> {loaded ? `${published} of ${PLATFORMS.length} builds published` : "Checking published builds…"}
          </span>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {PLATFORMS.map((p) => {
            const build = builds[p.key];
            const Icon = ICONS[p.key];
            const isMine = mine === p.key;
            const target = build?.url || siteUrl;
            return (
              <div
                key={p.key}
                className={`flex flex-col gap-4 rounded-2xl border p-5 sm:flex-row sm:items-center ${
                  build
                    ? "border-primary/45 bg-gradient-to-br from-primary/15 to-transparent"
                    : "border-border/60 bg-card/60"
                }`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-4">
                  <div
                    className={`flex size-14 shrink-0 items-center justify-center rounded-2xl ${
                      build ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground"
                    }`}
                  >
                    <Icon className="size-7" />
                  </div>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-display text-lg font-bold">
                      {p.label}
                      {isMine && (
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          your device
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {build
                        ? [
                            `${p.file}${build.version ? ` · v${build.version}` : ""}`,
                            formatSize(build.sizeBytes),
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : loaded
                          ? "Browser install — no file published yet"
                          : "Checking…"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground/80">
                      {build?.notes || p.howTo}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-4">
                  <a
                    href={target}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={build ? `Scan to download the ${p.label} build` : `Scan to open ${siteUrl}`}
                    className="hidden rounded-xl bg-white p-2 sm:block"
                  >
                    <QRCodeSVG value={target} size={72} level="M" />
                  </a>
                  {build ? (
                    <a
                      href={build.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="glow-accent inline-flex items-center gap-1.5 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground transition-transform hover:scale-[1.03]"
                    >
                      <Download className="size-4" />
                      {p.file}
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={() => install(p.key)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border px-5 py-2.5 text-sm font-bold transition-colors hover:bg-secondary"
                    >
                      {copied === p.key ? (
                        <>
                          <Check className="size-4 text-primary" /> Link copied
                        </>
                      ) : (
                        "Install"
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <p className="mt-6 max-w-3xl text-xs leading-relaxed text-muted-foreground/80">
          A card showing <span className="font-semibold text-foreground">Install</span> has no
          file published for it yet, so it installs FilmFlix as a web app instead:
          open the site in that device&apos;s browser and choose &quot;Add to Home
          screen&quot; — it then runs full-screen with its own icon and updates
          itself. New builds appear here the moment they are published in the
          admin panel.
        </p>
      </main>
    </div>
  );
}
