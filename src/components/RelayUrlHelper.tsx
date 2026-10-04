import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

const BASE_KEY = "ff-relay-base";
const TOKEN_KEY = "ff-relay-token";

/** news24 HD → news24-hd (keeps Bangla letters, collapses the rest to dashes) */
function slugifyChannel(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u0980-\u09ff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || name.trim();
}

/** Local / private-network URLs the relay is meant to sit in front of. */
function looksPrivateUrl(u: string): boolean {
  return /^(https?:\/\/(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|ftp:\/\/)/i.test(
    u.trim(),
  );
}

interface RelayUrlHelperProps {
  /** Current channel name — used to suggest the relay slug. */
  channelName: string;
  /** Form's stream URL — offered as the local channels.json entry if it looks private. */
  suggestLocalUrl?: string;
  /** Apply the generated public URL as the channel's primary stream URL. */
  onUsePublic: (url: string) => void;
  /** Append the generated public URL to the channel's backup URLs. */
  onAddBackup: (url: string) => void;
}

export default function RelayUrlHelper({
  channelName,
  suggestLocalUrl = "",
  onUsePublic,
  onAddBackup,
}: RelayUrlHelperProps) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState("");
  const [token, setToken] = useState("");
  const [slug, setSlug] = useState("");
  const [localUrl, setLocalUrl] = useState("");
  const [copied, setCopied] = useState<"url" | "json" | null>(null);
  const didPrefill = useRef(false);

  useEffect(() => {
    setBase(localStorage.getItem(BASE_KEY) ?? "");
    setToken(localStorage.getItem(TOKEN_KEY) ?? "");
  }, []);

  const effSlug = useMemo(
    () => (slug.trim() || slugifyChannel(channelName)).replace(/^\/+|\/+$/g, ""),
    [slug, channelName],
  );

  const publicUrl = useMemo(() => {
    const b = base.trim();
    if (!b || !effSlug) return "";
    const origin = /^https?:\/\//i.test(b) ? b : `https://${b}`;
    try {
      const u = new URL(`/c/${effSlug}`, origin);
      if (token.trim()) u.searchParams.set("k", token.trim());
      return u.toString();
    } catch {
      return "";
    }
  }, [base, token, effSlug]);

  const jsonSnippet = useMemo(
    () =>
      effSlug && localUrl.trim() ? `"${effSlug}": "${localUrl.trim()}"` : "",
    [effSlug, localUrl],
  );

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (next && !didPrefill.current) {
        didPrefill.current = true;
        if (!localUrl && looksPrivateUrl(suggestLocalUrl)) {
          setLocalUrl(suggestLocalUrl.trim());
        }
      }
      return next;
    });
  };

  const copy = async (text: string, k: "url" | "json") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(k);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error("Copy failed — please select the text manually");
    }
  };

  return (
    <div className="rounded-md border border-dashed border-border/70 bg-muted/20 p-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex items-center gap-1.5">
          <Link2 className="size-3.5 shrink-0" />
          Relay URL helper — build a public URL from your re-stream server
        </span>
        <span aria-hidden>{open ? "-" : "+"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-2.5">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor={`${uid}-base`} className="text-[11px] font-medium text-muted-foreground">
                Relay base URL
              </label>
              <Input
                id={`${uid}-base`}
                value={base}
                onChange={(e) => {
                  setBase(e.target.value);
                  localStorage.setItem(BASE_KEY, e.target.value);
                }}
                placeholder="https://tv.example.com"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${uid}-token`} className="text-[11px] font-medium text-muted-foreground">
                Token (only if RELAY_TOKEN is set)
              </label>
              <Input
                id={`${uid}-token`}
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  localStorage.setItem(TOKEN_KEY, e.target.value);
                }}
                placeholder="optional ?k= token"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${uid}-slug`} className="text-[11px] font-medium text-muted-foreground">
                Channel slug (key in channels.json)
              </label>
              <Input
                id={`${uid}-slug`}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder={slugifyChannel(channelName) || "news24"}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${uid}-local`} className="text-[11px] font-medium text-muted-foreground">
                Local ISP stream URL
              </label>
              <Input
                id={`${uid}-local`}
                value={localUrl}
                onChange={(e) => setLocalUrl(e.target.value)}
                placeholder="http://10.x.x.x/live/ch/index.m3u8"
              />
            </div>
          </div>

          {publicUrl ? (
            <div className="space-y-2">
              <div className="min-w-0 break-all rounded-md border border-border/60 bg-background/60 p-2 font-mono text-[11px] text-foreground/90">
                {publicUrl}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => copy(publicUrl, "url")}
                >
                  {copied === "url" ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  Copy URL
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    onUsePublic(publicUrl);
                    toast.success("Set as Stream URL");
                  }}
                >
                  Use as Stream URL
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    onAddBackup(publicUrl);
                    toast.success("Added to Backup URLs");
                  }}
                >
                  Add to Backup URLs
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Enter the relay base URL to generate the public link — setup guide
              lives in <span className="font-mono">relay/README.md</span>.
            </p>
          )}

          {jsonSnippet && (
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">
                Add this line to{" "}
                <span className="font-mono">relay/channels.json</span> on the
                relay VPS:
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border border-border/60 bg-background/60 p-2 font-mono text-[11px]">
                  {jsonSnippet}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="Copy channels.json line"
                  onClick={() => copy(jsonSnippet, "json")}
                >
                  {copied === "json" ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}