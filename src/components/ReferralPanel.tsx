import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/hooks/use-auth";
import { ApiError } from "@/lib/api";
import { referralApi, referralLink, type ReferralSummary } from "@/lib/referrals";
import { Check, Copy, Loader2, MousePointerClick, Share2, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

const usd = (n: number) =>
  `$${(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

/**
 * Refer & earn — the referrer's side of the referral system.
 *
 * Numbers come from the primary Worker only (see lib/referrals.ts): the
 * nightly settlement writes balances there, so reading anywhere else would
 * show an empty wallet.
 */
export default function ReferralPanel() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<ReferralSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    setUnavailable(false);
    referralApi
      .summary()
      .then((s) => {
        if (!alive) return;
        setSummary(s);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        /* 404 = a Worker build without the referral routes, 0/x = network.
           Neither is the referrer's problem, so the card waits quietly
           instead of shouting a parse error at them. */
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 404 || status === 0 || status >= 500) {
          setUnavailable(true);
          return;
        }
        setError(err instanceof Error ? err.message : "আয়ের তথ্য লোড করা গেল না");
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => load(), [load, user?._id]);

  const link = summary?.code ? referralLink(summary.code) : "";

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      /* Clipboard API is missing on old WebViews — the input still selects. */
      const input = document.getElementById("referral-link") as HTMLInputElement | null;
      input?.select();
      document.execCommand?.("copy");
    }
    setCopied(true);
    toast.success("রেফারেল লিংক কপি হয়েছে");
    window.setTimeout(() => setCopied(false), 1800);
  };

  if (unavailable) {
    return (
      <Card className="border-border/60 bg-card/70">
        <CardHeader className="pb-3">
          <CardTitle className="font-display flex items-center gap-2 text-lg">
            <Share2 className="size-4 text-primary" />
            রেফার করে আয় করুন
          </CardTitle>
          <CardDescription>
            রেফারেল সার্ভার এখনো চালু হয়নি, তাই এখন কোনো হিসাব নেই। চালু হওয়ার পরেই এখানে
            আপনার লিংক, ক্লিক আর আয় দেখা যাবে।
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={() => load()}>
            আবার চেষ্টা করুন
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (summary && !summary.enabled) {
    return (
      <Card className="border-border/60 bg-card/70">
        <CardHeader className="pb-3">
          <CardTitle className="font-display flex items-center gap-2 text-lg">
            <Share2 className="size-4 text-primary" />
            রেফার করে আয় করুন
          </CardTitle>
          <CardDescription>
            গেস্ট অ্যাকাউন্টে আয় হয় না — ইমেইল দিয়ে সাইন ইন করলেই নিজের রেফারেল লিংক পাবেন।
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild size="sm" className="gap-2">
            <Link to="/auth">ফ্রি অ্যাকাউন্ট খুলুন</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-primary/25 bg-card/70">
      <CardHeader className="pb-3">
        <CardTitle className="font-display flex flex-wrap items-center gap-2 text-lg">
          <Share2 className="size-4 text-primary" />
          রেফার করে আয় করুন
          {summary && (
            <Badge variant="outline" className="border-primary/40 bg-primary/10 text-[11px] text-primary">
              ভিজিটরের বিজ্ঞাপন আয়ের {summary.sharePct}%
            </Badge>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-5">
        {error && (
          <p className="text-sm text-destructive">{error} — পেজ রিফ্রেশ করে আবার চেষ্টা করুন।</p>
        )}

        {/* Referral link */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="referral-link"
            readOnly
            value={link}
            placeholder={summary ? "তৈরি হচ্ছে…" : "লোড হচ্ছে…"}
            onFocus={(e) => e.currentTarget.select()}
            className="font-mono text-xs sm:text-sm"
            aria-label="আপনার রেফারেল লিংক"
          />
          <Button
            type="button"
            onClick={copy}
            disabled={!link}
            className="shrink-0 gap-2"
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "কপি হয়েছে" : "কপি করুন"}
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border/50 px-4 py-3">
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <MousePointerClick className="mt-0.5 size-3.5 shrink-0" />
              পেন্ডিং ক্লিক (২৪ ঘণ্টা পর যোগ হবে)
            </p>
            {summary ? (
              <>
                <p className="mt-1 font-display text-2xl font-bold">{summary.todayVisits}</p>
                <p className="text-xs text-muted-foreground">
                  ≈ {usd(summary.todayPending)} · রাত ২৩:৫৯-এ যোগ হবে
                </p>
              </>
            ) : (
              <Skeleton className="mt-2 h-8 w-20" />
            )}
          </div>
          <div className="rounded-lg border border-primary/30 px-4 py-3">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Wallet className="size-3.5" /> Approved Balance
            </p>
            {summary ? (
              <>
                <p className="mt-1 font-display text-2xl font-bold text-primary">
                  {usd(summary.balance)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {summary.lastSettled
                    ? `শেষ যোগ: ${dayLabel(summary.lastSettled.date)}`
                    : "আজ রাত ২৩:৫৯-এ প্রথম যোগ হবে"}
                </p>
              </>
            ) : (
              <Skeleton className="mt-2 h-8 w-24" />
            )}
          </div>
          <div className="rounded-lg border border-border/50 px-4 py-3">
            <p className="text-xs text-muted-foreground">সর্বমোট আয়</p>
            {summary ? (
              <>
                <p className="mt-1 font-display text-2xl font-bold">{usd(summary.totalEarned)}</p>
                <p className="text-xs text-muted-foreground">
                  এখন পর্যন্ত {summary.lifetimeVisits} টি ক্লিক গণনা হয়েছে
                </p>
              </>
            ) : (
              <Skeleton className="mt-2 h-8 w-24" />
            )}
          </div>
        </div>

        {/* Daily ledger */}
        <div>
          <p className="mb-2 text-sm font-semibold">প্রতিদিনের আয়</p>
          {!summary ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : summary.days.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
              এখনো কোনো ক্লিক নেই। লিংকটি শেয়ার করুন — আজই প্রথম ভিজিট এখানে দেখাবে।
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border/50">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>তারিখ</TableHead>
                    <TableHead className="text-right">ক্লিক</TableHead>
                    <TableHead className="text-right">আয়</TableHead>
                    <TableHead className="text-right">স্ট্যাটাস</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.days.map((d) => (
                    <TableRow key={d.date}>
                      <TableCell className="whitespace-nowrap">{dayLabel(d.date)}</TableCell>
                      <TableCell className="text-right tabular-nums">{d.visits}</TableCell>
                      <TableCell className="text-right tabular-nums">{usd(d.earned)}</TableCell>
                      <TableCell className="text-right">
                        {d.settled ? (
                          <Badge variant="secondary" className="text-[11px]">
                            যোগ হয়েছে
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="gap-1 border-amber-500/40 text-[11px] text-amber-500"
                          >
                            <Loader2 className="size-3 animate-spin" />
                            পেন্ডিং
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {summary?.lastSettled && (
            <p className="mt-2 text-xs text-muted-foreground">
              শেষ সেটেলমেন্ট {dayLabel(summary.lastSettled.date)}: {summary.lastSettled.visits}{" "}
              টি ভিজিটে ${summary.lastSettled.earnings.toFixed(2)} ভাগ হয়েছে — প্রতি ভিজিট{" "}
              {usd(summary.lastSettled.perVisit)}।
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
