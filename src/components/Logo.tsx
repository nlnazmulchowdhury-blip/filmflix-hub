export default function Logo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <span className="relative flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_4px_20px_-4px_var(--primary)]">
        <svg viewBox="0 0 24 24" fill="none" className="size-5">
          <path
            d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5v-13Z"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <path d="M4 9h16M9.5 3.5v5.2M14.5 3.5v5.2" stroke="currentColor" strokeWidth="1.8" />
          <path d="m11 13.2 4 2.3-4 2.3v-4.6Z" fill="currentColor" />
        </svg>
      </span>
      <span className="font-display text-xl font-bold tracking-tight">
        Film<span className="text-primary">Flix</span>
      </span>
    </span>
  );
}
