/**
 * Admin panel section: external Movie API integration.
 *
 * The API key itself stays server-side (Convex env MOVIE_API_KEY) — this UI
 * only shows whether it is configured. Search/import run through Convex
 * actions so the key never reaches the browser.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import type { ApiSearchHit } from "@/convex/movieApi";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Clapperboard,
  Download,
  Loader2,
  Plug,
  Search,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function MovieApiPanel() {
  const settings = useQuery(api.movieApi.getSettings);
  const probe = useAction(api.movieApi.probeAction);
  const search = useAction(api.movieApi.searchAction);
  const importMovie = useMutation(api.movieApi.importMovie);

  const [testBase, setTestBase] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<{
    ok: boolean;
    detail: string;
    kind: string;
  } | null>(null);

  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<ApiSearchHit[]>([]);
  const [searchedKind, setSearchedKind] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [imported, setImported] = useState<Set<string>>(new Set());

  const runProbe = async (base?: string) => {
    setProbing(true);
    setProbeResult(null);
    try {
      const res = await probe(base ? { base } : {});
      setProbeResult({ ok: res.ok, detail: res.detail, kind: res.kind });
      if (res.ok) toast.success("API চেনা গেছে ✅");
      else toast.error("API চেনা যায়নি — বিস্তারিত নিচে দেখুন");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Probe failed";
      setProbeResult({ ok: false, detail: msg, kind: "unknown" });
      toast.error(msg);
    } finally {
      setProbing(false);
    }
  };

  const runSearch = async () => {
    const query = q.trim();
    if (!query) return;
    setSearching(true);
    try {
      const res = await search({ q: query });
      setHits(res.hits);
      setSearchedKind(res.kind);
      if (res.hits.length === 0) toast.info("কিছু পাওয়া যায়নি");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const doImport = async (hit: ApiSearchHit) => {
    setImporting(hit.externalId);
    try {
      await importMovie({
        title: hit.year ? `${hit.title} (${hit.year})` : hit.title,
        year: hit.year,
        posterUrl: hit.posterUrl,
        description: hit.overview,
        rating: hit.rating,
        kind: hit.kind,
      });
      setImported((prev) => new Set(prev).add(hit.externalId));
      toast.success(`"${hit.title}" ক্যাটালগে যোগ হয়েছে`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(null);
    }
  };

  return (
    <Card className="overflow-hidden p-0">
      <CardHeader className="border-b border-border/50 py-4">
        <CardTitle className="font-display flex flex-wrap items-center gap-2 text-lg">
          <Clapperboard className="size-4" /> Movie API integration
          {settings && (
            settings.hasKey && settings.base ? (
              <Badge variant="outline" className="border-emerald-500/50 bg-emerald-500/10 text-emerald-500">
                <ShieldCheck className="size-3" /> key set
              </Badge>
            ) : (
              <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-500">
                <TriangleAlert className="size-3" /> not configured
              </Badge>
            )
          )}
        </CardTitle>
        <CardDescription>
          বাইরের মুভি API (TMDB, OMDb বা যেকোনো প্রোভাইডার) থেকে টাইটেল খুঁজে
          এক ক্লিকে ক্যাটালগে ইমপোর্ট করুন। কী সার্ভারে সিক্রেট হিসেবে থাকে —
          ব্রাউজারে যায় না।
          {settings?.base && (
            <span className="mt-1 block font-mono text-xs">{settings.base}</span>
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6 p-4">
        {/* Provider check */}
        <div className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={testBase}
              onChange={(e) => setTestBase(e.target.value)}
              placeholder="কাস্টম base URL টেস্ট করতে চাইলে লিখুন (যেমন https://api.example.com)"
              className="flex-1 font-mono text-xs"
            />
            <Button
              variant="outline"
              className="gap-2 sm:w-auto"
              disabled={probing}
              onClick={() => runProbe(testBase.trim() || undefined)}
            >
              {probing ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
              টেস্ট করুন
            </Button>
          </div>
          {probeResult && (
            <p
              className={`rounded-md border px-3 py-2 text-xs ${
                probeResult.ok
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "border-destructive/40 bg-destructive/10 text-destructive"
              }`}
            >
              {probeResult.detail}
            </p>
          )}
        </div>

        {/* Search + import */}
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch();
          }}
        >
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="মুভি/সিরিজের নাম লিখে সার্চ করুন…"
            aria-label="API search"
            className="flex-1"
          />
          <Button type="submit" className="gap-2 sm:w-auto" disabled={searching || !q.trim()}>
            {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            API-তে সার্চ
          </Button>
        </form>

        {searchedKind && (
          <p className="text-xs text-muted-foreground">
            প্রোভাইডার টাইপ: <span className="font-mono">{searchedKind}</span>
            {hits.length > 0 && ` — ${hits.length} টি ফলাফল`}
          </p>
        )}

        {hits.length > 0 && (
          <div className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/50">
            {hits.map((hit) => (
              <div key={hit.externalId} className="flex items-center gap-3 p-2.5">
                {hit.posterUrl ? (
                  <img
                    src={hit.posterUrl}
                    alt=""
                    className="h-16 w-11 flex-none rounded object-cover"
                    loading="lazy"
                  />
                ) : (
                  <span className="flex h-16 w-11 flex-none items-center justify-center rounded bg-muted text-muted-foreground">
                    <Clapperboard className="size-4" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {hit.title}
                    {hit.year ? ` (${hit.year})` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {hit.kind === "series" ? "সিরিজ" : "মুভি"}
                    {hit.rating ? ` • ★ ${hit.rating.toFixed(1)}` : ""}
                  </p>
                  {hit.overview && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {hit.overview}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={importing === hit.externalId || imported.has(hit.externalId)}
                  onClick={() => doImport(hit)}
                >
                  {imported.has(hit.externalId) ? (
                    "যোগ হয়েছে"
                  ) : importing === hit.externalId ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                  ইমপোর্ট
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
