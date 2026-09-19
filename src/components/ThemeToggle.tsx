import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

/** Small sun/moon button that flips the whole site between the bright
 *  "cinema lobby" light theme and the bold navy cinematic dark theme.
 *  The choice persists in localStorage ("ff-theme"); the pre-paint script
 *  in index.html applies it before React loads so there is no flash. */
export default function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // next-themes can't know the theme until after hydration on the client.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === "dark";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="text-muted-foreground hover:text-foreground"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? (
        <Sun className="size-4" />
      ) : (
        <Moon className="size-4" />
      )}
    </Button>
  );
}
