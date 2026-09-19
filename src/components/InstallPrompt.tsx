import { useEffect, useState } from "react";
import { Download, Share, Plus, X } from "lucide-react";
import Logo from "@/components/Logo";

const KEY = "ff-pwa-prompt-dismissed";

/**
 * "Install the app" banner for phone visitors. Detects Android Chrome's
 * native install prompt and uses it; on iOS Safari shows the
 * Share > Add to Home Screen instruction. Never shows for returning users
 * who dismissed it, and never on desktop.
 */
export default function InstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [deferred, setDeferred] = useState<any>(null);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    // Desktop or already-installed: stay quiet.
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as any).standalone === true;
    if (standalone) return;

    let dismissed: string | null = null;
    try {
      dismissed = localStorage.getItem(KEY);
    } catch {
      // storage blocked — still show once
    }
    if (dismissed) return;

    const ua = window.navigator.userAgent;
    const iOS = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream;
    setIsIOS(iOS);

    if (iOS) {
      const t = setTimeout(() => setVisible(true), 2500);
      return () => clearTimeout(t);
    }

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e);
      setTimeout(() => setVisible(true), 2500);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    // If no native prompt arrives within 6s (e.g. Android Firefox), still
    // show a generic instruction banner.
    const fallback = setTimeout(() => {
      setDeferred((d: any) => {
        if (!d) setVisible(true);
        return d;
      });
    }, 6000);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      clearTimeout(fallback);
    };
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // ignore
    }
  };

  const install = async () => {
    if (deferred) {
      deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice?.outcome === "accepted") {
        dismiss();
        return;
      }
      // declined — keep the banner but don't nag: dismiss for this session
      setVisible(false);
      return;
    }
    // No native prompt available: iOS-style guidance stays visible.
  };

  return (
    <div className="fixed inset-x-3 top-3 z-[70] sm:left-1/2 sm:right-auto sm:w-[420px] sm:-translate-x-1/2">
      <div className="overflow-hidden rounded-2xl border border-primary/30 bg-card/95 shadow-[0_20px_60px_-16px_rgba(0,0,0,0.6)] backdrop-blur">
        <div className="flex items-start gap-3 p-3.5">
          <div className="mt-0.5 shrink-0">
            <div className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-rose-500 to-rose-700 shadow-[0_8px_24px_-8px_var(--primary)]">
              <svg viewBox="0 0 24 24" fill="none" className="size-6">
                <path
                  d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5v-13Z"
                  stroke="white"
                  strokeWidth="1.8"
                />
                <path d="M4 9h16M9.5 3.5v5.2M14.5 3.5v5.2" stroke="white" strokeWidth="1.8" />
                <path d="m11 13.2 4 2.3-4 2.3v-4.6Z" fill="white" />
              </svg>
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <p className="font-display text-sm font-bold">
              Install FilmFlix on your phone
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Add the app to your home screen — full-screen viewing, no browser
              bars, and instant access like a real app.
            </p>

            {isIOS ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  Tap <Share className="size-3.5 text-foreground" /> Share
                </span>
                <span className="text-border">→</span>
                <span className="inline-flex items-center gap-1">
                  <Plus className="size-3.5 text-foreground" /> Add to Home Screen
                </span>
              </div>
            ) : (
              <button
                type="button"
                onClick={install}
                className="glow-accent mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground transition-transform hover:scale-[1.03]"
              >
                <Download className="size-3.5" />
                Install app
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {!isIOS && (
          <div className="border-t border-border/50 bg-secondary/40 px-3.5 py-1.5 text-center text-[10px] text-muted-foreground">
            Or menu (⋮) → “Add to Home screen”
          </div>
        )}
      </div>
    </div>
  );
}
