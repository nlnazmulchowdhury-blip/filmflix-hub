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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "convex/react";
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
import { useEffect, useState } from "react";
import { z } from "zod";

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
  genre: z.string().optional(),
  category: z.string().optional(),
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
  const isEdit = Boolean(movie);

  /* "select" = pick an existing category, "new" = type a fresh one. */
  const [categoryMode, setCategoryMode] = useState<"select" | "new">("select");
  const [selectedCategory, setSelectedCategory] = useState<string>("");

  /* Sync the picker state each time the dialog opens. */
  useEffect(() => {
    if (!open) return;
    const current = movie?.category?.trim() ?? "";
    if (current && categories.includes(current)) {
      setCategoryMode("select");
      setSelectedCategory(current);
    } else {
      setCategoryMode("new");
      setSelectedCategory("");
    }
  }, [open, movie?._id, categories]);

  const emptyValues: MovieFormValues = {
    title: "",
    description: "",
    posterUrl: "",
    backdropUrl: "",
    videoUrl: "",
    genre: "",
    category: "",
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
          genre: m.genre ?? "",
          category: m.category ?? "",
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

  /* Every time the dialog opens, re-fill the form with THIS movie's current
     values — so editing only touches the fields you actually change and all
     the rest are saved back untouched. */
  useEffect(() => {
    if (open) reset(valuesFor(movie));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, movie?._id, reset]);

  const onSubmit = async (values: MovieFormValues) => {
    const payload = {
      title: values.title,
      description: values.description || undefined,
      posterUrl: values.posterUrl || undefined,
      backdropUrl: values.backdropUrl || undefined,
      videoUrl: values.videoUrl || undefined,
      genre: values.genre || undefined,
      category: values.category?.trim() || undefined,
      year: values.year ? Number(values.year) : undefined,
      rating: values.rating ? Number(values.rating) : undefined,
      kind: values.episodes.length > 0 ? ("series" as const) : ("movie" as const),
      episodes:
        values.episodes.length > 0
          ? values.episodes.map((e) => ({
              title: e.title,
              videoUrl: e.videoUrl,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
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
              playlist.
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="genre">Genre</Label>
              <Input id="genre" placeholder="Sci-Fi" {...register("genre")} />
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              {/* Mode switch: pick an existing category, or create a new one. */}
              <div className="flex gap-1 rounded-lg border border-border/60 bg-secondary/40 p-1">
                <button
                  type="button"
                  onClick={() => {
                    setCategoryMode("select");
                    setValue("category", selectedCategory || undefined);
                  }}
                  className={`flex-1 rounded-md px-2 py-1 text-xs font-semibold transition-colors ${
                    categoryMode === "select"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Select existing
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCategoryMode("new");
                    setValue("category", "");
                  }}
                  className={`flex-1 rounded-md px-2 py-1 text-xs font-semibold transition-colors ${
                    categoryMode === "new"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  New category
                </button>
              </div>

              {categoryMode === "select" ? (
                <Select
                  value={selectedCategory}
                  onValueChange={(v) => {
                    setSelectedCategory(v);
                    setValue("category", v);
                  }}
                >
                  <SelectTrigger aria-label="Select category">
                    <SelectValue placeholder="Choose a category…" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        No categories yet — switch to “New category”.
                      </div>
                    ) : (
                      categories.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="category"
                  list="category-options"
                  placeholder="e.g. Hollywood"
                  {...register("category")}
                />
              )}
              <datalist id="category-options">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <p className="text-xs text-muted-foreground">
                Pick where this movie lives — visitors browse the catalog by
                these category sections.
              </p>
            </div>
          </div>

          {/* Episodes / parts playlist */}
          <div className="space-y-2 rounded-xl border border-border/60 bg-secondary/30 p-3">
            <div className="flex items-center justify-between">
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
                      <span className="w-12 shrink-0 text-center text-xs font-semibold text-muted-foreground">
                        #{index + 1}
                      </span>
                      <Input
                        placeholder={`Episode ${index + 1} title`}
                        className="h-8 text-sm"
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
                    <div className="mt-1.5 flex items-start gap-1.5 pl-[54px]">
                      <Input
                        placeholder="Episode video URL (https://…/ep1.mp4)"
                        className="h-8 text-sm"
                        {...register(`episodes.${index}.videoUrl` as const)}
                      />
                      <Input
                        placeholder="Sec"
                        inputMode="numeric"
                        className="h-8 w-16 text-sm"
                        {...register(`episodes.${index}.durationSec` as const)}
                      />
                    </div>
                    {errors.episodes?.[index] && (
                      <p className="mt-1 pl-[54px] text-xs text-destructive">
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
