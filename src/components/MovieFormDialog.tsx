import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useAction } from "convex/react";
import {
  ArrowDown,
  ArrowUp,
  Clapperboard,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { movieCategoryNames } from "@/lib/categories";
import { isShortLink } from "@/lib/shortlinks";
import { X, Languages, MonitorPlay, Captions } from "lucide-react";
import UploadFileButton from "@/components/UploadFileButton";

const episodeSchema = z.object({
  title: z.string().min(1, "Episode title is required"),
  videoUrl: z.string().min(1, "Episode video URL is required"),
  durationSec: z.string().optional(),
});

const movieSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  posterUrl: z.string().optional(),
  backdropUrl: z.string().optional(),
  videoUrl: z.string().optional(),
  year: z.string().optional(),
  rating: z.string().optional(),
  episodes: z.array(episodeSchema),
  dubs: z.array(
    z.object({
      label: z.string().min(1, "Language label is required"),
      videoUrl: z.string().min(1, "Video URL is required"),
    }),
  ),
  qualities: z.array(
    z.object({
      label: z.string().min(1, "Quality label is required"),
      videoUrl: z.string().min(1, "Video URL is required"),
    }),
  ),
  subtitles: z.array(
    z.object({
      label: z.string().min(1, "Subtitle label is required"),
      url: z.string().min(1, "Subtitle file URL is required"),
    }),
  ),
});

type MovieFormValues = z.infer<typeof movieSchema>;

export default function MovieFormDialog({
  open,
  onOpenChange,
  movie,
  categories = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  movie: Doc<"movies"> | null;
  categories?: string[];
}) {
  const addMovie = useMutation(api.movies.add);
  const updateMovie = useMutation(api.movies.update);
  const expandShortLinks = useAction(api.shortlinks.expandBatch);
  const isEdit = Boolean(movie);

  /* Multi-category selection: a movie can live in several sections at once.
     "selected" holds the chosen names; typing a new one adds it too. */
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [newCategory, setNewCategory] = useState("");

  const suggestions = useMemo(() => {
    const chosen = new Set(selectedCategories.map((c) => c.toLowerCase()));
    return categories.filter((c) => !chosen.has(c.toLowerCase()));
  }, [categories, selectedCategories]);

  /* Sync the picker state each time the dialog opens. */
  useEffect(() => {
    if (!open) return;
    const names = movieCategoryNames(movie ?? {});
    setSelectedCategories(names);
    setNewCategory("");
  }, [open, movie?._id]);

  const emptyValues: MovieFormValues = {
    title: "",
    description: "",
    posterUrl: "",
    backdropUrl: "",
    videoUrl: "",
    year: "",
    rating: "",
    episodes: [],
    dubs: [],
    qualities: [],
    subtitles: [],
  };

  const valuesFor = (m: Doc<"movies"> | null): MovieFormValues =>
    m
      ? {
          title: m.title,
          description: m.description ?? "",
          posterUrl: m.posterUrl ?? "",
          backdropUrl: m.backdropUrl ?? "",
          videoUrl: m.videoUrl ?? "",
          year: m.year?.toString() ?? "",
          rating: m.rating?.toString() ?? "",
          episodes: (m.episodes ?? []).map((e) => ({
            title: e.title,
            videoUrl: e.videoUrl,
            durationSec: e.durationSec?.toString() ?? "",
          })),
          dubs: (m.dubs ?? []).map((d) => ({
            label: d.label,
            videoUrl: d.videoUrl,
          })),
          qualities: (m.qualities ?? []).map((q) => ({
            label: q.label,
            videoUrl: q.videoUrl,
          })),
          subtitles: (m.subtitles ?? []).map((s) => ({
            label: s.label,
            url: s.url,
          })),
        }
      : emptyValues;

  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<MovieFormValues>({
    resolver: zodResolver(movieSchema),
    defaultValues: valuesFor(movie),
  });

  const { fields, append, remove, move } = useFieldArray({
    control,
    name: "episodes",
  });

  const {
    fields: dubFields,
    append: appendDub,
    remove: removeDub,
  } = useFieldArray({
    control,
    name: "dubs",
  });

  const {
    fields: qualityFields,
    append: appendQuality,
    remove: removeQuality,
  } = useFieldArray({
    control,
    name: "qualities",
  });

  const {
    fields: subtitleFields,
    append: appendSubtitle,
    remove: removeSubtitle,
  } = useFieldArray({
    control,
    name: "subtitles",
  });

  /* Every time the dialog opens, re-fill the form with THIS movie's current
     values — so editing only touches the fields you actually change and all
     the rest are saved back untouched. */
  useEffect(() => {
    if (open) reset(valuesFor(movie));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, movie?._id, reset]);

  const onSubmit = async (values: MovieFormValues) => {
    /* Shortener links (tinyurl/is.gd/…) break video playback — the player
       can't send range requests through the redirect chain. If a short link
       is pasted, resolve it back to the real destination URL server-side
       before saving. Everything else is kept exactly as pasted. */
    const rawUrls = [
      values.posterUrl,
      values.backdropUrl,
      values.videoUrl,
      ...values.episodes.map((e) => e.videoUrl),
      ...values.dubs.map((d) => d.videoUrl),
      ...values.qualities.map((q) => q.videoUrl),
      ...values.subtitles.map((s) => s.url),
    ]
      .map((u) => (u ?? "").trim())
      .filter((u) => u.length > 0);
    const shortOnes = rawUrls.filter(isShortLink);
    const map: Record<string, string> = {};
    if (shortOnes.length > 0) {
      try {
        Object.assign(map, await expandShortLinks({ urls: shortOnes }));
      } catch {
        // Resolver unreachable — save the pasted URLs as-is.
      }
    }
    const clean = (u: string) => {
      const t = (u ?? "").trim();
      if (!t) return undefined;
      return map[t] ?? t;
    };

    const payload = {
      title: values.title,
      description: values.description || undefined,
      posterUrl: clean(values.posterUrl ?? ""),
      backdropUrl: clean(values.backdropUrl ?? ""),
      videoUrl: clean(values.videoUrl ?? ""),
      categories: selectedCategories,
      year: values.year ? Number(values.year) : undefined,
      rating: values.rating ? Number(values.rating) : undefined,
      kind: values.episodes.length > 0 ? ("series" as const) : ("movie" as const),
      episodes:
        values.episodes.length > 0
          ? values.episodes.map((e) => ({
              title: e.title,
              videoUrl: clean(e.videoUrl) ?? "",
              durationSec: e.durationSec ? Number(e.durationSec) : undefined,
            }))
          : undefined,
      dubs:
        values.dubs.length > 0
          ? values.dubs.map((d) => ({
              label: d.label,
              videoUrl: clean(d.videoUrl) ?? "",
            }))
          : undefined,
      qualities:
        values.qualities.length > 0
          ? values.qualities.map((q) => ({
              label: q.label,
              videoUrl: clean(q.videoUrl) ?? "",
            }))
          : undefined,
      subtitles:
        values.subtitles.length > 0
          ? values.subtitles.map((s) => ({
              label: s.label,
              url: clean(s.url) ?? "",
            }))
          : undefined,
    };
    try {
      if (isEdit && movie) {
        await updateMovie({ id: movie._id, ...payload });
        toast.success("Movie updated");
      } else {
        await addMovie(payload);
        toast.success("Movie added to the catalog");
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    }
  };

  const addCategory = () => {
    const name = newCategory.trim();
    if (!name) return;
    if (selectedCategories.some((x) => x.toLowerCase() === name.toLowerCase())) {
      toast.info(`“${name}” is already selected`);
      return;
    }
    setSelectedCategories((prev) => [...prev, name]);
    setNewCategory("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-lg overflow-y-auto rounded-xl sm:w-full">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit movie" : "Add movie"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the details of this catalog entry."
              : "New movies appear in the catalog instantly."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          {/* ---- Section: Basics ------------------------------------ */}
          <section className="space-y-4">
            <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
              <Clapperboard className="size-3.5 text-primary" />
              Basics
            </h3>
            <div className="space-y-2">
              <Label htmlFor="title">Title *</Label>
              <Input id="title" placeholder="e.g. Interstellar" {...register("title")} />
              {errors.title && (
                <p className="text-xs text-destructive">{errors.title.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                rows={3}
                placeholder="Short synopsis…"
                {...register("description")}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="year">Year</Label>
                <Input id="year" inputMode="numeric" placeholder="2024" {...register("year")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rating">Rating (0–10)</Label>
                <Input id="rating" inputMode="decimal" placeholder="8.5" {...register("rating")} />
              </div>
            </div>
          </section>

          <div className="border-t border-border/50" />

          {/* ---- Section: Images ------------------------------------ */}
          <section className="space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Images
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="posterUrl">Poster URL</Label>
                  <UploadFileButton
                    accept="image/*"
                    label="Upload poster"
                    ariaLabel="Upload poster image"
                    onUploaded={(url) => setValue("posterUrl", url, { shouldDirty: true })}
                  />
                </div>
                <Input id="posterUrl" placeholder="https://…" {...register("posterUrl")} />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="backdropUrl">Backdrop URL</Label>
                  <UploadFileButton
                    accept="image/*"
                    label="Upload backdrop"
                    ariaLabel="Upload backdrop image"
                    onUploaded={(url) => setValue("backdropUrl", url, { shouldDirty: true })}
                  />
                </div>
                <Input id="backdropUrl" placeholder="https://…" {...register("backdropUrl")} />
              </div>
            </div>
          </section>

          <div className="border-t border-border/50" />

          {/* ---- Section: Video ------------------------------------- */}
          <section className="space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Video
            </h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="videoUrl">Main video URL (mp4 link)</Label>
                <UploadFileButton
                  accept="video/*"
                  label="Upload video"
                  ariaLabel="Upload main video file"
                  onUploaded={(url) => setValue("videoUrl", url, { shouldDirty: true })}
                />
              </div>
              <Input
                id="videoUrl"
                placeholder="http://…/movie.mp4 or https://…"
                {...register("videoUrl")}
              />
              <p className="text-xs text-muted-foreground">
                Upload a file from this device (no size limit — recommended;
                the file streams from cloud storage and always plays) or paste
                a public URL. Shortener links (tinyurl/is.gd…) are
                automatically resolved to the real video URL before saving.
                Plain <code>http://</code> links are served through the app's
                HTTPS proxy. FTP links and LAN-only addresses (10.x /
                192.168.x) cannot be reached from the cloud — use Upload for
                those.
              </p>
            </div>

            {/* Language dubs — alternate video versions */}
            <div className="space-y-3 rounded-xl border border-border/60 bg-secondary/30 p-3.5">
              <div className="flex flex-col gap-2 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
                <Label className="flex items-center gap-1.5">
                  <Languages className="size-3.5 text-primary" />
                  Language versions ({dubFields.length})
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => appendDub({ label: "", videoUrl: "" })}
                >
                  <Plus className="size-3.5" />
                  Add language
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The main video above is the original. Add Hindi/Bengali dubbed
                versions here — viewers switch languages inside the player.
              </p>

              {dubFields.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/60 p-3.5 text-center text-xs text-muted-foreground">
                  No extra languages yet — only the original audio will play.
                </p>
              ) : (
                <div className="space-y-2">
                  {dubFields.map((field, index) => (
                    <div
                      key={field.id}
                      className="rounded-lg border border-border/50 bg-card/60 p-2.5"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <Languages className="size-3.5" />
                        </span>
                        <Input
                          placeholder="Language name (e.g. Hindi Dub)"
                          className="h-8 min-w-0 text-sm"
                          {...register(`dubs.${index}.label` as const)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7 shrink-0 text-destructive hover:text-destructive"
                          aria-label="Remove language"
                          onClick={() => removeDub(index)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                      <div className="mt-1.5 flex min-[420px]:pl-[38px]">
                        <Input
                          placeholder="Dubbed video URL (https://…/hindi.mp4)"
                          className="h-8 min-w-0 flex-1 text-sm"
                          {...register(`dubs.${index}.videoUrl` as const)}
                        />
                        <UploadFileButton
                          accept="video/*"
                          label="Upload"
                          ariaLabel={`Upload dubbed video for ${dubFields[index]?.label || "language " + (index + 1)}`}
                          onUploaded={(url) =>
                            setValue(`dubs.${index}.videoUrl`, url, { shouldDirty: true })
                          }
                        />
                      </div>
                      {errors.dubs?.[index] && (
                        <p className="mt-1 text-xs text-destructive min-[420px]:pl-[38px]">
                          {errors.dubs[index]?.label?.message ??
                            errors.dubs[index]?.videoUrl?.message}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Quality renditions — 480p/720p/1080p files */}
            <div className="space-y-3 rounded-xl border border-border/60 bg-secondary/30 p-3.5">
              <div className="flex flex-col gap-2 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
                <Label className="flex items-center gap-1.5">
                  <MonitorPlay className="size-3.5 text-primary" />
                  Quality versions ({qualityFields.length})
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => appendQuality({ label: "", videoUrl: "" })}
                >
                  <Plus className="size-3.5" />
                  Add quality
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Optional. Add lower/higher resolution files (e.g. 480p, 720p,
                1080p) — viewers pick one from the player's Quality menu.
              </p>

              {qualityFields.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/60 p-3.5 text-center text-xs text-muted-foreground">
                  No extra qualities yet — the main video plays for everyone.
                </p>
              ) : (
                <div className="space-y-2">
                  {qualityFields.map((field, index) => (
                    <div
                      key={field.id}
                      className="rounded-lg border border-border/50 bg-card/60 p-2.5"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <MonitorPlay className="size-3.5" />
                        </span>
                        <Input
                          placeholder="Quality (e.g. 720p)"
                          className="h-8 min-w-0 text-sm"
                          {...register(`qualities.${index}.label` as const)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7 shrink-0 text-destructive hover:text-destructive"
                          aria-label="Remove quality"
                          onClick={() => removeQuality(index)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                      <div className="mt-1.5 flex min-[420px]:pl-[38px]">
                        <Input
                          placeholder="Video file for this quality (https://…/720p.mp4)"
                          className="h-8 min-w-0 flex-1 text-sm"
                          {...register(`qualities.${index}.videoUrl` as const)}
                        />
                        <UploadFileButton
                          accept="video/*"
                          label="Upload"
                          ariaLabel={`Upload video for ${qualityFields[index]?.label || "quality " + (index + 1)}`}
                          onUploaded={(url) =>
                            setValue(`qualities.${index}.videoUrl`, url, { shouldDirty: true })
                          }
                        />
                      </div>
                      {errors.qualities?.[index] && (
                        <p className="mt-1 text-xs text-destructive min-[420px]:pl-[38px]">
                          {errors.qualities[index]?.label?.message ??
                            errors.qualities[index]?.videoUrl?.message}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Subtitle / caption tracks */}
            <div className="space-y-3 rounded-xl border border-border/60 bg-secondary/30 p-3.5">
              <div className="flex flex-col gap-2 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
                <Label className="flex items-center gap-1.5">
                  <Captions className="size-3.5 text-primary" />
                  Subtitles ({subtitleFields.length})
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => appendSubtitle({ label: "", url: "" })}
                >
                  <Plus className="size-3.5" />
                  Add subtitles
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Optional. Paste WebVTT (.vtt) file links with a display name —
                viewers turn captions on from the player's Subtitles menu.
              </p>

              {subtitleFields.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/60 p-3.5 text-center text-xs text-muted-foreground">
                  No subtitle tracks yet — captions stay off by default.
                </p>
              ) : (
                <div className="space-y-2">
                  {subtitleFields.map((field, index) => (
                    <div
                      key={field.id}
                      className="rounded-lg border border-border/50 bg-card/60 p-2.5"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <Captions className="size-3.5" />
                        </span>
                        <Input
                          placeholder="Name (e.g. English, Bengali)"
                          className="h-8 min-w-0 text-sm"
                          {...register(`subtitles.${index}.label` as const)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7 shrink-0 text-destructive hover:text-destructive"
                          aria-label="Remove subtitles"
                          onClick={() => removeSubtitle(index)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                      <div className="mt-1.5 flex min-[420px]:pl-[38px]">
                        <Input
                          placeholder=".vtt file URL (https://…/english.vtt)"
                          className="h-8 min-w-0 flex-1 text-sm"
                          {...register(`subtitles.${index}.url` as const)}
                        />
                        <UploadFileButton
                          accept=".vtt,text/vtt"
                          label="Upload"
                          ariaLabel={`Upload subtitle file for ${subtitleFields[index]?.label || "track " + (index + 1)}`}
                          onUploaded={(url) =>
                            setValue(`subtitles.${index}.url`, url, { shouldDirty: true })
                          }
                        />
                      </div>
                      {errors.subtitles?.[index] && (
                        <p className="mt-1 text-xs text-destructive min-[420px]:pl-[38px]">
                          {errors.subtitles[index]?.label?.message ??
                            errors.subtitles[index]?.url?.message}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Episodes / parts playlist */}
            <div className="space-y-3 rounded-xl border border-border/60 bg-secondary/30 p-3.5">
              <div className="flex flex-col gap-2 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
                <Label className="flex items-center gap-1.5">
                  <Clapperboard className="size-3.5 text-primary" />
                  Episodes / parts ({fields.length})
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => append({ title: "", videoUrl: "", durationSec: "" })}
                >
                  <Plus className="size-3.5" />
                  Add episode
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Listed in order — viewers see them as a playlist under the
                player. Add at least one episode to mark this entry as a series.
              </p>

              {fields.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/60 p-3.5 text-center text-xs text-muted-foreground">
                  No episodes yet — a single-movie entry needs only the main
                  video URL above.
                </p>
              ) : (
                <div className="space-y-2">
                  {fields.map((field, index) => (
                    <div
                      key={field.id}
                      className="rounded-lg border border-border/50 bg-card/60 p-2.5"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="w-8 shrink-0 text-center text-xs font-semibold text-muted-foreground sm:w-10">
                          #{index + 1}
                        </span>
                        <Input
                          placeholder={`Episode ${index + 1} title`}
                          className="h-8 min-w-0 text-sm"
                          {...register(`episodes.${index}.title` as const)}
                        />
                        <div className="flex shrink-0 gap-0.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label="Move up"
                            disabled={index === 0}
                            onClick={() => move(index, index - 1)}
                          >
                            <ArrowUp className="size-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label="Move down"
                            disabled={index === fields.length - 1}
                            onClick={() => move(index, index + 1)}
                          >
                            <ArrowDown className="size-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 text-destructive hover:text-destructive"
                            aria-label="Remove episode"
                            onClick={() => remove(index)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                      <div className="mt-1.5 flex flex-col gap-1.5 pl-0 min-[420px]:flex-row min-[420px]:items-start min-[420px]:pl-[38px]">
                        <div className="flex min-w-0 flex-1 gap-1.5">
                          <Input
                            placeholder="Episode video URL (https://…/ep1.mp4)"
                            className="h-8 min-w-0 flex-1 text-sm"
                            {...register(`episodes.${index}.videoUrl` as const)}
                          />
                          <UploadFileButton
                            accept="video/*"
                            label="Upload"
                            ariaLabel={`Upload video for episode ${index + 1}`}
                            onUploaded={(url) =>
                              setValue(`episodes.${index}.videoUrl`, url, { shouldDirty: true })
                            }
                          />
                        </div>
                        <Input
                          placeholder="Sec"
                          inputMode="numeric"
                          className="h-8 w-full text-sm min-[420px]:w-16"
                          {...register(`episodes.${index}.durationSec` as const)}
                        />
                      </div>
                      {errors.episodes?.[index] && (
                        <p className="mt-1 text-xs text-destructive min-[420px]:pl-[38px]">
                          {errors.episodes[index]?.title?.message ??
                            errors.episodes[index]?.videoUrl?.message}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <div className="border-t border-border/50" />

          {/* ---- Section: Categories -------------------------------- */}
          <section className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Categories
            </h3>
            <div className="space-y-2">

            {/* Chosen categories as removable chips. */}
            {selectedCategories.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedCategories.map((c) => (
                  <span
                    key={c}
                    className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 py-1 pl-3 pr-1.5 text-xs font-semibold text-primary"
                  >
                    {c}
                    <button
                      type="button"
                      aria-label={`Remove category ${c}`}
                      onClick={() =>
                        setSelectedCategories((prev) =>
                          prev.filter((x) => x !== c),
                        )
                      }
                      className="rounded-full p-0.5 text-primary/70 transition-colors hover:bg-primary/20 hover:text-destructive"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Add via suggestion chips or a free-text input (Enter adds). */}
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() =>
                      setSelectedCategories((prev) => [...prev, c])
                    }
                    className="rounded-full border border-border/70 bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                  >
                    + {c}
                  </button>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Input
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCategory();
                  }
                }}
                list="category-options"
                placeholder="Type a new category and press Enter…"
              />
              <datalist id="category-options">
                {suggestions.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <Button type="button" variant="outline" onClick={addCategory}>
                Add
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              A movie can live in several sections at once — pick from the
              existing ones or type new names and press Enter.
            </p>
            </div>
          </section>

          <DialogFooter className="gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting} className="gap-2">
              {isSubmitting && <Loader2 className="size-4 animate-spin" />}
              {isEdit ? "Save changes" : "Add movie"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
