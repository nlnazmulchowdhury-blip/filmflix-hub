import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import Logo from "@/components/Logo";
import ReferralPanel from "@/components/ReferralPanel";
import ThemeToggle from "@/components/ThemeToggle";
import { useAuth } from "@/hooks/use-auth";
import { initialsOf, joinedOn } from "@/lib/account-display";
import { ArrowLeft, BookOpen, LogOut, UserRound } from "lucide-react";
import { Link } from "react-router";

export default function Profile() {
  const { user, signOut } = useAuth();
  const isGuest = user?.isAnonymous ?? false;
  const joinedAt = joinedOn(user?.createdAt);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute left-1/2 top-[-20%] h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-primary/12 blur-[130px]" />
      </div>

      <header className="sticky top-0 z-40 glass-panel border-b">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link to="/" aria-label="FilmFlix home">
              <Logo />
            </Link>
            <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
              Profile
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="gap-2">
              <Link to="/dashboard">
                <BookOpen className="size-4" />
                <span className="hidden sm:inline">Library</span>
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={async () => {
                await signOut();
              }}
            >
              <LogOut className="size-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl space-y-6 px-4 pb-24 pt-8 sm:px-6">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            আপনার প্রোফাইল
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            অ্যাকাউন্ট আর রেফারেলের সব হিসাব এক জায়গায়।
          </p>
        </div>

        <Card className="border-border/60 bg-card/70">
          <CardContent className="flex flex-col gap-5 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <Avatar className="size-14">
                <AvatarFallback className="bg-primary/15 font-display text-lg font-bold text-primary">
                  {user ? initialsOf(user) : <UserRound className="size-6" />}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="font-display truncate text-lg font-bold">
                  {user?.name || user?.email?.split("@")[0] || "অতিথি"}
                </p>
                <p className="truncate text-sm text-muted-foreground">
                  {user?.email ?? "কোনো ইমেইল যুক্ত নেই"}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge variant={isGuest ? "outline" : "secondary"} className="text-[11px]">
                    {isGuest ? "গেস্ট অ্যাকাউন্ট" : "মেম্বার"}
                  </Badge>
                  {joinedAt && (
                    <span className="text-xs text-muted-foreground">যোগ দিয়েছেন {joinedAt}</span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm" className="gap-2">
                <Link to="/dashboard">
                  <BookOpen className="size-4" />
                  লাইব্রেরি
                </Link>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-2 text-muted-foreground"
                onClick={async () => {
                  await signOut();
                }}
              >
                <LogOut className="size-4" />
                সাইন আউট
              </Button>
            </div>
          </CardContent>

          <Separator />

          <CardContent className="grid gap-4 py-5 sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">অ্যাকাউন্ট আইডি</p>
              <p className="mt-0.5 truncate font-mono text-xs">{user?.id ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">রোল</p>
              <p className="mt-0.5 text-sm">{user?.role === "admin" ? "অ্যাডমিন" : "ইউজার"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">অ্যাকাউন্ট ধরন</p>
              <p className="mt-0.5 text-sm">{isGuest ? "গেস্ট — আয় চালু করতে ইমেইল যোগ করুন" : "রেজিস্টার্ড মেম্বার"}</p>
            </div>
          </CardContent>
        </Card>

        {isGuest && (
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">গেস্ট অ্যাকাউন্টে রেফারেল আয় বন্ধ</CardTitle>
              <CardDescription>
                গেস্ট সেশন হারিয়ে গেলে ব্যালেন্সও হারিয়ে যায়। ইমেইল দিয়ে ফ্রি অ্যাকাউন্ট খুললে
                আপনার রেফারেল লিংক, ক্লিক আর আয় স্থায়ীভাবে সেভ থাকবে।
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild size="sm" className="gap-2">
                <Link to="/auth">অ্যাকাউন্ট আপগ্রেড করুন</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        <ReferralPanel />

        <p className="text-center text-xs text-muted-foreground">
          <Link to="/" className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="size-3" /> হোমে ফিরে যান
          </Link>
        </p>
      </main>
    </div>
  );
}
