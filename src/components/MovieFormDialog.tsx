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
  year: z.string().optional(),
  rating: z.string().optional(),
  episodes: z.array(episodeSchema),
});

type MovieFormValues = z.infer<typeof movieSchema>;

export default function MovieFormDialog({
  open,
  onOpenChange,
  movie,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  movie: Doc<"movies"> | null;
}) {
  const addMovie = useMutation(api.movies.add);
  const updateMovie = useMutation(api.movies.update);
  const isEdit = Boolean(movie);

  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<MovieFormValues>({
    resolver: zodResolver(movieSchema),
    defaultValues: movie
      ? {
          title: movie.title,
          description: movie.description ?? "",
          posterUrl: movie.posterUrl ?? "",
          backdropUrl: movie.backdropUrl ?? "",
          videoUrl: movie.videoUrl ?? "",
          genre: movie.genre ?? "",
          year: movie.year?.toString() ?? "",
          rating: movie.rating?.toString() ?? "",
          episodes: (movie.episodes ?? []).map((e) => ({
            title: e.title,
            videoUrl: e.videoUrl,
            durationSec: e.durationSec?.toString() ?? "",
          })),
        }
      : {
          title: "",
          description: "",
          posterUrl: "",
          backdropUrl: "",
          videoUrl: "",
          genre: "",
          year: "",
          rating: "",
          episodes: [],
        },
  });

  const { fields, append, remove, move } = useFieldArray({
    control,
    name: "episodes",
  });

  const onSubmit = async (values: MovieFormValues) => {
    const payload = {
      title: values.title,
      description: values.description || undefined,
      posterUrl: values.posterUrl || undefined,
      backdropUrl: values.backdropUrl || undefined,
      videoUrl: values.videoUrl || undefined,
      genre: values.genre || undefined,
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

          <div className="space-y-2">
            <Label htmlFor="genre">Genre</Label>
            <Input id="genre" placeholder="Sci-Fi" {...register("genre")} />
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
