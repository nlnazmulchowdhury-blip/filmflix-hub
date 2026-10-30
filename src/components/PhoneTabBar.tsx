import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "convex/react";
import {
  Clapperboard,
  Dices,
  Download,
  Ellipsis,
  House,
  Library,
  Tv,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/** The phone's primary navigation, mounted once for every route.
 *
 *  The headers carry the inline nav from `md` up; below that the same
 *  destinations sit at thumb height, where the old slide-in drawer was. The
 *  bar is the only menu on a phone, so `More` keeps the account rows. */
export default function PhoneTabBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated, signOut } = useAuth();
  const movies = useQuery(api.movies.list);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [pathname]);

  const roll = () => {
    const pool = movies ?? [];
    if (pool.length === 0) {
      navigate("/");
      return;
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    navigate(`/movie/${pick._id}`);
  };

  /* Providers is a band on the home page, not a route — go there and wait for
     that section to mount before scrolling it into view. */
  const openProviders = () => {
    if (pathname === "/") {
      document
        .getElementById("providers")
        ?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    navigate("/");
    let tries = 0;
    const look = () => {
      const el = document.getElementById("providers");
      if (el) {
        el.scrollIntoView({ behavior: "smooth" });
        return;
      }
      if (tries++ < 10) window.setTimeout(look, 200);
    };
    window.setTimeout(look, 150);
  };

  const tabs: {
    label: string;
    icon: LucideIcon;
    to?: string;
    /** Path that lights the tab up, when it differs from `to` (Library links
        to the auth gate for guests but only opens on the dashboard). */
    activeOn?: string;
    action?: () => void;
  }[] = [
    { label: "Home", icon: House, to: "/" },
    { label: "Random", icon: Dices, action: roll },
    { label: "Providers", icon: Clapperboard, action: openProviders },
    {
      label: "Library",
      icon: Library,
      to: isAuthenticated ? "/dashboard" : "/auth?returnTo=%2Fdashboard",
      activeOn: "/dashboard",
    },
    { label: "TV", icon: Tv, to: "/tv" },
    { label: "Download", icon: Download, to: "/download" },
    { label: "More", icon: Ellipsis, action: () => setMenuOpen(true) },
  ];

  return (
    <>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent
          side="bottom"
          className="pb-[max(1rem,env(safe-area-inset-bottom))] md:hidden"
        >
          <SheetHeader>
            <SheetTitle className="font-display">More</SheetTitle>
          </SheetHeader>
          <nav className="flex flex-col gap-1 px-4 pb-2">
            {isAuthenticated ? (
              <>
                <Link
                  to="/profile"
                  onClick={() => setMenuOpen(false)}
                  className="rounded-lg px-3 py-2.5 text-left text-base font-medium text-foreground transition-colors hover:bg-secondary"
                >
                  Profile
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void signOut();
                  }}
                  className="rounded-lg px-3 py-2.5 text-left text-base font-medium text-foreground transition-colors hover:bg-secondary"
                >
                  Sign out
                </button>
              </>
            ) : (
              <Link
                to="/auth?returnTo=%2F"
                onClick={() => setMenuOpen(false)}
                className="rounded-lg px-3 py-2.5 text-left text-base font-medium text-foreground transition-colors hover:bg-secondary"
              >
                Sign in
              </Link>
            )}
          </nav>
        </SheetContent>
      </Sheet>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-50 border-t border-border/70 bg-background/95 pb-[max(0.35rem,env(safe-area-inset-bottom))] backdrop-blur-xl md:hidden"
      >
        <div className="mx-auto flex w-full max-w-lg items-stretch">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = tab.activeOn
              ? pathname.startsWith(tab.activeOn)
              : tab.to
                ? tab.to === "/"
                  ? pathname === "/"
                  : pathname.startsWith(tab.to.split("?")[0])
                : false;
            const cls = `flex min-w-0 flex-1 flex-col items-center gap-1 px-0.5 pb-1 pt-2.5 text-[10px] font-medium leading-none transition-colors ${
              active
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`;
            const inner = (
              <>
                <Icon className="size-[22px] shrink-0" strokeWidth={1.8} />
                <span className="max-w-full truncate">{tab.label}</span>
              </>
            );
            return tab.action ? (
              <button
                key={tab.label}
                type="button"
                onClick={tab.action}
                className={cls}
                aria-label={tab.label}
              >
                {inner}
              </button>
            ) : (
              <Link
                key={tab.label}
                to={tab.to ?? "/"}
                onClick={() => {
                  /* Already home: the tab means "back to the top", not a no-op. */
                  if (tab.to === "/" && pathname === "/")
                    window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                className={cls}
              >
                {inner}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
