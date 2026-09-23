import { vlyPlugin } from "@vly-ai/integrations";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig, loadEnv } from "vite";

// The Convex dev CLI rewrites VITE_CONVEX_URL in .env.local to the loopback
// address (127.0.0.1:3210) on every start. Loopback is unreachable from a
// user's browser when the app is served through the workspace's public proxy,
// which stalls every Convex call (login never resolves). PUBLIC_CONVEX_URL /
// PUBLIC_CONVEX_SITE_URL are the externally reachable URLs; when set they win.
//
// These must come from loadEnv (the .env files), not bare process.env: a
// production build host sets neither in its shell, and an empty-string define
// here overrides the real value baked in by Vite's own env handling — the
// shipped bundle then crashes with
// "Error: Provided address was not an absolute URL." (blank page).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Treat empty strings as unset: hosting platforms often carry a stale
  // VITE_CONVEX_URL="" from the template's .env.example, and `??` would
  // happily return that empty value instead of falling through.
  const firstNonEmpty = (...values: (string | undefined)[]) =>
    values.find((v) => v && v.trim() !== "") ?? "";
  const publicConvexUrl = firstNonEmpty(
    process.env.PUBLIC_CONVEX_URL,
    process.env.VITE_CONVEX_URL,
    env.VITE_CONVEX_URL,
  );
  const publicConvexSiteUrl = firstNonEmpty(
    process.env.PUBLIC_CONVEX_SITE_URL,
    process.env.VITE_CONVEX_SITE_URL,
    env.VITE_CONVEX_SITE_URL,
  );
  // Only override when a value actually exists — an empty-string define
  // clobbers whatever Vite would otherwise bake in from the build host's
  // own environment (.env files or injected variables).
  const convexDefines: Record<string, string> = {};
  if (publicConvexUrl) {
    convexDefines["import.meta.env.VITE_CONVEX_URL"] =
      JSON.stringify(publicConvexUrl);
  }
  if (publicConvexSiteUrl) {
    convexDefines["import.meta.env.VITE_CONVEX_SITE_URL"] =
      JSON.stringify(publicConvexSiteUrl);
  }

// https://vite.dev/config/
  return {
  plugins: [react(), vlyPlugin(), tailwindcss()],
  define: convexDefines,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // Force a single copy of React across all packages (including vlyPlugin).
    // Without this, @vly-ai/integrations can resolve its own React copy, which
    // triggers "Invalid hook call" errors at runtime.
    dedupe: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
  },
  build: {
    // Enable source maps for better debugging (disable in production if needed)
    sourcemap: false,
    // Optimize chunk splitting
    rollupOptions: {
      output: {
        // Manual chunk splitting for better caching and lazy loading
        manualChunks: {
          // Vendor chunks for large libraries
          'react-vendor': ['react', 'react-dom', 'react-router'],
          'convex-vendor': ['convex'],
          // Large UI library chunks
          'radix-ui': [
            '@radix-ui/react-accordion',
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-avatar',
            '@radix-ui/react-checkbox',
            '@radix-ui/react-collapsible',
            '@radix-ui/react-context-menu',
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-hover-card',
            '@radix-ui/react-label',
            '@radix-ui/react-menubar',
            '@radix-ui/react-navigation-menu',
            '@radix-ui/react-popover',
            '@radix-ui/react-progress',
            '@radix-ui/react-radio-group',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-select',
            '@radix-ui/react-separator',
            '@radix-ui/react-slider',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
            '@radix-ui/react-toggle',
            '@radix-ui/react-toggle-group',
            '@radix-ui/react-tooltip',
          ],
          // Heavy optional libraries - separate chunks for better lazy loading
          'framer-motion': ['framer-motion'],
          'charts': ['recharts'],
          'forms': ['react-hook-form', '@hookform/resolvers', 'zod'],
        },
        // Optimize chunk size
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
    // Increase chunk size warning limit for better chunking
    chunkSizeWarningLimit: 1000,
    // Target modern browsers for better optimization
    target: 'esnext',
    // Minify options - using esbuild (faster than terser)
    minify: 'esbuild',
  },
  // Optimize dependencies
  optimizeDeps: {
    // Only scan the app entry HTML; avoids crawling unrelated *.html files
    // if a legacy snapshot accidentally contains leaked package folders.
    entries: ['index.html'],
    include: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      'react-router',
      '@convex-dev/auth/react',
      'framer-motion',
    ],
  },
  // Performance hints
  server: {
    // Bind to all interfaces so WebContainer's server-ready event fires.
    host: true,
    port: 5173,
    // Keep HMR on, but disable full-screen error overlay
    hmr: {
      overlay: false,
    },
  },
  };
});
