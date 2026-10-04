import '@vly-ai/integrations';
import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/RequireAuth";
import { MiniPlayerProvider } from "@/components/MiniPlayerProvider";
import AnalyticsTracker from "@/components/AnalyticsTracker";
import HelpCenterWidget from "@/components/HelpCenterWidget";
import InstallPrompt from "@/components/InstallPrompt";
import { ThemeProvider } from "next-themes";
import { VlyToolbar } from "../vly-toolbar-readonly.tsx";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import "./index.css";

// Lazy load route components for better code splitting
const Landing = lazy(() => import("./pages/Landing.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const MovieDetail = lazy(() => import("./pages/MovieDetail.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const Checkout = lazy(() => import("./pages/Checkout.tsx"));
const Admin = lazy(() => import("./pages/Admin.tsx"));
const Tv = lazy(() => import("./pages/Tv.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

// Branded loading fallback for route transitions — mirrors the boot splash.
function RouteLoading() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background">
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute left-1/2 top-[30%] h-[300px] w-[520px] -translate-x-1/2 rounded-full bg-primary/10 blur-[120px]" />
      </div>
      <div className="relative flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-500 to-rose-700 shadow-[0_12px_48px_-12px_var(--primary)]">
        <svg viewBox="0 0 24 24" fill="none" className="size-8 animate-pulse">
          <path
            d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5v-13Z"
            stroke="white"
            strokeWidth="1.8"
          />
          <path d="M4 9h16M9.5 3.5v5.2M14.5 3.5v5.2" stroke="white" strokeWidth="1.8" />
          <path d="m11 13.2 4 2.3-4 2.3v-4.6Z" fill="white" />
        </svg>
      </div>
      <p className="font-display text-lg font-bold tracking-tight">
        Film<span className="text-primary">Flix</span>
      </p>
      <div className="relative h-1 w-44 overflow-hidden rounded-full bg-foreground/10">
        <div className="ff-shimmer absolute inset-y-0 w-2/5 rounded-full bg-gradient-to-r from-transparent via-primary to-transparent" />
      </div>
    </div>
  );
}

/** Silent error boundary — if VlyToolbar crashes it renders nothing instead of
 *  crashing the whole app (e.g. hook errors in WebContainer environment). */
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] Caught error, toolbar disabled:", err.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** Wraps the whole route tree so every page fades in smoothly instead of
 *  popping in. Pure CSS — no extra renders. */
function PageFade({ children }: { children: React.ReactNode }) {
  return <div className="ff-page-fade min-h-screen">{children}</div>;
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[WebContainer preview] Root crash:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);



function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}

/** HelpCenterWidget on every public route — the admin panel has its own
 *  conversations inbox, so the floating widget would just be noise there. */
function HelpCenterRouteGate() {
  const location = useLocation();
  if (location.pathname.startsWith("/nazmul")) return null;
  return <HelpCenterWidget />;
}


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <ToolbarErrorBoundary>
        <VlyToolbar />
      </ToolbarErrorBoundary>
      <ConvexAuthProvider client={convex}>
        {/* Light/dark theme state; attribute mode drives the .dark class on
            <html>. The pre-paint script in index.html seeds it before React. */}
        <ThemeProvider attribute="class" storageKey="ff-theme" defaultTheme="dark" enableSystem={false}>
        <BrowserRouter>
          <MiniPlayerProvider>
          <RouteSyncer />
          <AnalyticsTracker />
          <InstallPrompt />
          {/* Floating help-center chat — hidden on the admin route */}
          <HelpCenterRouteGate />
          <Suspense fallback={<RouteLoading />}>
            <PageFade>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route
                path="/auth"
                element={<AuthPage redirectAfterAuth="/dashboard" />}
              />
              <Route path="/movie/:id" element={<MovieDetail />} />
              <Route
                path="/dashboard"
                element={
                  <RequireAuth>
                    <Dashboard />
                  </RequireAuth>
                }
              />
              <Route
                path="/checkout"
                element={
                  <RequireAuth>
                    <Checkout />
                  </RequireAuth>
                }
              />
              <Route path="/tv" element={<Tv />} />
              <Route
                path="/nazmul"
                element={
                  <RequireAuth>
                    <Admin />
                  </RequireAuth>
                }
              />
              <Route path="*" element={<NotFound />} />
            </Routes>
            </PageFade>
          </Suspense>
          </MiniPlayerProvider>
        </BrowserRouter>
        <Toaster />
        </ThemeProvider>
      </ConvexAuthProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
