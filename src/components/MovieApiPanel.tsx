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
import type { ElaachSearchHit } from "@/convex/elaach";
import type { MbSearchHit } from "@/convex/movieBox";
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
  const mbSearch = useAction(api.movieBox.searchAction);
  const mbImport = useAction(api.movieBox.importMovie);
  const eaSearch = useAction(api.elaach.searchAction);
  const eaImport = useAction(api.elaach.importMovie);

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

  const [mbQ, setMbQ] = useState("");
  const [mbSearching, setMbSearching] = useState(false);
  const [mbHits, setMbHits] = useState<MbSearchHit[]>([]);
  const [mbImporting, setMbImporting] = useState<string | null>(null);
  const [mbImported, setMbImported] = useState<Set<string>>(new Set());
  const [mbImportedInfo, setMbImportedInfo] = useState<
    Record<
      string,
      {
        downloads: number;
        videoKind?: "movie" | "trailer" | "none";
        detailError?: string;
        resourceError?: string;
      }
    >
  >({});

  const runMbSearch = async () => {
    const query = mbQ.trim();
    if (!query) return;
    setMbSearching(true);
    try {
      const hits = await mbSearch({ q: query });
      setMbHits(hits);
      if (hits.length === 0) toast.info("MovieBox-এ কিছু পাওয়া যায়নি");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "MovieBox search failed");
    } finally {
      setMbSearching(false);
    }
  };

  const doMbImport = async (hit: MbSearchHit) => {
    setMbImporting(hit.subjectId);
    try {
      const res = await mbImport({
        subjectId: hit.subjectId,
        fallback: {
          title: hit.title,
          year: hit.year,
          posterUrl: hit.posterUrl,
          overview: hit.overview,
          rating: hit.rating,
          kind: hit.kind,
          genre: hit.genre,
        },
      });
      setMbImported((prev) => new Set(prev).add(hit.subjectId));
      setMbImportedInfo((prev) => ({
        ...prev,
        [hit.subjectId]: {
          downloads: res.downloads,
          videoKind: res.videoKind,
          detailError: res.detailError,
          resourceError: res.resourceError,
        },
      }));
      if (res.videoKind === "movie") {
        toast.success(
          `"${res.title}" ইমপোর্ট হয়েছে — প্লেয়ারে পুরো মুভি চলবে`,
        );
      } else if (res.videoKind === "trailer") {
        toast.info(
          `"${res.title}" ইমপোর্ট হয়েছে — পুরো মুভি প্রোভাইডারে লকড, প্লেয়ারে ট্রেলার চলবে`,
        );
      } else if (res.downloads > 0) {
        toast.warning(
          `"${res.title}" ইমপোর্ট হয়েছে (${res.downloads} লিংক) কিন্তু প্লেয়ারে চালানোর মতো ভিডিও পাওয়া যায়নি`,
        );
      } else {
        toast.error(
          `"${res.title}" ক্যাটালগে গেছে, কিন্তু ডাউনলোড লিংক পাওয়া যায়নি — ${res.resourceError ?? res.detailError ?? "অজানা কারণ"}`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setMbImporting(null);
    }
  };

  const [eaQ, setEaQ] = useState("");
  const [eaSearching, setEaSearching] = useState(false);
  const [eaHits, setEaHits] = useState<ElaachSearchHit[]>([]);
  const [eaImporting, setEaImporting] = useState<string | null>(null);
  const [eaImported, setEaImported] = useState<Set<string>>(new Set());
  const [eaImportedInfo, setEaImportedInfo] = useState<
    Record<string, { videoKind: "movie" | "none"; quality?: string }>
  >({});

  const runEaSearch = async () => {
    const query = eaQ.trim();
    if (!query) return;
    setEaSearching(true);
    try {
      const hits = await eaSearch({ q: query });
      setEaHits(hits);
      if (hits.length === 0) toast.info("Elaach-এ কিছু পাওয়া যায়নি");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Elaach search failed");
    } finally {
      setEaSearching(false);
    }
  };

  const doEaImport = async (hit: ElaachSearchHit) => {
    setEaImporting(hit.imdbId);
    try {
      const res = await eaImport({
        imdbId: hit.imdbId,
        section: hit.section,
        fallback: {
          title: hit.title,
          posterUrl: hit.posterUrl,
          rating: hit.rating,
          genre: hit.genre,
          kind: hit.kind,
        },
      });
      setEaImported((prev) => new Set(prev).add(hit.imdbId));
      setEaImportedInfo((prev) => ({
        ...prev,
        [hit.imdbId]: { videoKind: res.videoKind, quality: res.quality },
      }));
      if (res.videoKind === "movie") {
        toast.success(
          `"${res.title}" ইমপোর্ট হয়েছে — সরাসরি mp4 প্লেয়ারে চলবে${res.quality ? ` (${res.quality})` : ""}`,
        );
      } else {
        toast.warning(
          `"${res.title}" ক্যাটালগে গেছে, কিন্তু কোনো ভিডিও লিংক পাওয়া যায়নি`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setEaImporting(null);
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
        {/* MovieBox (AOneRoom) — no key needed, signed like the official app */}
        <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">MovieBox (AOneRoom)</span>
            <Badge
              variant="outline"
              className="border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            >
              <ShieldCheck className="size-3" /> কী ছাড়া চলে
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            মুভি সার্চ করে ইমপোর্ট করলে পোস্টার, বর্ষ, রেটিং ও
            <span className="font-medium"> 360p–1080p ডাউনলোড লিংক</span> অটোমেটিক ভরে যাবে — পরে চাইলে এডিট করে নিতে পারবেন।
          </p>
          <p className="text-xs text-muted-foreground">
            {settings?.mbProxy ? (
              <>
                <span className="font-medium text-emerald-600 dark:text-emerald-400">
                  পুরো মুভি রেজলভার প্রক্সি চালু
                </span>{
                  " "
                }
                <span className="font-mono">{settings.mbProxy}</span>
              </>
            ) : (
              <>
                <span className="font-medium text-amber-600 dark:text-amber-400">
                  পুরো মুভি ফাইল এখন বন্ধ:
                </span>{
                  " "
                }
                প্রোভাইডার ডেটা-সেন্টার IP (মানে এই সার্ভার) থেকে ডাউনলোড
                এন্ডপয়েন্ট ব্লক করে — তাই ইমপোর্টে প্লেয়ারে প্রোভাইডারের আসল
                ট্রেলার যোগ হয়। নিচের গাইড অনুযায়ী Convex-এ
                <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">MOVIEBOX_WEB_PROXY</code>
                সেট করলে ইমপোর্ট থেকেই পুরো মুভি প্লে হবে।
              </>
            )}
          </p>
          <details className="group rounded-lg border border-border/50 bg-background/50 p-2.5 text-xs">
            <summary className="cursor-pointer select-none font-medium">
              পুরো মুভি চালাতে প্রক্সি সেটআপ গাইড (Cloudflare Worker)
            </summary>
            <div className="mt-2 space-y-2 text-muted-foreground">
              <p>
                ১. Cloudflare Workers-এ ফ্রি একটা Worker বানান (residential
                egress সাধারণত ব্লক হয় না) আর নিচের কোডটা বসান —
                এটা প্রোভাইডারের দরকারি Referer হেডার নিজে বসিয়ে দেয়:
              </p>
              <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed text-foreground">
{`export default {
  async fetch(req) {
    const u = new URL(req.url);
    const sid = u.searchParams.get("subjectId");
    const target = "https://h5.aoneroom.com/wefeed-h5-bff/web/subject/download"
      + "?subjectId=" + sid + "&se=0&ep=0";
    return fetch(target, { headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://h5.aoneroom.com/movies/m-x?id=" + sid,
    }});
  },
}`}
              </pre>
              <p>
                ২. Convex ড্যাশবোর্ড → Settings → Environment Variables-এ
                যোগ করুন:
                <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">MOVIEBOX_WEB_PROXY = https://আপনার-worker.workers.dev</code>
              </p>
              <p>৩. এরপর ইমপোর্ট করলেই প্লেয়ারে পুরো মুভি চলবে (360p–1080p কোয়ালিটি মেনুসহ)।</p>
            </div>
          </details>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              runMbSearch();
            }}
          >
            <Input
              value={mbQ}
              onChange={(e) => setMbQ(e.target.value)}
              placeholder="MovieBox-এ মুভি সার্চ করুন…"
              aria-label="MovieBox search"
              className="flex-1"
            />
            <Button
              type="submit"
              className="gap-2 sm:w-auto"
              disabled={mbSearching || !mbQ.trim()}
            >
              {mbSearching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
              MovieBox-এ সার্চ
            </Button>
          </form>

          {mbHits.length > 0 && (
            <div className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/50 bg-background">
              {mbHits.map((hit) => (
                <div key={hit.subjectId} className="flex items-center gap-3 p-2.5">
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
                      {hit.genre ? ` • ${hit.genre}` : ""}
                    </p>
                    {hit.overview && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {hit.overview}
                      </p>
                    )}
                    {mbImported.has(hit.subjectId) &&
                      mbImportedInfo[hit.subjectId] &&
                      (mbImportedInfo[hit.subjectId].downloads > 0 ||
                        mbImportedInfo[hit.subjectId].resourceError) && (
                        <p
                          className={`mt-1 text-xs ${
                            mbImportedInfo[hit.subjectId].videoKind === "trailer"
                              ? "text-amber-600 dark:text-amber-400"
                              : mbImportedInfo[hit.subjectId].videoKind === "movie"
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-destructive"
                          }`}
                        >
                          {mbImportedInfo[hit.subjectId].videoKind === "movie"
                            ? "পুরো মুভি প্লেয়ারে চলবে"
                            : mbImportedInfo[hit.subjectId].videoKind === "trailer"
                              ? "প্রোভাইডারে পুরো মুভি লকড — প্লেয়ারে ট্রেলার যোগ হয়েছে"
                              : mbImportedInfo[hit.subjectId].downloads > 0
                                ? `${mbImportedInfo[hit.subjectId].downloads} টি লিংক যোগ হয়েছে, কিন্তু চালানোর মতো ভিডিও নেই`
                                : "কোনো ডাউনলোড লিংক পাওয়া যায়নি"}
                          {mbImportedInfo[hit.subjectId].resourceError &&
                            ` — ${mbImportedInfo[hit.subjectId].resourceError}`}
                        </p>
                      )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={
                      mbImporting === hit.subjectId || mbImported.has(hit.subjectId)
                    }
                    onClick={() => doMbImport(hit)}
                  >
                    {mbImported.has(hit.subjectId) ?
                      `যোগ হয়েছে${
                        mbImportedInfo[hit.subjectId]?.downloads
                          ? ` (${mbImportedInfo[hit.subjectId].downloads} লিংক)`
                          : ""
                      }`
                    : mbImporting === hit.subjectId ? (
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
        </div>

        {/* Elaach (elaach.com) — server-rendered HTML: search + direct mp4 */}
        <div className="space-y-2 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Elaach (elaach.com)</span>
            <Badge
              variant="outline"
              className="border-sky-500/50 bg-sky-500/10 text-sky-600 dark:text-sky-400"
            >
              <ShieldCheck className="size-3" /> কী ছাড়া চলে
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            সার্চ করে ইমপোর্ট করলে পোস্টার, বর্ষ, রেটিং, জনরা, বর্ণনা আর
            <span className="font-medium"> সরাসরি mp4 লিংক</span> একসাথে ক্যাটালগে ঢুকে
            যাবে — প্লেয়ার ও ডাউনলোড মেনুতে ব্যবহার হবে।
          </p>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              runEaSearch();
            }}
          >
            <Input
              value={eaQ}
              onChange={(e) => setEaQ(e.target.value)}
              placeholder="Elaach-এ মুভি সার্চ করুন…"
              aria-label="Elaach search"
              className="flex-1"
            />
            <Button
              type="submit"
              className="gap-2 sm:w-auto"
              disabled={eaSearching || !eaQ.trim()}
            >
              {eaSearching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
              Elaach-এ সার্চ
            </Button>
          </form>

          {eaHits.length > 0 && (
            <div className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/50 bg-background">
              {eaHits.map((hit) => (
                <div key={`${hit.section}/${hit.imdbId}`} className="flex items-center gap-3 p-2.5">
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
                    <p className="truncate text-sm font-medium">{hit.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {hit.kind === "series" ? "সিরিজ" : "মুভি"}
                      {hit.rating ? ` • ★ ${hit.rating.toFixed(1)}` : ""}
                      {hit.genre ? ` • ${hit.genre}` : ""}
                    </p>
                    {eaImported.has(hit.imdbId) && eaImportedInfo[hit.imdbId] && (
                      <p
                        className={`mt-1 text-xs ${
                          eaImportedInfo[hit.imdbId].videoKind === "movie"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-amber-600 dark:text-amber-400"
                        }`}
                      >
                        {eaImportedInfo[hit.imdbId].videoKind === "movie"
                          ? `পুরো মুভি প্লেয়ারে চলবে${
                              eaImportedInfo[hit.imdbId].quality
                                ? ` (${eaImportedInfo[hit.imdbId].quality})`
                                : ""
                            }`
                          : "ক্যাটালগে যোগ হয়েছে, কিন্তু ভিডিও লিংক পাওয়া যায়নি"}
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={eaImporting === hit.imdbId || eaImported.has(hit.imdbId)}
                    onClick={() => doEaImport(hit)}
                  >
                    {eaImported.has(hit.imdbId) ? (
                      "যোগ হয়েছে"
                    ) : eaImporting === hit.imdbId ? (
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
        </div>

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
