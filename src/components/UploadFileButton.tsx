import { Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

/**
 * "Upload" button for the admin movie form: opens a file picker, streams the
 * chosen file into the Worker's R2-backed /uploads endpoints (admin-only)
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
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const startPick = () => {
    if (busy) return;
    inputRef.current?.click();
  };

  const handleFile = async (file: File) => {
    setBusy(true);
    try {
      const res1 = await fetch(`/uploads/url`, { method: "POST" });
      const target = await res1.json();
      if (!res1.ok) throw new Error(target?.error ?? `Upload setup failed (${res1.status})`);

      const res2 = await fetch(`/uploads/object/${target.storageId}`, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res2.ok) throw new Error(`Upload failed (${res2.status})`);

      const res3 = await fetch(`/uploads/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageId: target.storageId }),
      });
      const finished = await res3.json();
      if (!res3.ok) throw new Error(finished?.error ?? `Upload finalize failed (${res3.status})`);
      onUploaded(finished.url);
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
