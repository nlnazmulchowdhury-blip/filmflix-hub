import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Headset, Loader2, MessageCircle, Send, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";

const WIDGET_OPEN_KEY = "ff-help-open";
const LONG_PRESS_MS = 450;

/** Floating help-center button (bottom-right) + live chat with the admin. */
export default function HelpCenterWidget() {
  const { isLoading, isAuthenticated, user } = useAuth();
  const messages = useQuery(api.support.listMine, isAuthenticated ? {} : "skip");
  const unread = useQuery(api.support.unreadForUser, isAuthenticated ? {} : "skip");
  const send = useMutation(api.support.sendFromUser);
  const editMsg = useMutation(api.support.editFromUser);
  const deleteMsg = useMutation(api.support.deleteFromUser);
  const markSeen = useMutation(api.support.markSeenByUser);

  const [open, setOpen] = useState(
    () => localStorage.getItem(WIDGET_OPEN_KEY) === "1",
  );
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Long-press state: timer ref + which message shows the edit/delete menu.
  const pressTimer = useRef<number | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [isEditSaving, setIsEditSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

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

  // Clear a pending long-press timer when the widget unmounts.
  useEffect(() => {
    return () => {
      if (pressTimer.current != null) window.clearTimeout(pressTimer.current);
    };
  }, []);

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

  const startPress = (id: string) => {
    clearPress();
    pressTimer.current = window.setTimeout(() => {
      setMenuId(id);
    }, LONG_PRESS_MS);
  };
  const openEdit = (id: string, text: string) => {
    setMenuId(null);
    setEditingId(id);
    setEditDraft(text);
  };
  const askDelete = (id: string) => {
    setMenuId(null);
    setDeletingId(id);
  };
  const clearPress = () => {
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const saveEdit = async () => {
    const text = editDraft.trim();
    if (!text || !editingId || isEditSaving) return;
    setIsEditSaving(true);
    try {
      await editMsg({ messageId: editingId as never, text });
      setEditingId(null);
      setEditDraft("");
    } finally {
      setIsEditSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deletingId || isDeleting) return;
    setIsDeleting(true);
    try {
      await deleteMsg({ messageId: deletingId as never });
      setDeletingId(null);
    } finally {
      setIsDeleting(false);
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
              <div
                ref={scrollRef}
                onPointerDown={() => menuId && setMenuId(null)}
                className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3"
              >
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
                      to help. <span className="sr-only">Hold a message to edit or delete it.</span>
                    </p>
                  </div>
                ) : (
                  messages.map((m) =>
                    m.sender !== "user" ? (
                      <div key={m._id} className="flex justify-start">
                        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-sm text-foreground">
                          {m.text}
                        </div>
                      </div>
                    ) : editingId === m._id ? (
                      /* Inline edit box for the user's own message */
                      <div key={m._id} className="flex justify-end">
                        <div className="w-[85%] rounded-2xl rounded-br-md border border-primary/50 bg-background p-2">
                          <textarea
                            autoFocus
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            maxLength={1000}
                            rows={2}
                            className="w-full resize-none rounded-md bg-background px-1.5 py-1 text-sm outline-none"
                          />
                          <div className="mt-1 flex justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="rounded-full px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={saveEdit}
                              disabled={isEditSaving || !editDraft.trim()}
                              className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                            >
                              {isEditSaving ? "Saving…" : "Save"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      /* Own message — hold to edit/delete */
                      <div key={m._id} className="relative flex justify-end">
                        <div
                          role="button"
                          tabIndex={0}
                          aria-label="Hold to edit or delete message"
                          onPointerDown={() => startPress(m._id)}
                          onPointerUp={clearPress}
                          onPointerLeave={clearPress}
                          onPointerCancel={clearPress}
                          onContextMenu={(e) => e.preventDefault()}
                          className="max-w-[80%] cursor-pointer touch-none select-none whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground"
                        >
                          {m.text}
                        </div>
                        {menuId === m._id && (
                          <div
                            onPointerDown={(e) => e.stopPropagation()}
                            className="absolute right-2 top-0 z-10 -translate-y-1/2 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
                          >
                            <button
                              type="button"
                              onClick={() => openEdit(m._id, m.text)}
                              className="block w-full px-4 py-2 text-left text-xs font-medium hover:bg-secondary"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => askDelete(m._id)}
                              className="block w-full border-t border-border/60 px-4 py-2 text-left text-xs font-medium text-destructive hover:bg-destructive/10"
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    ),
                  )
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

              {/* Delete confirmation (own message) */}
              {deletingId && (
                <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-background/80 p-6 backdrop-blur-sm">
                  <div className="w-full max-w-xs rounded-xl border border-border bg-card p-4 text-center shadow-xl">
                    <p className="text-sm font-semibold">Delete this message?</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      This cannot be undone.
                    </p>
                    <div className="mt-3 flex justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => setDeletingId(null)}
                        className="rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={confirmDelete}
                        disabled={isDeleting}
                        className="rounded-full bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground disabled:opacity-50"
                      >
                        {isDeleting ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
