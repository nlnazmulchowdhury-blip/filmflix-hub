import { Button } from "@/components/ui/button";
import Logo from "@/components/Logo";
import { motion } from "framer-motion";
import { Clapperboard } from "lucide-react";
import { Link } from "react-router";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute left-1/2 top-[-20%] h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-primary/10 blur-[130px]" />
      </div>

      <header className="border-b border-border/60">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center px-4 sm:px-6">
          <Link to="/" aria-label="FilmFlix home">
            <Logo />
          </Link>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className="flex flex-col items-center"
        >
          <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/12 text-primary">
            <Clapperboard className="size-7" />
          </span>
          <h1 className="font-display mt-6 text-6xl font-extrabold tracking-tight sm:text-7xl">
            404
          </h1>
          <p className="mt-3 max-w-sm text-muted-foreground">
            This scene didn't make the final cut. The page you're looking for
            doesn't exist.
          </p>
          <Button asChild className="glow-accent mt-8 gap-2">
            <Link to="/">Back to FilmFlix</Link>
          </Button>
        </motion.div>
      </main>
    </div>
  );
}
