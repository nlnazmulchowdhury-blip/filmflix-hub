import { useEffect, useState } from "react";
import { Loader2, Save, Smartphone, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  PLATFORMS,
  formatSize,
  listAppBuilds,
  removeAppBuild,
  saveAppBuild,
  type AppBuild,
  type AppPlatform,
} from "@/lib/app-builds";
import { toast } from "sonner";

/** Which OS gets a real download button on the landing "Get the app" cards. */
export default function AppBuildsPanel() {
  const [builds, setBuilds] = useState<Record<string, AppBuild>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<AppPlatform | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { url: string; version: string; notes: string }>>({});

  const reload = () =>
    listAppBuilds()
      .then((rows) => {
        const map = Object.fromEntries(rows.map((r) => [r.platform, r]));
        setBuilds(map);
        setDrafts((prev) => {
          const next = { ...prev };
          for (const r of rows)
            if (!next[r.platform])
              next[r.platform] = { url: r.url, version: r.version, notes: r.notes };
          return next;
        });
      })
      .catch((err: Error) => toast.error(err.message))
      .finally(() => setLoading(false));

  useEffect(() => {
    void reload();
  }, []);

  const draftOf = (p: AppPlatform) =>
    drafts[p] ?? { url: builds[p]?.url ?? "", version: builds[p]?.version ?? "", notes: builds[p]?.notes ?? "" };

  const setDraft = (p: AppPlatform, field: "url" | "version" | "notes", value: string) =>
    setDrafts((d) => ({ ...d, [p]: { ...draftOf(p), [field]: value } }));

  const save = async (p: AppPlatform) => {
    const d = draftOf(p);
    if (!d.url.trim()) {
      toast.error("Add the download URL first");
      return;
    }
    setSaving(p);
    try {
      await saveAppBuild(p, { url: d.url.trim(), version: d.version.trim(), notes: d.notes.trim() });
      toast.success(`${p} build published`);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(null);
    }
  };

  const clear = async (p: AppPlatform) => {
    setSaving(p);
    try {
      await removeAppBuild(p);
      setDrafts((d) => ({ ...d, [p]: { url: "", version: "", notes: "" } }));
      toast.success(`${p} card is back to browser install`);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card className="overflow-hidden p-0">
      <CardHeader className="border-b border-border/50 py-4">
        <CardTitle className="font-display flex items-center gap-2 text-lg">
          <Smartphone className="size-4 text-primary" /> App builds
        </CardTitle>
        <CardDescription>
          Point each platform at the file you publish (GitHub release, Drive mirror, or an R2
          object URL). A platform with a URL shows a real Download button and QR on the
          /download page; one without it falls back to "install as a web app".
        </CardDescription>
      </CardHeader>

      <CardContent className="divide-y divide-border/50 p-0">
        {loading && (
          <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading builds…
          </p>
        )}
        {!loading &&
          PLATFORMS.map((p) => {
            const build = builds[p.key];
            const d = draftOf(p.key);
            return (
              <div key={p.key} className="p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-display text-sm font-semibold">{p.label}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {p.file}
                  </Badge>
                  {build ? (
                    <Badge variant="outline" className="border-primary/50 bg-primary/10 text-[10px] text-primary">
                      live{build.version ? ` · v${build.version}` : ""}
                      {formatSize(build.sizeBytes) ? ` · ${formatSize(build.sizeBytes)}` : ""}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      browser install
                    </Badge>
                  )}
                </div>

                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px_minmax(0,1fr)_auto]">
                  <Input
                    value={d.url}
                    onChange={(e) => setDraft(p.key, "url", e.target.value)}
                    placeholder="https://…/filmflix.apk"
                    className="font-mono text-xs"
                  />
                  <Input
                    value={d.version}
                    onChange={(e) => setDraft(p.key, "version", e.target.value)}
                    placeholder="version"
                    className="text-xs"
                  />
                  <Input
                    value={d.notes}
                    onChange={(e) => setDraft(p.key, "notes", e.target.value)}
                    placeholder="note shown on the card (optional)"
                    className="text-xs"
                  />
                  <div className="flex items-center gap-2">
                    <Button size="sm" className="gap-1.5" disabled={saving === p.key} onClick={() => save(p.key)}>
                      {saving === p.key ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Save className="size-3.5" />
                      )}
                      {build ? "Update" : "Publish"}
                    </Button>
                    {build && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        disabled={saving === p.key}
                        onClick={() => clear(p.key)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
      </CardContent>
    </Card>
  );
}
