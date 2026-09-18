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
import { Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

const movieSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  posterUrl: z.string().optional(),
  backdropUrl: z.string().optional(),
  videoUrl: z.string().optional(),
  genre: z.string().optional(),
  year: z.string().optional(),
  rating: z.string().optional(),
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
        },
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
      kind: "movie" as const,
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
          <DialogTitle>
            {isEdit ? "Edit movie" : "Add movie"}
          </DialogTitle>
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
            <Label htmlFor="videoUrl">Video URL (mp4 link)</Label>
            <Input
              id="videoUrl"
              placeholder="https://…/movie.mp4"
              {...register("videoUrl")}
            />
            <p className="text-xs text-muted-foreground">
              Direct video file link (mp4/webm).
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
