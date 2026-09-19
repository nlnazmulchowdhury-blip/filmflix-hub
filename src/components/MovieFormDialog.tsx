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
import { X } from "lucide-react";

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
        }
      : emptyValues;

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<MovieFormValues>({
    resolver: zodResolver(movieSchema),
    defaultValues: valuesFor(movie),
  });

  const { fields, append, remove, move } = useFieldArray({
    control,
    name: "episodes",
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
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="posterUrl">Poster URL</Label>
              <Input id="posterUrl" placeholder="https://…" {...register("posterUrl")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="backdropUrl">Backdrop URL</Label>
              <Input id="backdropUrl" placeholder="https://…" {...register("backdropUrl")} />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="videoUrl">Main video URL (mp4 link)</Label>
            <Input
              id="videoUrl"
              placeholder="https://…/movie.mp4"
              {...register("videoUrl")}
            />
            <p className="text-xs text-muted-foreground">
              The trailer or main feature. Episodes listed below get their own
              playlist. Shortener links (tinyurl/is.gd…) are automatically
              resolved to the real video URL before saving.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="year">Year</Label>
              <Input id="year" inputMode="numeric" placeholder="2024" {...register("year")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rating">Rating (0–10)</Label>
              <Input id="rating" inputMode="decimal" placeholder="8.5" {...register("rating")} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Categories (multi-select)</Label>

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

          {/* Episodes / parts playlist */}
          <div className="space-y-2 rounded-xl border border-border/60 bg-secondary/30 p-3">
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
              Listed in order — viewers see them as a playlist under the player.
              Add at least one episode to mark this entry as a series.
            </p>

            {fields.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground">
                No episodes yet — a single-movie entry needs only the main video
                URL above.
              </p>
            ) : (
              <div className="space-y-2">
                {fields.map((field, index) => (
                  <div
                    key={field.id}
                    className="rounded-lg border border-border/50 bg-card/60 p-2.5"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="w-8 shrink-0 text-center text-xs font-semibold text-muted-foreground sm:w-12">
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
                    <div className="mt-1.5 flex flex-col gap-1.5 pl-0 min-[420px]:flex-row min-[420px]:items-start min-[420px]:pl-[50px]">
                      <Input
                        placeholder="Episode video URL (https://…/ep1.mp4)"
                        className="h-8 min-w-0 flex-1 text-sm"
                        {...register(`episodes.${index}.videoUrl` as const)}
                      />
                      {/* long URLs are resolved on save — no manual work needed */}
                      <Input
                        placeholder="Sec"
                        inputMode="numeric"
                        className="h-8 w-full text-sm min-[420px]:w-16"
                        {...register(`episodes.${index}.durationSec` as const)}
                      />
                    </div>
                    {errors.episodes?.[index] && (
                      <p className="mt-1 text-xs text-destructive min-[420px]:pl-[50px]">
                        {errors.episodes[index]?.title?.message ??
                          errors.episodes[index]?.videoUrl?.message}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

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
