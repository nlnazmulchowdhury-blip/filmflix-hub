import { Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "sonner";

/**
 * "Upload" button for the admin movie form: opens a file picker, streams the
 * chosen file straight into Convex file storage (admin-only, no size limit)
 * and hands the permanent public URL to the form field.
 */
export default function UploadFileButton({
  onUploaded,
  accept,
  label = "Upload",
  ariaLabel,
}: {
  onUploaded: (url: string) => void;
  accept?: string;
  label?: string;
  ariaLabel?: string;
}) {
  const createUploadUrl = useMutation(api.videoUpload.createUploadUrl);
  const finishUpload = useMutation(api.videoUpload.finishUpload);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const startPick = () => {
    if (busy) return;
    inputRef.current?.click();
  };

  const handleFile = async (file: File) => {
    setBusy(true);
    try {
      const postUrl = await createUploadUrl();
      const res = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res.ok) {
        throw new Error(`Upload failed (${res.status})`);
      }
      const { storageId } = (await res.json()) as { storageId: string };
      const url = await finishUpload({ storageId: storageId as Id<"_storage"> });
      onUploaded(url);
      toast.success(`Uploaded ${file.name}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Upload failed — try again",
      );
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={startPick}
        disabled={busy}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border/70 bg-card/60 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-50"
        aria-label={ariaLabel ?? label}
        title={ariaLabel ?? label}
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Upload className="size-3.5" />
        )}
        {busy ? "Uploading…" : label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
      />
    </>
  );
}
