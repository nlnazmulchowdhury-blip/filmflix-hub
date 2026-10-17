import { useMiniPlayer } from "@/components/mini-player-context";
import { vidsrcEmbedUrl } from "@/lib/vidsrc";
import { animeEmbedUrl, dramaEmbedUrl } from "@/lib/autoembed";
import { vidboxEmbedUrl, vixsrcEmbedUrl, nxshaEmbedUrl } from "@/lib/vaplayer";
import {
  isEmbedUrl,
  probeEmbedPage,
  raceEmbedStreams,
  fetchEmbedQualities,
  fetchTitleDownloads,
  type EmbedCandidate,
  type TitleDownloadProvider,
} from "@/lib/embed-resolver";
import { downloadHls, proxyUrl, saveBlob, isHlsLink } from "@/lib/hls-download";
import { browserDecodesHevc, onPlaybackFailure } from "@/lib/playback-health";
import {
  setSnifferReferer,
  useSniffedStreams,
  type SniffedStream,
} from "@/lib/media-sniffer";
import {
  Captions,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Gauge,
  Languages,
  Link2,
  Loader2,
  Maximize,
  Minimize,
  Moon,
  Pause,
  PictureInPicture2,
  Play,
  Repeat,
  RotateCcw,
  RotateCw,
  Server,
  Settings,
  Share2,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";

function formatTime(sec: number) {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Inline home of the persistent video while the user is on the movie page.
 * Registers its slot with the MiniPlayerProvider; the provider portals the
 * single video element in here. In mini mode it shows a bring-back panel.
 */
export default function PlayerStage({
  movieId,
  videoUrl,
  title,
  posterUrl,
  backdropUrl,
  imdbId,
  tmdbId,
  kind,
  season,
  episode,
  disabledServers,
  defaultServer,
  providerEmbedUrl,
}: {
  movieId: string;
  videoUrl: string;
  title: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  /** External IDs used to build the VidSrc "Server 1" embed URL. */
  imdbId?: string | null;
  tmdbId?: string | null;
  kind?: "movie" | "series" | null;
  /** Season/episode for series embeds (defaults to 1/1). */
  season?: number;
  episode?: number;
  /** Server keys an admin turned off for this title — hidden from the menu. */
  disabledServers?: string[];
  /** Server key the admin chose to open on; falls back to the auto heuristic. */
  defaultServer?: string;
  /** Explicit provider embed page an admin stored (feeds the vidbox server). */
  providerEmbedUrl?: string | null;
}) {
  const {
    movie,
    mode,
    isActive,
    hasStarted,
    playing,
    muted,
    volume,
    currentTime,
    duration,
    bufferedEnd,
    controlsOverlayVisible,
    setControlsOverlayVisible,
    setControlsHold,
    bumpControlsActivity,
    activeDub,
    setDub,
    nightMode,
    setNightMode,
    loop,
    setLoop,
    rotation,
    setRotation,
    playbackRate,
    setPlaybackRate,
    activeQuality,
    setQuality,
    activeSubtitle,
    setSubtitle,
    streamSubtitleLabels,
    registerStage,
    start,
    setMode,
    close,
    controls,
  } = useMiniPlayer();

  const containerRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /** Cursor is over the control bar — keep the bar up while it is. */
  const [hoveringControls, setHoveringControls] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrubbingRef = useRef(false);
  const scrubRef = useRef<HTMLDivElement | null>(null);

  /* The overlay is visible when the provider says so (mouse hover inside
     the surface or a recent tap), when the cursor rests on the control bar,
     or whenever playback is not running (paused/never started). */
  const controlsVisible =
    controlsOverlayVisible || hoveringControls || !playing || !hasStarted;
  const [settingsView, setSettingsView] = useState<
    "main" | "subtitles" | "speed" | "quality"
  >("main");
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dubs = movie?.dubs ?? [];
  const qualities = movie?.qualities ?? [];
  const subtitles = movie?.subtitles ?? [];

  /* -------- Playback server: stored file vs VidSrc "Server 1" -------- */
  const vidsrcUrl = vidsrcEmbedUrl({ imdbId, tmdbId, kind, season, episode });
  /* A stored URL that is actually a provider player page (vidlink.pro,
     vixsrc.to, …) — it goes through the embed resolver, never to <video>.
     An admin can also pin an explicit provider page (embed_url). */
  const embedSource = providerEmbedUrl || (isEmbedUrl(videoUrl) ? videoUrl : "");
  const hasNativeSource =
    (Boolean(videoUrl) && !embedSource) || dubs.length > 0 || qualities.length > 0;

  /* The two ad-free provider chains, each its own selectable server:
     vidbox  → vidlink.pro (server-side resolvable; an admin-pinned embedSource
               is a vidlink.pro page, so it belongs to the vidbox server).
     vidapi  → vixsrc.to. The key is what it replaced: admin rows store their
               server choices by key, not by provider.
     nxsha   → web.nxsha.app: a multi-source player that switches upstream hosts
               by itself. Iframe-only (its stream is fetched by client JS). */
  const vidboxTarget =
    embedSource || vidboxEmbedUrl({ tmdbId, imdbId, kind, season, episode });
  const vixsrcTarget = vixsrcEmbedUrl({ tmdbId, imdbId, kind, season, episode });
  const nxshaTarget = nxshaEmbedUrl({ tmdbId, imdbId, kind, season, episode });

  /* vidlink.pro ships HEVC-only files, and a browser without hardware HEVC
     shows a permanent black rectangle for them — for those viewers that
     provider stays off the opening pick (see baseDefault). */
  const hevc = browserDecodesHevc();

  /* Numbered server list — 1, 2, 3… in menu order. `off()` drops any server the
     admin disabled for this title; each server still keys off the ids it
     actually needs so a disabled-but-unbuildable server never shows a dead tab.
     Ad-free sources come first: the provider iframe is the only place the
     provider's own ads can run, so it should never be the default pick. */
  const off = (k: string) => Array.isArray(disabledServers) && disabledServers.includes(k);
  const servers: { key: string; label: string; sub?: string }[] = [];
  let serverNo = 0;
  if (hasNativeSource && !off("original"))
    servers.push({
      key: "original",
      label: `Server ${++serverNo}`,
      sub: "This site's file · no ads",
    });
  if (vidboxTarget && !off("vidbox"))
    servers.push({
      key: "vidbox",
      label: `Server ${++serverNo}`,
      sub: hevc ? "vidbox · ad-free" : "vidbox · needs HEVC",
    });
  if (vixsrcTarget && !off("vidapi"))
    servers.push({ key: "vidapi", label: `Server ${++serverNo}`, sub: "vixsrc · HLS player" });
  if (nxshaTarget && !off("nxsha"))
    servers.push({
      key: "nxsha",
      label: `Server ${++serverNo}`,
      sub: "nxsha · multi-source",
    });
  if (vidsrcUrl && !off("vidsrc"))
    servers.push({ key: "vidsrc", label: `Server ${++serverNo}`, sub: "VidSrc · has ads" });
  /* Anime/Drama episode servers key off the TMDB id — only offer them when
     the current title actually has one. */
  if (tmdbId && !off("anime"))
    servers.push({ key: "anime", label: `Server ${++serverNo}`, sub: "Anime · VidNest · has ads" });
  if (tmdbId && !off("drama"))
    servers.push({ key: "drama", label: `Server ${++serverNo}`, sub: "Drama · Videasy · has ads" });

  /* Default to Server 1 only when there is no stored file to play — so the
     API-backed embed auto-plays for catalog entries without a local source,
     while existing files keep their native player (quality/dub/subtitles).
     An admin-set default wins, but only when that server is actually shown;
     otherwise fall back to the same heuristic, then to the first live server. */
  const baseDefault = hasNativeSource
    ? "original"
    : vidboxTarget && hevc
      ? "vidbox"
      : nxshaTarget
        ? "nxsha"
        : vixsrcTarget
          ? "vidapi"
          : vidsrcUrl && !videoUrl
            ? "vidsrc"
            : "original";
  const usableKeys = servers.map((s) => s.key);
  const wanted =
    defaultServer && usableKeys.includes(defaultServer) ? defaultServer : baseDefault;
  const initialServer = usableKeys.includes(wanted) ? wanted : (usableKeys[0] ?? baseDefault);
  const [server, setServer] = useState<
    "original" | "vidsrc" | "vidbox" | "vidapi" | "nxsha" | "anime" | "drama"
  >(initialServer as any);
  const [serverOpen, setServerOpen] = useState(false);
  const usingVidSrc = server === "vidsrc" && Boolean(vidsrcUrl);
  /* The provider-page servers: each shows that provider's own iframe, and each
     gets a server-side ad-free resolve attempt before it. */
  const usingEmbed =
    server === "vidbox" || server === "vidapi" || server === "nxsha";
  const currentEmbedTarget =
    server === "vidapi"
      ? vixsrcTarget
      : server === "nxsha"
        ? nxshaTarget
        : vidboxTarget;

  /* -------- Episode servers: 3 = Anime (VidNest), 4 = Drama (Videasy) -------- */
  const [aeEpisode, setAeEpisode] = useState(episode ?? 1);
  /* The episode list under the player also selects the episode, so a pick
     there has to move this stepper instead of being overridden by it. */
  useEffect(() => {
    setAeEpisode(episode ?? 1);
  }, [episode]);

  const usingAutoembed = server === "anime" || server === "drama";
  const autoembedUrl =
    server === "anime"
      ? animeEmbedUrl({ tmdbId, kind, season, episode: aeEpisode })
      : server === "drama"
        ? dramaEmbedUrl({ tmdbId, kind, season, episode: aeEpisode })
        : "";
  /* The URL of whichever full-cover iframe server is active ("" = none). */
  const iframeServerUrl = (usingVidSrc ? vidsrcUrl : autoembedUrl) ?? "";

  /* -------- Embed resolver ("Server 2"): provider page → raw HLS stream ---- */
  const [embedUrl, setEmbedUrl] = useState(embedSource);
  const [embedStatus, setEmbedStatus] = useState<
    "idle" | "resolving" | "ready" | "failed"
  >("idle");
  const [embedCandidates, setEmbedCandidates] = useState<EmbedCandidate[]>([]);
  const [embedError, setEmbedError] = useState("");
  const [embedStream, setEmbedStream] = useState<string | null>(null);
  const [embedPanelOpen, setEmbedPanelOpen] = useState(false);
  /* Provider page health for the active server: null = still probing. */
  const [embedLive, setEmbedLive] = useState<boolean | null>(null);
  /* Whether that page says it carries this title. Only the provider's own
     server-rendered word counts, so this stays false for the hosts that give
     no signal — the notice then tells the viewer the page may not have it. */
  const [embedCarried, setEmbedCarried] = useState(false);
  /* Servers already found dead, so the walk never loops back onto one. */
  const deadEmbeds = useRef<Set<string>>(new Set());
  /* The provider whose stream the race played: its tab may be selected after
     the stream is running, and re-resolving that page would restart the film. */
  const playedEmbedTarget = useRef<string>("");
  /* Title+episode the provider race has already been fired for, so switching
     servers afterwards only probes instead of racing the whole lineup again. */
  const racedFor = useRef<string>("");
  /* Title+episode whose resolved stream is right now on screen. Selecting a
     different server must not restart it — that read as "this server broke the
     video" even though the movie was playing fine a moment before. */
  const streamedFor = useRef<string>("");
  /* The server the viewer tapped, tagged with the title it was tapped on and
     kept until the stage moves there. The race moves this label by itself, so a
     tap would otherwise read as one of those moves and the film would keep
     playing on a provider nobody chose. */
  const tappedServer = useRef<string>("");
  /* Resolved streams this title already died on in the player. They stay black
     if the race hands them back, so the next pick skips them. */
  const deadStreams = useRef<Set<string>>(new Set());

  /* One race per title and episode: season/episode picks from the list under
     the player change this, so each new episode gets every server asked again. */
  const raceKey = `${movieId}|${season ?? 1}|${episode ?? 1}`;

  /* The provider iframe is visible for as long as an embed server is selected
     and no ad-free stream has been resolved — including while the resolver is
     still running. Our own player has nothing to play in that window, and a
     black stage with a dead play button reads as a broken site. A page the
     provider itself 500s stays hidden: its error wall is not a player. */
  const embedIframe = usingEmbed && !embedStream && embedLive !== false;
  const embedDead = usingEmbed && !embedStream && embedLive === false;

  /* -------- Download menu: this site's files + the resolved stream's
      resolutions (asked from the Worker when the menu opens). -------- */
  const [downloadOpen, setDownloadOpen] = useState(false);
  const downloadFiles: { label: string; url: string }[] = [];
  if (videoUrl && !embedSource)
    downloadFiles.push({ label: "Main file", url: videoUrl });
  for (const q of qualities)
    if (q.videoUrl) downloadFiles.push({ label: q.label, url: q.videoUrl });
  const streamProbeUrl = embedStream || embedCandidates[0]?.url || "";
  /* The provider whose page is framed, named in the failed-race notice. */
  const embedHost = (() => {
    try {
      return new URL((embedUrl || embedSource) as string).hostname.replace(
        /^www\./,
        "",
      );
    } catch {
      return "this provider";
    }
  })();

  const playEmbedCandidate = useCallback(
    (c: EmbedCandidate) => {
      setEmbedStream(c.url);
      setEmbedPanelOpen(false);
      /* The Worker read the playlist off the response, so its word is what
         decides the player path — several providers sign `/playlist/{id}`
         style URLs with no .m3u8 in them at all. */
      start(
        {
          movieId,
          title,
          videoUrl: c.url,
          isHls: c.kind === "hls",
          posterUrl,
          backdropUrl,
        },
        true,
      );
    },
    [start, movieId, title, posterUrl, backdropUrl],
  );

  /* A provider page is only as good as the stream we can pull out of it
     server-side. Every provider for the title is asked at once and whichever
     answers first is what the viewer gets, while the provider player is
     already on screen — a hit swaps to the clean stream, a miss leaves the
     provider playing. A page the provider itself 500s stays hidden.
     `only` narrows the ask to the one provider the viewer tapped. */
  const raceServers = useCallback(
    async (
      activeKey: string,
      chains: { key: string; url: string }[],
      pages: { key: string; url: string }[],
      only = "",
    ) => {
      setEmbedStatus("resolving");
      setEmbedError("");

      /* Ask for every provider's stream and check every provider page at the
         same time: the fastest chain wins, and the page probes decide which
         iframe to fall back on without waiting for each server in turn. */
      const liveness = pages.map((p) =>
        probeEmbedPage(p.url).then((r) => ({
          ...p,
          /* A probe that never answered is not evidence the provider is down. */
          live: r ? r.live : true,
          carried: r?.carried ?? false,
        })),
      );

      /* Nothing ad-free worked (or what worked later died in the player), so a
         provider player takes the stage. Its page probes decide which one:
         a provider with no page for this title is skipped instead of framed. */
      const showProviders = async (why: string) => {
        const answers = await Promise.all(liveness);
        for (const a of answers) {
          if (a.live) deadEmbeds.current.delete(a.key);
          else deadEmbeds.current.add(a.key);
        }
        setEmbedCandidates([]);
        setEmbedStatus("failed");
        setEmbedError(`${why} A provider player is shown instead.`);

        const mine = answers.find((a) => a.key === activeKey);
        setEmbedLive(mine ? mine.live : true);
        /* Whose player gets framed: one that says it carries this title beats
           one that merely answers. Several providers serve their own "we don't
           have this" wall at HTTP 200, so staying put would leave the viewer
           staring at it while another server plays the film. */
        const next =
          !mine || mine.carried
            ? undefined
            : answers.find(
                (a) =>
                  a.key !== activeKey && a.live && (a.carried || !mine.live),
              );
        if (next) {
          setEmbedCarried(next.carried);
          setEmbedLive(true);
          setServer(next.key as typeof server);
        } else {
          setEmbedCarried(mine?.carried ?? false);
        }
      };

      /* A tapped server is answered by that server alone — and without the
         direct-API detour, which belongs to no provider and would leave the
         viewer watching a stream from somewhere else under the name they chose. */
      const solo = Boolean(only) && chains.some((c) => c.url === only);
      const race = await raceEmbedStreams(
        solo ? chains.filter((c) => c.url === only).map((c) => c.url) : chains.map((c) => c.url),
        solo
          ? { tmdbId: null }
          : { tmdbId, kind, season, episode: usingAutoembed ? aeEpisode : (episode ?? 1) },
      );
      if (race.win) {
        const step = chains.find((c) => c.url === race.win?.url);
        /* Skip links this title already failed on, and — for a viewer without
           HEVC decode — anything the provider labels HEVC. */
        const pool = race.win.candidates.filter(
          (c) => !deadStreams.current.has(c.url) && (hevc || c.codec !== "hevc"),
        );
        if (pool.length) {
          setEmbedCandidates(race.win.candidates);
          setEmbedStatus("ready");
          setEmbedLive(true);
          /* The tab label follows the provider that actually answered. The
             resolver effect lets that switch through without asking the same
             page to resolve a second time, which would restart the movie. A win
             from the direct API belongs to no page, so nothing is re-probed and
             the server the viewer chose stays exactly where it is. */
          streamedFor.current = raceKey;
          playedEmbedTarget.current = race.direct ? "" : race.win.url;
          if (!race.direct && step && step.key !== activeKey)
            setServer(step.key as typeof server);
          /* A candidate whose CDN refuses cross-origin reads can only be played
             by the provider's own session; keep it listed but do not let it
             replace a stream the player can fetch itself. */
          const best = pool.find((c) => c.cors !== false) ?? pool[0];
          playEmbedCandidate(best);
          return;
        }
      }

      await showProviders(race.win
        ? "Every stream it offered died in this player."
        : race.error || "No ad-free chain worked.");
    },
    [playEmbedCandidate, server, tmdbId, kind, season, episode, aeEpisode, hevc, raceKey],
  );

  /** The resolver panel's button: retry the page currently in the box. */
  const runEmbedResolve = useCallback(
    (url: string) => raceServers(server, [{ key: server, url }], [{ key: server, url }]),
    [raceServers, server],
  );

  /* Every ad-free provider available for this title/episode, honouring the
     servers an admin switched off. These are what the race asks in parallel —
     the episode-only anime/drama providers are left out because their player
     pages answer 200 for any TMDB id, so they can never be judged by a probe. */
  const adFreeChains = () =>
    [
      { key: "vidbox", url: vidboxTarget },
      { key: "vidapi", url: vixsrcTarget },
      { key: "nxsha", url: nxshaTarget },
    ].filter((c) => c.url && !off(c.key)) as { key: string; url: string }[];

  /* An embed server (vidbox/vidapi/nxsha) is showing: fire the whole provider
     race for this title+episode. Switching servers or episodes re-runs it,
     clearing the previous server's candidates/stream first; a server switch
     that the race itself caused only re-probes, so it never loops. */
  useEffect(() => {
    if (!usingEmbed) return;
    if (playedEmbedTarget.current === currentEmbedTarget) {
      /* The race already plays a stream pulled from this provider — the label
         moved here, the movie must not be re-resolved. */
      playedEmbedTarget.current = "";
      setEmbedUrl(currentEmbedTarget);
      setEmbedLive(true);
      return;
    }
    setEmbedUrl(currentEmbedTarget);
    if (!currentEmbedTarget) {
      setEmbedLive(false);
      return;
    }
    const chains = adFreeChains();
    const pages = [
      ...chains,
      ...(vidsrcUrl && !off("vidsrc") ? [{ key: "vidsrc", url: vidsrcUrl }] : []),
    ];
    /* A tap on this title's chip outranks the stream already on screen. */
    const tapped =
      tappedServer.current === `${raceKey}|${server}` ? currentEmbedTarget : "";
    if (!tapped && (streamedFor.current === raceKey || (racedFor.current === raceKey && !embedStream))) {
      /* Already raced for this title — and if its stream is on screen, this is
         just the viewer moving between server chips, which must never restart
         the film. Only learn whether this page is up and really has the title. */
      void probeEmbedPage(currentEmbedTarget).then((r) => {
        setEmbedLive(r ? r.live : true);
        setEmbedCarried(r?.carried ?? false);
      });
      return;
    }
    if (tapped) tappedServer.current = "";
    racedFor.current = raceKey;
    streamedFor.current = "";
    setEmbedCandidates([]);
    setEmbedError("");
    setEmbedStream(null);
    setEmbedLive(null);
    setEmbedCarried(false);
    void raceServers(server, chains, pages, tapped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usingEmbed, currentEmbedTarget, raceKey]);

  /* An iframe-only server opened instead (VidSrc, or a server the admin
     pinned): the ad-free providers are still worth asking, so the fastest one
     that yields a stream takes the stage rather than leaving the viewer inside
     a provider player that may not carry the title. A file this site hosts is
     never disturbed — it already plays here. */
  useEffect(() => {
    if (usingEmbed || hasNativeSource) return;
    /* Anime/drama are deliberately outside the race — their pages answer 200
       for any TMDB id, so a probe cannot judge them and they would hijack the
       winner onto a wrong show. Only VidSrc asks here. */
    if (server !== "vidsrc") return;
    if (tappedServer.current === `${raceKey}|${server}`) {
      /* The viewer asked for this provider's own player, so its iframe keeps the
         stage — pulling an ad-free stream out from under them would put back
         the server they just moved away from. */
      return;
    }
    if (racedFor.current === raceKey) return;
    const chains = adFreeChains();
    if (!chains.length) return;
    racedFor.current = raceKey;
    void raceServers(server, chains, chains);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usingEmbed, hasNativeSource, raceKey, server]);

  /* A stream the resolver handed over can still die in the player: the CDN
     answers Cloudflare but refuses the viewer, the token expires mid-load, or
     the codec is one this machine cannot decode. Whatever the reason, the stage
     must go back to the provider player that was already showing the film —
     leaving a black rectangle with a dead play button is what reads as
     "the embed servers don't work". */
  const handBackToProvider = useCallback(
    (url: string, why: string) => {
      if (!embedStream || url !== embedStream) return;
      deadStreams.current.add(url);
      setEmbedStream(null);
      setEmbedCandidates((prev) => prev.filter((c) => c.url !== url));
      setEmbedStatus("failed");
      setEmbedError(why);
      setEmbedLive(true);
      /* Re-arm the race for this title: switching chips should ask the
         providers again rather than reuse a lineup that just failed. */
      racedFor.current = "";
      streamedFor.current = "";
      /* Put the provider page back as the movie's source so the media element
         goes empty instead of retrying the link that just died. */
      const page = currentEmbedTarget || embedSource;
      if (page)
        start(
          { movieId, title, videoUrl: page, posterUrl, backdropUrl },
          true,
        );
    },
    [embedStream, currentEmbedTarget, embedSource, start, movieId, title, posterUrl, backdropUrl],
  );

  useEffect(
    () =>
      onPlaybackFailure((failed) =>
        handBackToProvider(failed, "That ad-free link died in this player."),
      ),
    [handBackToProvider],
  );

  /* No error event but no picture either — hls.js quietly retries a playlist
     the CDN is ignoring. A resolved stream that has neither advanced nor
     buffered a single second in 15s gives the provider its stage back. Nothing
     buffered is the tell: a stream that downloaded but sits at 0:00 is only
     waiting for the viewer's play tap (blocked autoplay), which is not a fault. */
  useEffect(() => {
    if (!embedStream || playing || currentTime > 0 || bufferedEnd > 0) return;
    const url = embedStream;
    const t = setTimeout(
      () => handBackToProvider(url, "That ad-free stream never started."),
      15_000,
    );
    return () => clearTimeout(t);
  }, [embedStream, playing, currentTime, bufferedEnd, handBackToProvider]);

  const selectServer = (key: string) => {
    const next:
      | "original"
      | "vidsrc"
      | "vidbox"
      | "vidapi"
      | "nxsha"
      | "anime"
      | "drama" =
      key === "vidbox"
        ? "vidbox"
        : key === "vidapi"
          ? "vidapi"
          : key === "nxsha"
            ? "nxsha"
            : key === "vidsrc"
              ? "vidsrc"
              : key === "anime"
                ? "anime"
                : key === "drama"
                  ? "drama"
                  : "original";
    /* Remember the choice for this title: the resolvers answer that server
       alone instead of leaving the race's winner on screen under a new name. */
    tappedServer.current = next === server ? "" : `${raceKey}|${next}`;
    if (next === "original" && embedStream) {
      setEmbedStream(null);
      streamedFor.current = "";
      start(
        { movieId, title, videoUrl: embedSource ? "" : videoUrl, posterUrl, backdropUrl },
        true,
      );
    }
    if ((next === "vidsrc" || next === "anime" || next === "drama") && embedStream) {
      /* That provider's own player was asked for, so it takes the stage rather
         than keeping a stream pulled from somewhere else. */
      setEmbedStream(null);
      streamedFor.current = "";
      start(
        {
          movieId,
          title,
          videoUrl:
            next === "vidsrc"
              ? (vidsrcUrl ?? "")
              : next === "anime"
                ? animeEmbedUrl({ tmdbId, kind, season, episode: aeEpisode })
                : dramaEmbedUrl({ tmdbId, kind, season, episode: aeEpisode }),
          posterUrl,
          backdropUrl,
        },
        true,
      );
    }
    setServer(next);
    /* Embed servers now show the provider player straight away and resolve an
       ad-free stream in the background; the resolver panel stays behind the
       "Ad-free stream" button in its top strip. */
    bumpControlsActivity();
  };

  /* When an iframe server (VidSrc / autoembed / embed fallback) takes over,
     pause the native file so the two never output audio at once. */
  useEffect(() => {
    if (
      (usingVidSrc || usingAutoembed || embedIframe) &&
      playing
    )
      controls.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usingVidSrc, usingAutoembed, embedIframe, playing]);

  const isHost = isActive && mode === "inline";

  /* Register this stage as the portal slot whenever the host container
     mounts/unmounts (callback ref — fires on every branch switch). */
  const containerCallback = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
      registerStage(el);
    },
    [registerStage],
  );

  useEffect(() => {
    const onFsChange = () => {
      const fsDoc = document as Document & { webkitFullscreenElement?: Element | null };
      setFullscreen(Boolean(document.fullscreenElement || fsDoc.webkitFullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, []);

  /* Auto-hide lives in the provider (shared with the mini card). Here we
     only hold it open while a menu is open. */
  useEffect(() => {
    setControlsHold(langOpen || settingsOpen || serverOpen);
  }, [langOpen, settingsOpen, serverOpen, setControlsHold]);

  /* Native pointerleave on the whole player box (video + control bar):
     when the mouse leaves the player, hide the controls immediately.
     (React synthetic pointer events proved unreliable here.) */
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof PointerEvent === "undefined") return;
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      setHoveringControls(false);
      if (!playing) return; /* paused/never started: always show */
      setControlsOverlayVisible(false);
    };
    el.addEventListener("pointerleave", onLeave);
    return () => el.removeEventListener("pointerleave", onLeave);
  }, [isHost, playing, setControlsOverlayVisible]);

  /* Keyboard shortcuts: space = play/pause, ←/→ = ±10s, ↑/↓ = volume,
     M = mute, F = fullscreen. */
  useEffect(() => {
    if (!isHost) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          controls.togglePlay();
          bumpControlsActivity();
          break;
        case "ArrowLeft":
          e.preventDefault();
          controls.seekBy(-10);
          bumpControlsActivity();
          break;
        case "ArrowRight":
          e.preventDefault();
          controls.seekBy(10);
          bumpControlsActivity();
          break;
        case "ArrowUp":
          e.preventDefault();
          controls.setVolume(Math.min(1, volume + 0.1));
          bumpControlsActivity();
          break;
        case "ArrowDown":
          e.preventDefault();
          controls.setVolume(Math.max(0, volume - 0.1));
          bumpControlsActivity();
          break;
        case "m":
        case "M":
          controls.toggleMute();
          bumpControlsActivity();
          break;
        case "f":
        case "F":
          toggleFullscreen();
          bumpControlsActivity();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, controls, volume, bumpControlsActivity]);

  /* While a movie is actually playing, leaving the page (closing the tab,
     reloading, an ad-script redirect) kills the show. Ask first — the
     browser shows its native "Leave site?" confirm. SPA navigation to the
     mini player is unaffected; this only guards full page unloads. */
  useEffect(() => {
    if (!playing || !isHost) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [playing, isHost]);

  const seekBy = useCallback(
    (delta: number) => {
      controls.seekBy(delta);
      bumpControlsActivity();
    },
    [controls, bumpControlsActivity],
  );

  /* Share from the player: native sheet on phones, clipboard elsewhere. */
  const shareMovie = useCallback(async () => {
    const url = window.location.href;
    const text = `Watch “${title}” on FilmFlix`;
    try {
      if (navigator.share) {
        await navigator.share({ title, text, url });
        return;
      }
    } catch {
      return; // user closed the share sheet
    }
    try {
      await navigator.clipboard.writeText(`${text} — ${url}`);
      toast.success("Link copied — paste it anywhere to share");
    } catch {
      toast.error("Could not copy the link");
    }
  }, [title]);

  /* Picture-in-picture: pop the video into a floating OS window. */
  const togglePip = useCallback(async () => {
    const v = document.querySelector("video");
    const video = v as (HTMLVideoElement & {
      requestPictureInPicture?: () => Promise<unknown>;
      webkitSetPresentationMode?: (m: string) => void;
    }) | null;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (video.requestPictureInPicture) {
        await video.requestPictureInPicture();
      } else if (video.webkitSetPresentationMode) {
        // Safari: webkit presentation mode is the PiP equivalent.
        const target =
          (video as HTMLVideoElement & { webkitPresentationMode?: string })
            .webkitPresentationMode === "picture-in-picture"
            ? "inline"
            : "picture-in-picture";
        video.webkitSetPresentationMode(target);
      } else {
        toast.error("Picture-in-picture is not supported in this browser");
      }
    } catch {
      toast.error("Picture-in-picture is not available right now");
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current as (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }) | null;
    const fsDoc = document as Document & { webkitFullscreenElement?: Element | null };
    const isFs = Boolean(document.fullscreenElement || fsDoc.webkitFullscreenElement);
    if (!isFs) {
      // Standard API first; iOS Safari < 16.4 only supports the webkit
      // variant on video elements, so fall back through the chain.
      if (el?.requestFullscreen) {
        el.requestFullscreen().catch(() => undefined);
      } else if (el?.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      } else {
        // Last resort (iPhone Safari): fullscreen the underlying video via
        // the native controls when the container API is unavailable.
        const v = document.querySelector("video");
        const video = v as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
        video?.webkitEnterFullscreen?.();
      }
      // Hint phones to rotate: landscape for wide screens is nicer, but the
      // video itself letterboxes to whatever orientation the user holds.
      (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })
        ?.lock?.("landscape")
        .catch(() => undefined); // not supported everywhere — fine
    } else {
      (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })
        ?.unlock?.();
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => undefined);
      } else if (fsDoc.webkitFullscreenElement) {
        (document as Document & { webkitExitFullscreen?: () => void }).webkitExitFullscreen?.();
      }
    }
  }, []);

  /* -------- Inactive: static placeholder (nothing playing at all) ------- */
  if (!isActive || !movie) {
    return (
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border/60 bg-black">
        {backdropUrl || posterUrl ? (
          <img
            src={(backdropUrl ?? posterUrl) as string}
            alt=""
            className="absolute inset-0 size-full object-cover opacity-60"
          />
        ) : null}
        <button
          type="button"
          onClick={() =>
            start(
              {
                movieId,
                title,
                videoUrl: embedSource ? "" : videoUrl,
                posterUrl,
                backdropUrl,
              },
              true,
            )
          }
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4"
        >
          <span className="relative z-10 flex size-16 items-center justify-center rounded-full bg-primary/95 text-primary-foreground shadow-[0_8px_40px_-8px_var(--primary)] transition-transform hover:scale-105 sm:size-20">
            <Play className="ml-1 size-8 fill-current" />
          </span>
          <span className="relative z-10 rounded-full bg-black/60 px-4 py-1.5 font-display text-sm font-semibold text-white backdrop-blur-sm">
            {title}
          </span>
        </button>
      </div>
    );
  }

  /* -------- Active but minimized: bring-back panel ---------------------- */
  if (!isHost) {
    return (
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border/60 bg-black">
        {backdropUrl || posterUrl ? (
          <img
            src={(backdropUrl ?? posterUrl) as string}
            alt=""
            className="absolute inset-0 size-full object-cover opacity-40"
          />
        ) : null}
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3">
          <span className="rounded-full bg-black/70 px-4 py-1.5 text-xs font-medium text-white/90 backdrop-blur-sm">
            Playing in miniplayer — keep browsing anywhere on the site
          </span>
          <button
            type="button"
            onClick={() => setMode("inline")}
            className="glow-accent flex items-center gap-2 rounded-full bg-primary/95 px-5 py-2.5 font-display text-sm font-semibold text-primary-foreground"
          >
            <Maximize className="size-4" />
            Bring video back here
          </button>
          <button
            type="button"
            onClick={close}
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Stop playback
          </button>
        </div>
      </div>
    );
  }

  /* -------- Inline host of the persistent video -------------------------- */
  return (
    <div
      ref={containerCallback}
      className={`group/player relative w-full overflow-hidden bg-black shadow-[0_24px_80px_-24px_rgba(0,0,0,0.9)] ${
        fullscreen
          ? "fixed inset-0 z-[80] rounded-none border-0"
          : "aspect-video w-full rounded-xl border border-border/60"
      }`}
      onPointerMove={(e) => {
        if (e.pointerType !== "mouse") return;
        bumpControlsActivity();
      }}
      onClickCapture={(e) => {
        bumpControlsActivity();
        // Clicking anywhere outside an open player menu closes it.
        if (!(e.target as HTMLElement).closest("[data-player-menu]")) {
          setLangOpen(false);
          setSettingsOpen(false);
          setServerOpen(false);
          setSettingsView("main");
        }
      }}
      onDoubleClick={toggleFullscreen}
    >
      {/* Portal target — the persistent video mounts here. */}
      <div data-slot="stage-slot" className="absolute inset-0" />

      {/* Poster overlay until playback begins. `playing` is also checked:
          if the video is already running (any start path), the banner must
          never keep covering it. */}
      {!hasStarted && !playing && (
        <button
          type="button"
          aria-label={`Play ${movie.title}`}
          onClick={() => controls.play()}
          /* z-[15]: above the video's tap-zone layer (z-10, later in DOM so
             it wins ties — real clicks on this button were landing on the
             tap zones and doing nothing) but below the control bar (z-20). */
          className="absolute inset-0 z-[15] flex flex-col items-center justify-center gap-4 bg-black"
        >
          {movie.backdropUrl || movie.posterUrl ? (
            <img
              src={(movie.backdropUrl ?? movie.posterUrl) as string}
              alt=""
              className="absolute inset-0 size-full object-cover opacity-60"
            />
          ) : null}
          <span className="relative z-10 flex size-16 items-center justify-center rounded-full bg-primary/95 text-primary-foreground shadow-[0_8px_40px_-8px_var(--primary)] transition-transform hover:scale-105 sm:size-20">
            <Play className="ml-1 size-8 fill-current" />
          </span>
          <span className="relative z-10 rounded-full bg-black/60 px-4 py-1.5 font-display text-sm font-semibold text-white backdrop-blur-sm">
            {movie.title}
          </span>
        </button>
      )}

      {/* Full-cover iframe servers — VidSrc "Server 1" and the AutoEmbed
          episode players "Server 3" (anime) / "Server 4" (drama). */}
      {(usingVidSrc || usingAutoembed) && iframeServerUrl && (
        <div className="absolute inset-0 z-[60] bg-black">
          <iframe
            key={iframeServerUrl}
            src={iframeServerUrl}
            title={`${title} — ${usingVidSrc ? "Server 1" : server === "anime" ? "Server 3 · Anime" : "Server 4 · Drama"}`}
            className="absolute inset-0 size-full border-0"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write"
            allowFullScreen
            referrerPolicy="origin"
          />
          {/* Floating top strip — the iframe covers the native control bar,
              so Server switch + fullscreen live here. */}
          <div className="absolute inset-x-0 top-0 z-10 flex flex-wrap items-center gap-1.5 bg-gradient-to-b from-black/85 via-black/45 to-transparent px-2 pb-8 pt-2 sm:px-3">
            {usingAutoembed && (
              <>
                {/* Episode stepper — the anime/drama providers are per-episode
                    for series (VidNest / Videasy `tv/{id}/{season}/{ep}`). */}
                <div className="flex items-center gap-0.5 rounded-lg bg-black/55 text-white backdrop-blur-sm">
                  <button
                    type="button"
                    onClick={() => setAeEpisode((e) => Math.max(1, e - 1))}
                    className="rounded-lg p-1.5 transition-colors hover:bg-white/15"
                    aria-label="Previous episode"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <span className="min-w-[64px] text-center text-xs font-semibold tabular-nums">
                    Ep {aeEpisode}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAeEpisode((e) => e + 1)}
                    className="rounded-lg p-1.5 transition-colors hover:bg-white/15"
                    aria-label="Next episode"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </div>
                <a
                  href={iframeServerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg bg-black/55 px-2.5 py-1.5 text-xs text-white backdrop-blur-sm transition-colors hover:bg-black/75"
                  title="If the player stays blank, open the provider directly"
                >
                  Open ↗
                </a>
              </>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <ServerSwitcher
                servers={servers}
                activeKey={server}
                onSelect={selectServer}
                open={serverOpen}
                setOpen={setServerOpen}
                align="right"
                drop="down"
              />
              <DownloadMenu
                files={downloadFiles}
                streamUrl={streamProbeUrl} referer={embedUrl || embedSource || iframeServerUrl}
                iframeUrl={iframeServerUrl}
                ids={{ tmdbId, imdbId, kind, season, episode: usingAutoembed ? aeEpisode : (episode ?? aeEpisode) }}
                title={title}
                open={downloadOpen}
                setOpen={setDownloadOpen}
                align="right"
                drop="down"
              />
              <button
                type="button"
                onClick={toggleFullscreen}
                className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
                aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
              >
                {fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Embed servers: the provider player, shown from the first frame and
          hidden again only if an ad-free raw stream was extracted. */}
      {embedIframe && (embedUrl || embedSource) && (
        <div className="absolute inset-0 z-[60] bg-black">
          <iframe
            src={(embedUrl || embedSource) as string}
            title={`${title} — Embed`}
            className="absolute inset-0 size-full border-0"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write"
            allowFullScreen
            referrerPolicy="origin"
          />
          {/* The provider's own wall ("we don't have this episode") is served at
              HTTP 200, so no probe can tell it from a working player. Say out
              loud which host is showing and where to go instead — that is the
              one case where a framed provider page reads as a broken site. */}
          <div className="absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/85 via-black/45 to-transparent px-2 pb-2 pt-2 sm:px-3">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setEmbedPanelOpen(true)}
                className={`rounded-lg bg-black/55 px-2.5 py-1.5 text-xs backdrop-blur-sm transition-colors hover:bg-black/75 ${
                  embedStatus === "failed" && !embedCarried
                    ? "text-amber-200"
                    : "text-white"
                }`}
                title={
                  embedStatus === "failed"
                    ? "No provider gave a stream this page could play, so the provider's own player is shown"
                    : "Every provider is being tried at once — the first stream that answers plays here"
                }
              >
                {embedStatus === "resolving" ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="size-3.5 animate-spin" />
                    <span className="hidden sm:inline">Checking all servers…</span>
                    <span className="sm:hidden">Checking…</span>
                  </span>
                ) : embedStatus === "failed" ? (
                  "Provider player"
                ) : (
                  "Ad-free stream"
                )}
              </button>
              <div className="ml-auto flex items-center gap-1.5">
              <ServerSwitcher
                servers={servers}
                activeKey={server}
                onSelect={selectServer}
                open={serverOpen}
                setOpen={setServerOpen}
                align="right"
                drop="down"
              />
              <DownloadMenu
                files={downloadFiles}
                streamUrl={streamProbeUrl} referer={embedUrl || embedSource || iframeServerUrl}
                iframeUrl={(embedUrl || embedSource) as string}
                ids={{ tmdbId, imdbId, kind, season, episode: usingAutoembed ? aeEpisode : (episode ?? aeEpisode) }}
                title={title}
                open={downloadOpen}
                setOpen={setDownloadOpen}
                align="right"
                drop="down"
              />
              <button
                type="button"
                onClick={toggleFullscreen}
                className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
                aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
              >
                {fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
              </button>
              </div>
            </div>
            {/* Naming the host and the way out: on a failed race the framed page
                is the provider's, and unless it confirmed the title it can just
                as well be showing its own "we don't have this" wall. */}
            {embedStatus === "failed" && !embedCarried && (
              <div className="mt-1.5 flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate rounded-lg bg-black/55 px-2.5 py-1 text-[11px] text-amber-200/90 backdrop-blur-sm">
                  <span className="hidden sm:inline">
                    {embedHost} answered with no stream we can play, so its own
                    player is showing — it may not carry this title.
                  </span>
                  <span className="sm:hidden">{embedHost} may not have this title.</span>
                </p>
                <button
                  type="button"
                  onClick={() => setServerOpen(true)}
                  className="shrink-0 rounded-lg bg-white/15 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm transition-colors hover:bg-white/25"
                >
                  Try another server
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Every embed server on this title answered with an error page: say so
          plainly rather than framing the provider's stack trace as a player. */}
      {embedDead && (
        <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black px-4">
          <div className="w-full max-w-sm rounded-2xl border border-border/60 bg-card/95 p-5 text-center">
            <p className="font-display text-base font-semibold">
              No working server for this title
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Every provider we tried has no player for this id right now. Pick
              another server, or open the provider directly.
            </p>
            <div className="mt-4 flex items-center justify-center gap-2">
              <ServerSwitcher
                servers={servers}
                activeKey={server}
                onSelect={selectServer}
                open={serverOpen}
                setOpen={setServerOpen}
                align="left"
                drop="up"
              />
              {(embedUrl || embedSource) && (
                <a
                  href={(embedUrl || embedSource) as string}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg border border-border/60 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
                >
                  Open provider ↗
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Embed resolver panel — paste/resolve an embed URL and pick a stream. */}
      {usingEmbed && embedPanelOpen && (
        <div className="absolute inset-0 z-[65] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-border/60 bg-card/95 p-4 text-sm text-card-foreground shadow-2xl">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-display font-semibold">
                Embed stream — ad-free
              </span>
              <button
                type="button"
                onClick={() => setEmbedPanelOpen(false)}
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              Paste a vidlink.pro / vixsrc.to (or similar) embed link — the
              Worker follows its iframe chain and plays the raw HLS stream
              here, without the provider&apos;s player or ads.
            </p>
            <div className="flex gap-2">
              <input
                value={embedUrl}
                onChange={(e) => setEmbedUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runEmbedResolve(embedUrl);
                }}
                placeholder="https://vidlink.pro/movie/… or vixsrc.to/movie/…"
                className="min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none focus-visible:border-ring"
              />
              <button
                type="button"
                disabled={embedStatus === "resolving"}
                onClick={() => void runEmbedResolve(embedUrl)}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity disabled:opacity-60"
              >
                {embedStatus === "resolving" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Link2 className="size-3.5" />
                )}
                Resolve
              </button>
            </div>
            {embedError && (
              <p className="mt-2 text-xs text-destructive">{embedError}</p>
            )}
            {embedCandidates.length > 0 && (
              <div className="mt-3 space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Found {embedCandidates.length} stream(s) — pick one:
                </p>
                {embedCandidates.map((c) => {
                  let host = c.url;
                  try {
                    host = new URL(c.url).hostname;
                  } catch {
                    /* keep full url */
                  }
                  return (
                    <button
                      key={c.url}
                      type="button"
                      onClick={() => playEmbedCandidate(c)}
                      title={c.url}
                      className={`block w-full truncate rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent ${
                        embedStream === c.url
                          ? "border-primary/60 text-primary"
                          : "border-border/60"
                      }`}
                    >
                      {host}{" "}
                      <span className="text-muted-foreground">({c.via})</span>
                    </button>
                  );
                })}
              </div>
            )}
            {(embedUrl || embedSource) && (
              <button
                type="button"
                onClick={() => setEmbedPanelOpen(false)}
                className="mt-3 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                Back to the provider player
              </button>
            )}
          </div>
        </div>
      )}

      {/* Controls — float up from the bottom edge on hover/tap. */}
      <div
        onMouseEnter={() => setHoveringControls(true)}
        onMouseLeave={() => setHoveringControls(false)}
        className={`absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-2 pb-2.5 pt-10 transition-all duration-300 ease-out sm:px-4 ${
          controlsVisible || !playing
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-3 opacity-0"
        }`}
      >
        {/* Progress / seek bar — click to jump, drag to scrub. */}
        <div
          ref={scrubRef}
          data-player-scrubber
          className="group/scrub mb-2 flex h-6 cursor-pointer touch-none items-center"
          onPointerDown={(e) => {
            if (duration <= 0) return;
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* capture is best-effort */
            }
            scrubbingRef.current = true;
            setControlsHold(true);
            const rect = e.currentTarget.getBoundingClientRect();
            controls.seekToRatio((e.clientX - rect.left) / rect.width);
          }}
          onPointerMove={(e) => {
            if (!scrubbingRef.current) return;
            const rect = e.currentTarget.getBoundingClientRect();
            controls.seekToRatio((e.clientX - rect.left) / rect.width);
          }}
          onPointerUp={(e) => {
            if (!scrubbingRef.current) return;
            scrubbingRef.current = false;
            setControlsHold(false);
            try {
              e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
              /* best-effort */
            }
          }}
          onPointerCancel={() => {
            scrubbingRef.current = false;
            setControlsHold(false);
          }}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
        >
          <div className="relative h-1.5 w-full rounded-full bg-white/25 transition-[height] group-hover/scrub:h-2.5">
            {/* Downloaded (buffered) portion. */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-white/30"
              style={{ width: `${duration ? Math.min(100, (bufferedEnd / duration) * 100) : 0}%` }}
            />
            {/* Played portion + thumb. */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
            />
            <div
              className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-transform group-hover/scrub:scale-110"
              style={{ left: `${duration ? Math.min(100, (currentTime / duration) * 100) : 0}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2.5">
          <span className="w-10 text-[11px] font-medium tabular-nums text-white/80">
            {formatTime(currentTime)}
          </span>
          <button
            type="button"
            onClick={() => controls.togglePlay()}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <Pause className="size-5 fill-current" />
            ) : (
              <Play className="size-5 fill-current" />
            )}
          </button>
          <button
            type="button"
            onClick={() => seekBy(-10)}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
            aria-label="Back 10 seconds"
          >
            <RotateCcw className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => seekBy(10)}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
            aria-label="Forward 10 seconds"
          >
            <RotateCw className="size-4" />
          </button>

          {/* Volume: hover-expand on desktop, plain mute toggle on touch. */}
          <div className="group/vol flex items-center max-sm:hidden">
            <button
              type="button"
              onClick={() => controls.toggleMute()}
              className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
              aria-label={muted ? "Unmute" : "Mute"}
            >
              {muted || volume === 0 ? (
                <VolumeX className="size-5" />
              ) : volume < 0.5 ? (
                <Volume1 className="size-5" />
              ) : (
                <Volume2 className="size-5" />
              )}
            </button>
            <div className="w-0 overflow-hidden opacity-0 transition-all duration-300 group-hover/vol:w-24 group-hover/vol:opacity-100 group-focus-within/vol:w-24 group-focus-within/vol:opacity-100">
              <Slider
                value={[muted ? 0 : Math.round(volume * 100)]}
                max={100}
                step={1}
                onValueChange={(val) => controls.setVolume((val[0] ?? 0) / 100)}
                className="w-24 [&_[data-slot=slider-track]]:bg-white/25 [&_[data-slot=slider-range]]:bg-primary [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-thumb]]:border-primary [&_[data-slot=slider-thumb]]:bg-white"
                aria-label="Volume"
              />
            </div>
          </div>
          {/* Touch devices have no hover — show the mute toggle here instead. */}
          <button
            type="button"
            onClick={() => controls.toggleMute()}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15 sm:hidden"
            aria-label={muted ? "Unmute" : "Mute"}
          >
            {muted || volume === 0 ? (
              <VolumeX className="size-5" />
            ) : volume < 0.5 ? (
              <Volume1 className="size-5" />
            ) : (
              <Volume2 className="size-5" />
            )}
          </button>

          {/* Share, right beside the volume controls. */}
          <button
            type="button"
            onClick={shareMovie}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
            aria-label="Share this movie"
            title="Share"
          >
            <Share2 className="size-5" />
          </button>

          <span className="w-10 text-[11px] font-medium tabular-nums text-white/80">
            {formatTime(duration)}
          </span>

          {/* Language switch — original + admin-added dubs. */}
          {dubs.length > 0 && (
            <div className="relative" data-player-menu>
              <button
                type="button"
                onClick={() => setLangOpen((v) => !v)}
                className="flex items-center gap-1.5 rounded-lg px-2 py-2 text-white transition-colors hover:bg-white/15"
                aria-label="Audio language"
                title="Audio language"
              >
                <Languages className="size-5" />
                <span className="hidden text-xs font-semibold min-[420px]:inline">
                  {activeDub ?? "Original"}
                </span>
              </button>
              {langOpen && (
                <div className="absolute bottom-full right-0 z-30 mb-2 min-w-[160px] overflow-hidden rounded-xl border border-white/15 bg-black/95 py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.9)] backdrop-blur">
                  <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/50">
                    Audio language
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setDub(null);
                      setLangOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 ${
                      activeDub === null ? "bg-primary/25 font-semibold text-primary" : ""
                    }`}
                  >
                    Original
                    {activeDub === null && <span className="text-xs">✓</span>}
                  </button>
                  {dubs.map((d) => (
                    <button
                      key={d.label}
                      type="button"
                      onClick={() => {
                        setDub(d.label);
                        setLangOpen(false);
                      }}
                      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 ${
                        activeDub === d.label ? "bg-primary/25 font-semibold text-primary" : ""
                      }`}
                    >
                      {d.label}
                      {activeDub === d.label && <span className="text-xs">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Playback server — switch between this site's file, VidSrc, and the
              embed resolver. Shown whenever more than one server is available. */}
          {servers.length > 1 && (
            <ServerSwitcher
              servers={servers}
              activeKey={server}
              onSelect={selectServer}
              open={serverOpen}
              setOpen={setServerOpen}
              align="right"
            />
          )}

          <DownloadMenu
            files={downloadFiles}
            streamUrl={streamProbeUrl} referer={embedUrl || embedSource || iframeServerUrl}
            ids={{ tmdbId, imdbId, kind, season, episode: usingAutoembed ? aeEpisode : (episode ?? aeEpisode) }}
            title={title}
            open={downloadOpen}
            setOpen={setDownloadOpen}
            align="right"
          />

          {/* Settings gear: night mode, loop, rotate, captions, speed, quality. */}
          <div className="relative ml-auto" data-player-menu>
            <button
              type="button"
              onClick={() => {
                setSettingsOpen((v) => !v);
                setSettingsView("main");
                setLangOpen(false);
              }}
              className={`rounded-lg p-2 text-white transition-colors hover:bg-white/15 ${
                settingsOpen || nightMode || loop || rotation !== 0 || playbackRate !== 1 || activeQuality || activeSubtitle
                  ? "text-primary"
                  : ""
              }`}
              aria-label="Player settings"
              title="Settings"
            >
              <Settings className="size-5" />
            </button>

            {settingsOpen && (
              <div className="absolute bottom-full right-0 z-30 mb-2 w-[264px] max-w-[86vw] overflow-hidden rounded-2xl border border-white/15 bg-black/95 py-1.5 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.95)] backdrop-blur">
                {settingsView === "main" && (
                  <>
                    <SettingsToggle
                      icon={<Moon className="size-4" />}
                      label="Night Mode"
                      on={nightMode}
                      onToggle={() => setNightMode(!nightMode)}
                    />
                    <SettingsToggle
                      icon={<Repeat className="size-4" />}
                      label="Loop"
                      on={loop}
                      onToggle={() => setLoop(!loop)}
                    />
                    <SettingsToggle
                      icon={<RotateCw className="size-4" />}
                      label="Auto Rotate"
                      on={rotation !== 0}
                      onToggle={() => setRotation(rotation === 0 ? 90 : 0)}
                    />
                    {(subtitles.length > 0 || streamSubtitleLabels.length > 0) && (
                      <SettingsLink
                        icon={<Captions className="size-4" />}
                        label="Subtitles"
                        value={activeSubtitle ?? "Off"}
                        onClick={() => setSettingsView("subtitles")}
                      />
                    )}
                    <SettingsLink
                      icon={<Gauge className="size-4" />}
                      label="Playback Speed"
                      value={playbackRate === 1 ? "Normal" : `${playbackRate}x`}
                      onClick={() => setSettingsView("speed")}
                    />
                    {qualities.length > 0 && (
                      <SettingsLink
                        icon={<Settings className="size-4" />}
                        label="Quality"
                        value={activeQuality ?? "Auto"}
                        onClick={() => setSettingsView("quality")}
                      />
                    )}
                  </>
                )}

                {settingsView !== "main" && (
                  <>
                    <button
                      type="button"
                      onClick={() => setSettingsView("main")}
                      className="flex w-full items-center gap-2.5 border-b border-white/10 px-3 pb-2 pt-1.5 text-left text-sm font-semibold text-white hover:bg-white/5"
                    >
                      <ChevronLeft className="size-4" />
                      {settingsView === "subtitles"
                        ? "Subtitles"
                        : settingsView === "speed"
                          ? "Playback Speed"
                          : "Quality"}
                    </button>
                    <div className="max-h-[220px] overflow-y-auto">
                      {settingsView === "subtitles" && (
                        <>
                          <MenuOption
                            label="Off"
                            selected={activeSubtitle === null}
                            onSelect={() => {
                              setSubtitle(null);
                              setSettingsOpen(false);
                            }}
                          />
                          {subtitles.map((s) => (
                            <MenuOption
                              key={s.label}
                              label={s.label}
                              selected={activeSubtitle === s.label}
                              onSelect={() => {
                                setSubtitle(s.label);
                                setSettingsOpen(false);
                              }}
                            />
                          ))}
                          {/* Caption tracks the provider's own stream carries —
                              for the ad-free embed servers this is the only
                              subtitle list there is. */}
                          {streamSubtitleLabels
                            .filter((l) => !subtitles.some((s) => s.label === l))
                            .map((label) => (
                              <MenuOption
                                key={label}
                                label={label}
                                selected={activeSubtitle === label}
                                onSelect={() => {
                                  setSubtitle(label);
                                  setSettingsOpen(false);
                                }}
                              />
                            ))}
                        </>
                      )}
                      {settingsView === "speed" &&
                        [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                          <MenuOption
                            key={r}
                            label={r === 1 ? "Normal" : `${r}x`}
                            selected={playbackRate === r}
                            onSelect={() => {
                              setPlaybackRate(r);
                              setSettingsOpen(false);
                            }}
                          />
                        ))}
                      {settingsView === "quality" && (
                        <>
                          <MenuOption
                            label="Auto"
                            selected={activeQuality === null}
                            onSelect={() => {
                              setQuality(null);
                              setSettingsOpen(false);
                            }}
                          />
                          {qualities.map((q) => (
                            <MenuOption
                              key={q.label}
                              label={q.label}
                              selected={activeQuality === q.label}
                              onSelect={() => {
                                setQuality(q.label);
                                setSettingsOpen(false);
                              }}
                            />
                          ))}
                          <p className="border-t border-white/10 px-3 py-2 text-[11px] leading-snug text-white/50">
                            {qualities.map((q) => q.label).join(" / ")}
                            {" "}files play when added by the server. If a quality
                            file is not available, the player safely uses the
                            original stream.
                          </p>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Picture-in-picture — floating OS window. */}
          <button
            type="button"
            onClick={togglePip}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
            aria-label="Picture-in-picture"
            title="Picture-in-picture"
          >
            <PictureInPicture2 className="size-5" />
          </button>

          <button
            type="button"
            onClick={toggleFullscreen}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
          >
            {fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------- Server switcher ------------------------- */

/** Dropdown that picks the playback server (VidSrc "Server 1" vs the site's
 *  own file). Shared by the native control bar and the VidSrc overlay strip. */
function ServerSwitcher({
  servers,
  activeKey,
  onSelect,
  open,
  setOpen,
  align = "right",
  drop = "up",
}: {
  servers: { key: string; label: string; sub?: string }[];
  activeKey: string;
  onSelect: (key: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  align?: "left" | "right";
  /** Which way the menu opens. The player box clips overflow, so the button
   *  in the TOP overlay strip must drop downward; the bottom control bar
   *  opens upward. */
  drop?: "up" | "down";
}) {
  const active = servers.find((s) => s.key === activeKey);
  return (
    <div
      className="relative"
      data-player-menu
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-2 text-white transition-colors hover:bg-white/15"
        aria-label="Playback server"
        title="Server"
      >
        <Server className="size-5" />
        <span className="hidden text-xs font-semibold min-[420px]:inline">
          {active?.label ?? "Server"}
        </span>
      </button>
      {open && (
        <div
          className={`absolute z-30 min-w-[220px] overflow-hidden rounded-xl border border-white/15 bg-black/95 py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.95)] backdrop-blur ${
            drop === "down" ? "top-full mt-2" : "bottom-full mb-2"
          } ${align === "right" ? "right-0" : "left-0"}`}
        >
          <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/50">
            Playback server
          </p>
          {servers.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => {
                onSelect(s.key);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 ${
                s.key === activeKey ? "bg-primary/25 font-semibold text-primary" : ""
              }`}
            >
              <span className="flex flex-col">
                <span>{s.label}</span>
                {s.sub && (
                  <span className="text-[10px] font-normal text-white/50">{s.sub}</span>
                )}
              </span>
              {s.key === activeKey && <span className="text-xs">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------- Download menu ------------------------- */

/** File name hint for the `download` attribute (browsers may ignore it
 *  cross-origin — the link still opens the file for saving). */
function downloadName(title: string, label: string, url: string): string {
  const ext =
    /\.(m3u8|mp4|mkv|webm|mov|m4v)(\?|#|$)/i.exec(url)?.[1]?.toLowerCase() ?? "mp4";
  const clean = (s: string) =>
    s
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
  return `${clean(title).slice(0, 60) || "video"}-${clean(label) || "file"}.${ext}`;
}

function DownloadMenu({
  files,
  streamUrl,
  referer,
  iframeUrl = "",
  ids,
  title,
  open,
  setOpen,
  align = "right",
  drop = "up",
}: {
  files: { label: string; url: string }[];
  streamUrl: string;
  /** Embed page the stream came from — CDNs hotlink-check this on download. */
  referer?: string;
  /** Active server is a third-party player frame — its traffic is invisible here. */
  iframeUrl?: string;
  ids: {
    tmdbId?: string | number | null;
    imdbId?: string | null;
    kind?: "movie" | "series" | null;
    season?: number;
    episode?: number;
  };
  title: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  align?: "left" | "right";
  /** See ServerSwitcher — top-strip menus must open downward to escape overflow-hidden. */
  drop?: "up" | "down";
}) {
  const [qualities, setQualities] = useState<{ label: string; url: string }[]>([]);
  const [providers, setProviders] = useState<TitleDownloadProvider[]>([]);
  const [probeStatus, setProbeStatus] = useState<"idle" | "loading" | "done">("idle");
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [savedNote, setSavedNote] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState("");
  const loadedFor = useRef("");

  /* What the player actually fetched this session — the IDM-style list. It is
     the only source that works for token-rotating CDNs, because the URL it
     reports is the one that is live right now. */
  const sniffed = useSniffedStreams();
  useEffect(() => {
    setSnifferReferer(referer ?? "");
  }, [referer]);

  const probeKey = `${streamUrl}|${ids.tmdbId ?? ""}|${ids.imdbId ?? ""}|${ids.kind ?? ""}|${ids.season ?? 0}|${ids.episode ?? 0}`;
  /* Providers answer in ~12s and often come back empty — a failed sweep must
     stay re-runnable from the menu instead of being cached for the title. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const key = `${probeKey}#${attempt}`;
    if (!open || loadedFor.current === key) return;
    loadedFor.current = key;
    setProbeStatus("loading");
    // Provider sweep works on every embed server (iframe-only ones included);
    // the master-playlist probe only applies once a raw stream is resolved.
    Promise.all([
      (ids.tmdbId || ids.imdbId ? fetchTitleDownloads(ids) : Promise.resolve([])).catch(
        () => [] as TitleDownloadProvider[],
      ),
      streamUrl
        ? fetchEmbedQualities(streamUrl)
            .then((r) => r.entries ?? [])
            .catch(() => [])
        : Promise.resolve([]),
    ]).then(([prov, quals]) => {
      setProviders(prov);
      setQualities(quals);
      setProbeStatus("done");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, probeKey, attempt]);

  /* Sniffed URLs the probing above did not already list. */
  const listed = new Set([
    ...files.map((f) => f.url),
    ...qualities.map((q) => q.url),
    ...providers.flatMap((p) => p.entries.map((e) => e.url)),
  ]);
  const detected: SniffedStream[] = sniffed.filter((s) => !listed.has(s.url));

  /* The copy button hands out the Worker byte-pipe link: plain, public, no
     browser headers needed, Range-correct — so IDM (or any manager) pulls the
     file at full speed with resume. That is the escape hatch when the
     in-app remux is not enough. */
  const copyBtn = (label: string, url: string) => (
    <button
      type="button"
      title="Copy direct link — paste into IDM or any download manager"
      onClick={() => {
        navigator.clipboard
          ?.writeText(proxyUrl(url, referer || undefined, downloadName(title, label, url)))
          .then(() => {
            setCopied(url);
            setTimeout(() => setCopied(""), 2500);
          })
          .catch(() => undefined);
      }}
      className="shrink-0 rounded p-1.5 text-white/45 transition-colors hover:bg-white/15 hover:text-white"
    >
      {copied === url ? (
        <span className="text-[10px] font-semibold text-primary">copied ✓</span>
      ) : (
        <Link2 className="size-4" />
      )}
    </button>
  );

  const line = (label: string, sub: string, url: string, main: ReactNode) => (
    <div
      key={url + label}
      className="flex items-center gap-1 pr-2 transition-colors hover:bg-white/10"
      title={url}
    >
      <div className="min-w-0 flex-1">{main}</div>
      {copyBtn(label, url)}
    </div>
  );

  /* Direct files go through the byte pipe with an attachment header: a plain
     cross-origin `download` link is silently ignored by browsers, which is why
     these rows used to just open the video in a new tab. */
  const row = (label: string, sub: string, url: string) =>
    line(
      label,
      sub,
      url,
      <a
        href={proxyUrl(url, referer || undefined, downloadName(title, label, url))}
        download={downloadName(title, label, url)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white"
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{label}</span>
          {sub && <span className="text-[10px] font-normal text-white/50">{sub}</span>}
        </span>
        <Download className="size-4 shrink-0 text-white/60" />
      </a>,
    );

  /* HLS rows download in-browser (segments → remuxed .mp4) with live progress. */
  const streamRow = (label: string, sub: string, url: string) => {
    if (!isHlsLink(url)) return row(label, sub, url);
    const pct = progress[url];
    const busy = pct !== undefined && pct >= 0 && pct < 1;
    const start = () => {
      setProgress((p) => ({ ...p, [url]: 0 }));
      downloadHls(url, (f) => setProgress((p) => ({ ...p, [url]: f })), { referer })
        .then(({ blob, skipped }) => {
          saveBlob(blob, downloadName(title, label, url).replace(/\.m3u8$/i, ".mp4"));
          if (skipped) setSavedNote((n) => ({ ...n, [url]: `${skipped} parts skipped` }));
          setProgress((p) => ({ ...p, [url]: 1 }));
          setTimeout(
            () =>
              setProgress((p) => {
                const n = { ...p };
                delete n[url];
                return n;
              }),
            4000,
          );
        })
        .catch(() => setProgress((p) => ({ ...p, [url]: -1 })));
    };
    return line(
      label,
      sub,
      url,
      <div className="flex w-full items-center justify-between gap-3 px-3 py-2 text-sm text-white">
        <button
          type="button"
          disabled={busy}
          onClick={start}
          className="flex min-w-0 flex-1 flex-col items-start text-left transition-colors hover:text-primary disabled:opacity-60"
        >
          <span className="truncate">{label}</span>
          {sub && <span className="text-[10px] font-normal text-white/50">{sub}</span>}
        </button>
        {busy ? (
          <span className="shrink-0 text-[10px] tabular-nums text-white/70">
            {Math.round((pct || 0) * 100)}%
          </span>
        ) : pct === 1 ? (
          <span className="shrink-0 text-[10px] font-semibold text-primary">
            {savedNote[url] ? `saved · ${savedNote[url]}` : "saved ✓"}
          </span>
        ) : pct === -1 ? (
          <button
            type="button"
            onClick={start}
            className="shrink-0 text-[10px] font-semibold text-red-400 hover:text-red-300"
          >
            failed — retry
          </button>
        ) : (
          <Download className="size-4 shrink-0 text-white/60" />
        )}
      </div>,
    );
  };

  const nothingYet =
    files.length === 0 &&
    qualities.length === 0 &&
    providers.length === 0 &&
    detected.length === 0;
  const iframeHost = (() => {
    try {
      return new URL(iframeUrl).hostname.replace(/^www\./, "");
    } catch {
      return "the provider";
    }
  })();

  return (
    <div
      className="relative"
      data-player-menu
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-2 text-white transition-colors hover:bg-white/15"
        aria-label="Download"
        title="Download"
      >
        <Download className="size-5" />
        <span className="hidden text-xs font-semibold min-[420px]:inline">Download</span>
      </button>
      {open && (
        <div
          className={`absolute z-30 min-w-[220px] max-h-[60vh] overflow-y-auto rounded-xl border border-white/15 bg-black/95 py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.95)] backdrop-blur ${
            drop === "down" ? "top-full mt-2" : "bottom-full mb-2"
          } ${align === "right" ? "right-0" : "left-0"}`}
        >
          <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/50">
            Download
          </p>
          {files.map((f) => streamRow(f.label, "This site's file", f.url))}
          {qualities.map((q) => streamRow(q.label, "Now-playing stream", q.url))}
          {providers.flatMap((p) => p.entries.map((e) => streamRow(e.label, p.name, e.url)))}
          {detected.length > 0 && (
            <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-white/50">
              Detected on this page
            </p>
          )}
          {detected.map((s) => streamRow(s.label, `Sniffed · ${s.host}`, s.url))}
          {probeStatus === "loading" && (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-white/60">
              <Loader2 className="size-3.5 animate-spin" /> Checking providers &amp;
              resolutions…
            </p>
          )}
          {nothingYet && probeStatus !== "loading" && iframeUrl && (
            <div className="px-3 py-2">
              <p className="text-xs leading-relaxed text-white/60">
                <span className="font-semibold text-white/80">{iframeHost}</span>{" "}
                plays this title inside its own player frame. A frame from another
                site is sealed — this page cannot see the file it pulls, so there
                is nothing for us to list.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-white/60">
                IDM can: it watches the whole browser, not just this tab. Open the
                player by itself and its grabber bar offers 1080p / 720p / 480p.
              </p>
              <a
                href={iframeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 flex w-full items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm text-white transition-colors hover:bg-white/20"
              >
                <ExternalLink className="size-4 shrink-0" />
                Open {iframeHost} in a new tab
              </a>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(iframeUrl)
                    .then(() => {
                      setCopied(iframeUrl);
                      setTimeout(() => setCopied(""), 2500);
                    })
                    .catch(() => undefined);
                }}
                className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/80 transition-colors hover:bg-white/15"
              >
                <Link2 className="size-4 shrink-0" />
                {copied === iframeUrl ? "copied ✓" : "Copy player address"}
              </button>
            </div>
          )}
          {nothingYet && probeStatus !== "loading" && !iframeUrl && (
            <p className="px-3 py-2 text-xs leading-relaxed text-white/60">
              Nothing has played yet, so there is no stream to grab. Start the
              video (or switch server) and open Download again — every URL the
              player pulls shows up here automatically.
            </p>
          )}
          {nothingYet && (
            <button
              type="button"
              disabled={probeStatus === "loading"}
              onClick={() => setAttempt((a) => a + 1)}
              className="mx-3 mb-1 mt-1 flex items-center gap-2 rounded-lg border border-white/15 px-2.5 py-1.5 text-[11px] font-semibold text-white/70 transition-colors hover:bg-white/15 disabled:opacity-50"
            >
              {probeStatus === "loading" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RotateCcw className="size-3" />
              )}
              {probeStatus === "loading" ? "Checking providers…" : "Check providers again"}
            </button>
          )}
          {(detected.length > 0 || files.length + qualities.length + providers.length > 0) && (
            <p className="px-3 py-2 text-[10px] leading-relaxed text-white/40">
              Stuck on a big file? Hit the link icon to copy a direct URL — paste
              it into IDM and it downloads with resume and multiple connections.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------- Settings menu pieces ------------------------- */

function SettingsToggle({
  icon,
  label,
  on,
  onToggle,
}: {
  icon: ReactNode;
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10"
    >
      <span className="text-white/70">{icon}</span>
      <span className="flex-1">{label}</span>
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          on ? "bg-primary" : "bg-white/20"
        }`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${
            on ? "left-[18px]" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

function SettingsLink({
  icon,
  label,
  value,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10"
    >
      <span className="text-white/70">{icon}</span>
      <span className="flex-1">{label}</span>
      <span className="flex items-center gap-1 text-xs font-medium text-white/70">
        {value}
        <ChevronRight className="size-3.5" />
      </span>
    </button>
  );
}

function MenuOption({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 ${
        selected ? "bg-primary/25 font-semibold text-primary" : ""
      }`}
    >
      {label}
      {selected && <span className="text-xs">✓</span>}
    </button>
  );
}
