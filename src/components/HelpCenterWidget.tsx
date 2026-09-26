import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Headset, Loader2, MessageCircle, Send, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";

const WIDGET_OPEN_KEY = "ff-help-open";

/** Floating help-center button (bottom-right) + live chat with the admin. */
export default function HelpCenterWidget() {
  const { isLoading, isAuthenticated, user } = useAuth();
  const messages = useQuery(api.support.listMine, isAuthenticated ? {} : "skip");
  const unread = useQuery(api.support.unreadForUser, isAuthenticated ? {} : "skip");
  const send = useMutation(api.support.sendFromUser);
  const markSeen = useMutation(api.support.markSeenByUser);

  const [open, setOpen] = useState(
    () => localStorage.getItem(WIDGET_OPEN_KEY) === "1",
  );
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Persist open/closed across pages in the SPA.
  useEffect(() => {
    localStorage.setItem(WIDGET_OPEN_KEY, open ? "1" : "0");
  }, [open]);

  // Opening the panel clears the unread badge.
  useEffect(() => {
    if (open && isAuthenticated && (unread ?? 0) > 0) {
      markSeen({});
    }
  }, [open, isAuthenticated, unread, markSeen]);

  // Keep the latest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length, open]);

  if (isLoading) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || isSending) return;
    setIsSending(true);
    try {
      await send({ text });
      setDraft("");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <>
      {/* Floating button */}
      {!open && (
        <button
          type="button"
          aria-label="Help center"
          title="Help center — chat with us"
          onClick={() => setOpen(true)}
          className="fixed bottom-4 right-4 z-50 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/40 transition-transform hover:scale-105 sm:bottom-6 sm:right-6"
        >
          <Headset className="size-6" />
          {(unread ?? 0) > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-bold leading-5 text-destructive-foreground">
              {unread}
            </span>
          )}
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-4 right-4 z-50 flex h-[28rem] w-[calc(100vw-2rem)] max-w-sm flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl sm:bottom-6 sm:right-6">
          {/* Header */}
          <div className="flex items-center gap-2.5 border-b border-border/60 bg-primary px-4 py-3 text-primary-foreground">
            <span className="flex size-9 items-center justify-center rounded-full bg-primary-foreground/15">
              <Headset className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-display text-sm font-semibold">Help Center</p>
              <p className="text-xs text-primary-foreground/75">
                We usually reply within a few minutes
              </p>
            </div>
            <button
              type="button"
              aria-label="Close chat"
              onClick={() => setOpen(false)}
              className="rounded-full p-1.5 transition-colors hover:bg-primary-foreground/15"
            >
              <X className="size-4" />
            </button>
          </div>

          {!isAuthenticated ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <MessageCircle className="size-6" />
              </span>
              <p className="text-sm text-muted-foreground">
                Sign in to chat with our team — your conversation is saved to
                your account.
              </p>
            </div>
          ) : (
            <>
              {/* Messages */}
              <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
                {messages === undefined ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                    <span className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <MessageCircle className="size-5" />
                    </span>
                    <p className="text-sm font-medium">Hi {user?.name ?? "there"} 👋</p>
                    <p className="text-xs text-muted-foreground">
                      Ask anything about movies, plans, or playback — we're here
                      to help.
                    </p>
                  </div>
                ) : (
                  messages.map((m) => (
                    <div
                      key={m._id}
                      className={`flex ${m.sender === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm ${
                          m.sender === "user"
                            ? "rounded-br-md bg-primary text-primary-foreground"
                            : "rounded-bl-md bg-muted text-foreground"
                        }`}
                      >
                        {m.text}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Composer */}
              <form onSubmit={submit} className="flex items-center gap-2 border-t border-border/60 p-3">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Type your message…"
                  maxLength={1000}
                  className="h-10 min-w-0 flex-1 rounded-full border border-input bg-background px-4 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
                />
                <button
                  type="submit"
                  aria-label="Send message"
                  disabled={isSending || !draft.trim()}
                  className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
                >
                  {isSending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                </button>
              </form>
            </>
          )}
        </div>
      )}
    </>
  );
}