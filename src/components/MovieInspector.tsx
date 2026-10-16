import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Search, Star, Activity, RefreshCw, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";

/**
 * Full inspector for a catalog title. Unlike the create/edit dialog (which
 * writes the legacy field set), this reaches every column the Worker stores:
 * external ids that unlock Servers 1/3/4, the per-server enable/disable matrix,
 * the default server, an explicit provider embed page, per-resolution downloads,
 * live link-health probes, and the engagement roll-ups — so an embed movie is
 * fully controllable and fully visible from the admin panel.
 */

type ServerKey = "vidsrc" | "vidbox" | "vidapi" | "nxsha" | "anime" | "drama" | "original";
const SERVER_META: { key: ServerKey; name: string; provider: string; needs: string }[] = [
  { key: "vidsrc", name: "VidSrc", provider: "vidsrc.to", needs: "IMDb or TMDB id" },
  { key: "vidbox", name: "vidbox", provider: "vidlink.pro · ad-free resolve", needs: "TMDB id or embed URL" },
  { key: "vidapi", name: "vidapi", provider: "vidapi.ru · iframe fallback", needs: "TMDB id" },
  { key: "nxsha", name: "nxsha", provider: "web.nxsha.app · multi-source", needs: "TMDB id" },
  { key: "anime", name: "Anime · VidNest", provider: "vidnest.fun", needs: "TMDB id" },
  { key: "drama", name: "Drama · Videasy", provider: "player.videasy.to", needs: "TMDB id" },
  { key: "original", name: "This site's file", provider: "native <video>", needs: "stored video URL" },
];

interface Download {
  label: string;
  url: string;
  resolution?: string | null;
}

interface InspectData {
  movie: any;
  engagement: { comments: number; watchlist: number; screenings: number; views: number; lastViewed: number | null };
  dubJobs: { id: string; lang: string; status: string; createdAt: number }[];
  servers: Record<string, boolean>;
}

interface HealthResult {
  movieId: string;
  checked: number;
  failed: number;
  checkedAt: number;
  results: { label: string; url: string; ok: boolean; status: number | null; error: string | null }[];
}

interface SearchHit {
  tmdbId: string;
  kind: string;
  title: string;
  year?: number;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  overview?: string;
  rating?: number;
  embedUrl: string;
}

export default function MovieInspector({
  movieId,
  open,
  onOpenChange,
  onChanged,
}: {
  movieId: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onChanged?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<InspectData | null>(null);
  const [form, setForm] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  const [health, setHealth] = useState<HealthResult | null>(null);
  const [checking, setChecking] = useState(false);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState("");
  const [resolving, setResolving] = useState(false);

  const set = (patch: any) => setForm((f: any) => ({ ...f, ...patch }));

  const load = useCallback(async () => {
    if (!movieId) return;
    setLoading(true);
    setError("");
    setSavedMsg("");
    setHealth(null);
    try {
      const d = await api.get<InspectData>(`/movies/${movieId}/inspect`);
      setData(d);
      const m = d.movie;
      setForm({
        title: m.title ?? "",
        description: m.description ?? "",
        posterUrl: m.posterUrl ?? "",
        backdropUrl: m.backdropUrl ?? "",
        year: m.year ?? "",
        rating: m.rating ?? "",
        kind: m.kind ?? "movie",
        hidden: !!m.hidden,
        videoUrl: m.videoUrl ?? "",
        tmdbId: m.tmdbId ?? "",
        imdbId: m.imdbId ?? "",
        embedUrl: m.embedUrl ?? "",
        defaultServer: m.defaultServer ?? "",
        disabledServers: Array.isArray(m.disabledServers) ? m.disabledServers : [],
        downloads: Array.isArray(m.downloads) ? m.downloads : [],
      });
    } catch (e: any) {
      setError(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [movieId]);

  useEffect(() => {
    if (open && movieId) load();
  }, [open, movieId, load]);

  /* Servers the player can actually reach for the CURRENT ids, ignoring the
     disabled list — so the matrix shows availability vs. what's shown to users
     as two independent facts. */
  const derivedServers = useMemo(() => {
    if (!form) return {} as Record<ServerKey, boolean>;
    const hasImdb = Boolean(form.imdbId), hasTmdb = Boolean(form.tmdbId);
    return {
      vidsrc: hasImdb || hasTmdb,
      vidbox: hasTmdb || Boolean(form.embedUrl),
      vidapi: hasTmdb,
      anime: hasTmdb,
      drama: hasTmdb,
      original: Boolean(form.videoUrl),
    } as Record<ServerKey, boolean>;
  }, [form]);

  const availableList = SERVER_META.filter((s) => derivedServers[s.key]).map((s) => s.key);

  async function runSearch() {
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    setSearchErr("");
    setHits([]);
    try {
      const r = await api.get<{ items: SearchHit[] }>(`/tmdb/search?q=${encodeURIComponent(q)}`);
      setHits(r.items ?? []);
      if (!r.items?.length) setSearchErr("No matches.");
    } catch (e: any) {
      setSearchErr(e?.message ?? "Search failed");
    } finally {
      setSearching(false);
    }
  }

  function pick(hit: SearchHit) {
    set((f: any) => ({
      ...f,
      tmdbId: hit.tmdbId,
      kind: hit.kind === "series" ? "series" : "movie",
      title: f.title || hit.title,
      year: f.year || hit.year || "",
      backdropUrl: f.backdropUrl || hit.backdropUrl || "",
      posterUrl: f.posterUrl || hit.posterUrl || "",
      description: f.description || hit.overview || "",
    }));
    setQuery(hit.title);
    setHits([]);
    resolveImdb(hit.tmdbId, hit.kind);
  }

  async function resolveImdb(tmdbId: string, kind: string) {
    setResolving(true);
    try {
      const r = await api.get<{ imdbId: string | null }>(
        `/tmdb/external?tmdbId=${encodeURIComponent(tmdbId)}&kind=${encodeURIComponent(kind)}`,
      );
      if (r.imdbId) set({ imdbId: r.imdbId });
    } catch {
      /* IMDb id is optional — Server 2/3/4 still work from the TMDB id. */
    } finally {
      setResolving(false);
    }
  }

  async function save() {
    if (!movieId) return;
    setSaving(true);
    setSavedMsg("");
    try {
      await api.patch(`/movies/${movieId}`, {
        title: form.title || null,
        description: form.description || null,
        posterUrl: form.posterUrl || null,
        backdropUrl: form.backdropUrl || null,
        year: form.year === "" ? null : Number(form.year),
        rating: form.rating === "" ? null : Number(form.rating),
        kind: form.kind || null,
        hidden: !!form.hidden,
        tmdbId: form.tmdbId || null,
        imdbId: form.imdbId || null,
        embedUrl: form.embedUrl || null,
        defaultServer: form.defaultServer || null,
        disabledServers: form.disabledServers,
        downloads: form.downloads,
      });
      setSavedMsg("Saved.");
      onChanged?.();
      await load();
    } catch (e: any) {
      setSavedMsg(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function runHealth() {
    if (!movieId) return;
    setChecking(true);
    try {
      const r = await api.post<HealthResult>(`/movies/${movieId}/health`);
      setHealth(r);
    } catch (e: any) {
      setHealth({ movieId, checked: 0, failed: 0, checkedAt: Date.now(), results: [{ label: "Error", url: "", ok: false, status: null, error: e?.message ?? "failed" }] });
    } finally {
      setChecking(false);
    }
  }

  async function quickAction(body: any, note: string) {
    if (!movieId) return;
    try {
      await api.patch(`/movies/${movieId}`, body);
      setSavedMsg(note);
      onChanged?.();
    } catch (e: any) {
      setSavedMsg(e?.message ?? "Action failed");
    }
  }

  function toggleServer(key: ServerKey) {
    setForm((f: any) => {
      const cur: string[] = f.disabledServers ?? [];
      const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
      return { ...f, disabledServers: next };
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">
            {data?.movie?.title ? `Inspect — ${data.movie.title}` : "Inspect title"}
          </DialogTitle>
          <DialogDescription>
            Every stored field for this title: external ids, embed servers, downloads, link health and engagement.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        )}
        {error && <p className="py-6 text-sm text-destructive">{error}</p>}

        {form && !loading && (
          <div className="space-y-6">
            {/* Identity */}
            <section className="space-y-3">
              <SectionTitle>Identity</SectionTitle>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Title">
                  <input className={inputCls} value={form.title} onChange={(e) => set({ title: e.target.value })} />
                </Field>
                <Field label="Kind">
                  <select className={inputCls} value={form.kind} onChange={(e) => set({ kind: e.target.value })}>
                    <option value="movie">Movie</option>
                    <option value="series">Series</option>
                  </select>
                </Field>
                <Field label="Year">
                  <input className={inputCls} type="number" value={form.year} onChange={(e) => set({ year: e.target.value })} />
                </Field>
                <Field label="Rating">
                  <input className={inputCls} type="number" step="0.1" value={form.rating} onChange={(e) => set({ rating: e.target.value })} />
                </Field>
                <Field label="Poster URL">
                  <input className={inputCls} value={form.posterUrl} onChange={(e) => set({ posterUrl: e.target.value })} />
                </Field>
                <Field label="Backdrop URL">
                  <input className={inputCls} value={form.backdropUrl} onChange={(e) => set({ backdropUrl: e.target.value })} />
                </Field>
              </div>
              <Field label="Description">
                <textarea className={inputCls + " min-h-20"} value={form.description} onChange={(e) => set({ description: e.target.value })} />
              </Field>
              {(form.posterUrl || data?.movie?.posterUrl) && (
                <div className="flex gap-3">
                  <img src={form.posterUrl || data?.movie?.posterUrl} alt="" className="h-32 w-24 rounded-md border border-border object-cover" />
                  {form.backdropUrl && (
                    <img src={form.backdropUrl} alt="" className="h-32 w-56 rounded-md border border-border object-cover" />
                  )}
                </div>
              )}
            </section>

            {/* External ids + TMDB picker */}
            <section className="space-y-3">
              <SectionTitle>External ids &amp; catalog picker</SectionTitle>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="TMDB id">
                  <input className={inputCls} value={form.tmdbId} onChange={(e) => set({ tmdbId: e.target.value })} placeholder="e.g. 155" />
                </Field>
                <Field label={"IMDb id" + (resolving ? " · resolving…" : "")}>
                  <input className={inputCls} value={form.imdbId} onChange={(e) => set({ imdbId: e.target.value })} placeholder="e.g. tt1375666" />
                </Field>
              </div>
              <div className="flex gap-2">
                <input
                  className={inputCls + " flex-1"}
                  value={query}
                  placeholder="Search TMDB by title…"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runSearch()}
                />
                <Button type="button" size="sm" variant="outline" onClick={runSearch} disabled={searching}>
                  {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                  <span className="ml-1">Search</span>
                </Button>
              </div>
              {searchErr && <p className="text-xs text-muted-foreground">{searchErr}</p>}
              {hits.length > 0 && (
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border">
                  {hits.map((h) => (
                    <button
                      type="button"
                      key={`${h.kind}-${h.tmdbId}`}
                      onClick={() => pick(h)}
                      className="flex w-full items-center gap-3 px-2 py-1.5 text-left hover:bg-muted"
                    >
                      {h.posterUrl ? (
                        <img src={h.posterUrl} alt="" className="h-12 w-8 rounded object-cover" />
                      ) : (
                        <div className="h-12 w-8 rounded bg-muted" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{h.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {h.kind} · {h.year ?? "—"} · TMDB {h.tmdbId}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Picking a result fills the TMDB id, images and description, then resolves the IMDb id so Server 1 lights up.
              </p>
            </section>

            {/* Server matrix */}
            <section className="space-y-3">
              <SectionTitle>Playback servers</SectionTitle>
              <Field label="Explicit provider embed URL (feeds the vidbox server)">
                <input className={inputCls} value={form.embedUrl} onChange={(e) => set({ embedUrl: e.target.value })} placeholder="https://vidlink.pro/movie/… or leave blank" />
              </Field>
              <div className="space-y-1.5">
                {SERVER_META.map((s) => {
                  const canPlay = derivedServers[s.key];
                  const disabled = (form.disabledServers ?? []).includes(s.key);
                  return (
                    <div key={s.key} className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{s.name}</span>
                          {canPlay ? (
                            <Badge variant="outline" className="border-emerald-500/40 text-emerald-600">available</Badge>
                          ) : (
                            <Badge variant="outline" className="text-muted-foreground">no source</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">{s.provider} · needs {s.needs}</p>
                      </div>
                      <label className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={!disabled}
                          disabled={!canPlay}
                          onChange={() => toggleServer(s.key)}
                        />
                        shown
                      </label>
                    </div>
                  );
                })}
              </div>
              <Field label="Default server (opens first)">
                <select className={inputCls} value={form.defaultServer} onChange={(e) => set({ defaultServer: e.target.value })}>
                  <option value="">Auto</option>
                  {availableList.map((k) => (
                    <option key={k} value={k}>{SERVER_META.find((s) => s.key === k)!.name}</option>
                  ))}
                </select>
              </Field>
            </section>

            {/* Downloads */}
            <section className="space-y-3">
              <SectionTitle>Per-resolution downloads</SectionTitle>
              <div className="space-y-2">
                {form.downloads.map((d: Download, i: number) => (
                  <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input className={inputCls + " sm:w-32"} value={d.label} placeholder="720p" onChange={(e) => {
                      const next = [...form.downloads]; next[i] = { ...d, label: e.target.value }; set({ downloads: next });
                    }} />
                    <input className={inputCls + " flex-1"} value={d.url} placeholder="https://…/file.mp4" onChange={(e) => {
                      const next = [...form.downloads]; next[i] = { ...d, url: e.target.value }; set({ downloads: next });
                    }} />
                    <Button type="button" size="icon" variant="ghost" className="text-destructive" onClick={() => {
                      set({ downloads: form.downloads.filter((_: Download, j: number) => j !== i) });
                    }}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
                <Button type="button" size="sm" variant="outline" onClick={() => set({ downloads: [...form.downloads, { label: "", url: "" }] })}>
                  <Plus className="size-4" /> <span className="ml-1">Add download</span>
                </Button>
              </div>
            </section>

            {/* Media blobs (read-only summary) */}
            {data && (
              <section className="space-y-2">
                <SectionTitle>Stored media</SectionTitle>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <Chip label="Video" on={Boolean(data.movie.videoUrl)} />
                  <Chip label={`Qualities (${(data.movie.qualities ?? []).length})`} on={(data.movie.qualities ?? []).length > 0} />
                  <Chip label={`Dubs (${(data.movie.dubs ?? []).length})`} on={(data.movie.dubs ?? []).length > 0} />
                  <Chip label={`Subtitles (${(data.movie.subtitles ?? []).length})`} on={(data.movie.subtitles ?? []).length > 0} />
                  <Chip label={`Episodes (${(data.movie.episodes ?? []).length})`} on={(data.movie.episodes ?? []).length > 0} />
                  <Chip label={`Seasons (${(data.movie.seasons ?? []).length})`} on={(data.movie.seasons ?? []).length > 0} />
                  <Chip label={`Categories (${(data.movie.categories ?? []).length})`} on={(data.movie.categories ?? []).length > 0} />
                </div>
                <p className="text-xs text-muted-foreground">Edit streams, dubs and episodes in the title's main editor.</p>
              </section>
            )}

            {/* Engagement */}
            {data && (
              <section className="space-y-2">
                <SectionTitle>Engagement</SectionTitle>
                <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Stat icon={<Activity className="size-4" />} label="Views" value={data.engagement.views} />
                  <Stat icon={<Star className="size-4" />} label="Watchlist" value={data.engagement.watchlist} />
                  <Stat label="Comments" value={data.engagement.comments} />
                  <Stat label="Screenings" value={data.engagement.screenings} />
                </div>
                {data.dubJobs.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {data.dubJobs.length} recent dub job(s) — latest {data.dubJobs[0].status}.
                  </p>
                )}
              </section>
            )}

            {/* Link health */}
            <section className="space-y-2">
              <SectionTitle>Link health</SectionTitle>
              <Button type="button" size="sm" variant="outline" onClick={runHealth} disabled={checking}>
                {checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                <span className="ml-1">Check every URL</span>
              </Button>
              {health && (
                <div className="space-y-1 text-xs">
                  <p className="text-muted-foreground">{health.checked} checked · {health.failed} failed.</p>
                  {health.results.map((r, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className={r.ok ? "text-emerald-600" : "text-destructive"}>{r.ok ? "OK" : "FAIL"}</span>
                      <span className="w-32 truncate text-muted-foreground">{r.label}</span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.error ? `${r.status ?? ""} ${r.error}` : r.url}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <Button type="button" size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                <span className="ml-1">Save changes</span>
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => quickAction({ toTop: true }, "Moved to top.")}>
                Move to top
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={async () => {
                  await quickAction({ hidden: !form.hidden }, form.hidden ? "Published." : "Unpublished.");
                  set({ hidden: !form.hidden });
                }}
              >
                {form.hidden ? "Publish" : "Unpublish"}
              </Button>
              {data && (
                <Badge variant={data.movie.hidden ? "destructive" : "outline"}>
                  {data.movie.hidden ? "Hidden from catalog" : "Live"}
                </Badge>
              )}
              {savedMsg && <span className="text-xs text-muted-foreground">{savedMsg}</span>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const inputCls =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-ring";

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="font-display text-sm font-semibold tracking-tight">{children}</h3>;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
function Stat({ icon, label, value }: { icon?: ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-0.5 text-lg font-semibold">{value}</p>
    </div>
  );
}
function Chip({ label, on }: { label: string; on: boolean }) {
  return (
    <Badge variant="outline" className={on ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground"}>
      {label}
    </Badge>
  );
}
