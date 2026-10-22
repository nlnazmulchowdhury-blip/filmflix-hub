import {
  useMiniPlayer,
  type PlayerAudioTrack,
  type PlayerDub,
  type PlayerLevel,
} from "@/components/mini-player-context";
import { animeEmbedUrl, dramaEmbedUrl } from "@/lib/autoembed";
import { vidboxEmbedUrl, vixsrcEmbedUrl, nxshaEmbedUrl, vidukiEmbedUrl } from "@/lib/vaplayer";
import {
  isEmbedUrl,
  probeEmbedPage,
  raceEmbedStreams,
  fetchEmbedQualities,
  fetchTitleDownloads,
  type EmbedCandidate,
  type EmbedRaceResult,
  type TitleDownloadProvider,
} from "@/lib/embed-resolver";
import {
  downloadHls,
  hlsByContent,
  isHlsLink,
  pipedTarget,
  proxyUrl,
  saveBlob,
} from "@/lib/hls-download";
import {
  audioKeyOf,
  fetchServerAudio,
  type ServerAudio,
} from "@/lib/embed-languages";
import { browserDecodesHevc, onPlaybackFailure } from "@/lib/playback-health";
import { AD_TEST_SECONDS, fetchHilltopVast, type VastAd } from "@/lib/vast";
import PreRollAd from "@/components/PreRollAd";
import {
  refererFor,
  setSnifferReferer,
  useSniffedStreams,
  type SniffedStream,
} from "@/lib/media-sniffer";
import {
  Bookmark,
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
  MonitorPlay,
  MoreHorizontal,
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
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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

/** Extra times a title's provider race is re-asked before our stage gives up. */
const MAX_RACE_TRIES = 2;

/** One pill in the row under the stage box. The bar is white-on-black because
 *  it floats over the film; these sit on the page, so they wear the page's own
 *  colors and follow the theme toggle. */
const CHIP =
  "flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3.5 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted";

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
  saved,
  onToggleSave,
}: {
  movieId: string;
  videoUrl: string;
  title: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  /** External ids the provider servers build their embed URLs from. */
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
  /** Is this title in the viewer's list — drives the Save chip under the box. */
  saved?: boolean;
  /** Omitted = no Save chip (a page that cannot save anything). */
  onToggleSave?: () => void;
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
    audioTracks,
    activeAudioTrack,
    setAudioTrack,
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
    levels,
    activeLevel,
    setLevel,
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
  const [qualityOpen, setQualityOpen] = useState(false);
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

  /* -------- Playback server: stored file vs the provider servers -------- */
  /* A stored URL that is actually a provider player page (vidlink.pro,
     vixsrc.to, …) — it goes through the embed resolver, never to <video>.
     An admin can also pin an explicit provider page (embed_url). */
  const embedSource = providerEmbedUrl || (isEmbedUrl(videoUrl) ? videoUrl : "");
  const hasNativeSource =
    (Boolean(videoUrl) && !embedSource) || dubs.length > 0 || qualities.length > 0;

  /* The provider chains, each its own selectable server:
     nxsha   → web.nxsha.app: a multi-source player whose upstream HLS is read
               server-side, so its film runs inside our own player.
     vidapi  → vixsrc.to. The key is what it replaced: admin rows store their
               server choices by key, not by provider.
     vidbox  → vidlink.pro, the provider-pinned embedSource: its stream token
               is minted server-side now, so an H.264 title runs in our player
               and only a title vidlink holds as HEVC stays on its own screen.
     viduki  → play.xpass.top, the player viduki.net's fourth API frames: its
               answer is an AES-GCM envelope whose key is built from the path and
               the token printed in its own page, so the Worker opens it and the
               film runs here too. */
  const vidboxTarget =
    embedSource || vidboxEmbedUrl({ tmdbId, imdbId, kind, season, episode });
  const vixsrcTarget = vixsrcEmbedUrl({ tmdbId, imdbId, kind, season, episode });
  const nxshaTarget = nxshaEmbedUrl({ tmdbId, imdbId, kind, season, episode });
  const vidukiTarget = vidukiEmbedUrl({ tmdbId, imdbId, kind, season, episode });

  /* vidlink.pro ships most titles as HEVC-only files, and a browser without
     hardware HEVC shows a permanent black rectangle for them. Our resolver only
     ever takes an H.264 answer from it, so this gate is about its *own* player:
     for a viewer who cannot decode HEVC, that provider stays off the opening
     pick (see baseDefault). */
  const hevc = browserDecodesHevc();

  /* Videasy paints its "We couldnt find that" wall in the browser, after its
     sources back end answers empty, so the page it hands our iframe always
     looks fine — status 200, for every title, dead provider or not. The Worker
     asks the service behind that wall instead, and answers `live: false` only
     when it is verifiably offline. A tab the viewer can only ever be punished
     by is not a tab: it leaves the list, and comes back with the provider. */
  const [dramaLive, setDramaLive] = useState<boolean | null>(null);

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
  /* nxsha leads the providers: its upstream is read server-side, so its film
     runs under our own play/volume/progress bar instead of behind an iframe. */
  if (nxshaTarget && !off("nxsha"))
    servers.push({
      key: "nxsha",
      label: `Server ${++serverNo}`,
      sub: "nxsha · multi-source",
    });
  if (vixsrcTarget && !off("vidapi"))
    servers.push({ key: "vidapi", label: `Server ${++serverNo}`, sub: "vixsrc · HLS player" });
  /* The anime episode server keys off the TMDB id — only offer it when the
     current title actually has one. */
  if (tmdbId && !off("anime"))
    servers.push({ key: "anime", label: `Server ${++serverNo}`, sub: "VidNest · anime + dubs" });
  /* viduki's fourth API: its envelope opens server-side and every ladder it
     lists is plain H.264 HLS, so this one runs under our controls too. Keys off
     the TMDB number because its routes understand nothing else. */
  if (vidukiTarget && !off("viduki"))
    servers.push({
      key: "viduki",
      label: `Server ${++serverNo}`,
      sub: "viduki · xpass ladders",
    });
  /* VidBox second to last: its page used to mint the stream token inside a
     libsodium/WASM handshake in the viewer's browser, which no server-side
     resolver could reproduce — so it could only ever run on the provider's own
     screen. That token is minted here now, so an H.264 title plays under our
     controls; a title vidlink only holds as HEVC still needs its player, which
     is why this chip stays below the ones that always answer with a stream. */
  if (vidboxTarget && !off("vidbox"))
    servers.push({
      key: "vidbox",
      label: `Server ${++serverNo}`,
      sub: "VidBox · vidlink.pro",
    });
  /* Drama last, always: its chip leaves the list when the probe finds the back
     end offline, and a chip vanishing mid-watch must never renumber the server
     the viewer just tapped. */
  if (tmdbId && !off("drama") && dramaLive !== false)
    servers.push({ key: "drama", label: `Server ${++serverNo}`, sub: "Drama · Videasy · has ads" });

  /* Default to Server 1 only when there is no stored file to play — so the
     API-backed embed auto-plays for catalog entries without a local source,
     while existing files keep their native player (quality/dub/subtitles).
     An admin-set default wins, but only when that server is actually shown;
     otherwise fall back to the same heuristic, then to the first live server.
     A server that can only frame its provider never opens by choice — only
     when the title has nothing else. */
  const baseDefault = hasNativeSource
    ? "original"
    : nxshaTarget
      ? "nxsha"
      : vixsrcTarget
        ? "vidapi"
        : vidboxTarget && hevc
          ? "vidbox"
          : "original";
  const usableKeys = servers.map((s) => s.key);
  const wanted =
    defaultServer && usableKeys.includes(defaultServer) ? defaultServer : baseDefault;
  const initialServer = usableKeys.includes(wanted) ? wanted : (usableKeys[0] ?? baseDefault);
  const [server, setServer] = useState<
    "original" | "vidbox" | "vidapi" | "nxsha" | "anime" | "viduki" | "drama"
  >(initialServer as any);
  const [serverOpen, setServerOpen] = useState(false);

  /* -------- Episode servers: Anime (VidNest) and Drama (Videasy) -------- */
  const [aeEpisode, setAeEpisode] = useState(episode ?? 1);
  /* The episode list under the player also selects the episode, so a pick
     there has to move this stepper instead of being overridden by it. */
  useEffect(() => {
    setAeEpisode(episode ?? 1);
  }, [episode]);

  /* Drama is still iframe-only: its back end answers nobody, so its provider
     player keeps the whole stage with only our bar above it. */
  const usingAutoembed = server === "drama";
  /* Read once, up here: below, `iframeOnlyServer` narrows `server` along the
     provider-framing path and a second `server === "anime"` looks impossible. */
  const animeServer = server === "anime";
  const autoembedUrl =
    server === "anime"
      ? animeEmbedUrl({ tmdbId, kind, season, episode: aeEpisode })
      : server === "drama"
        ? dramaEmbedUrl({ tmdbId, kind, season, episode: aeEpisode })
        : "";

  /* The provider-page servers: each shows that provider's own iframe, and each
     gets a server-side ad-free resolve attempt before it. Anime is one of them
     now that its scraper API is read server-side, so a stream it holds plays
     under our own controls instead of only showing a strip above its player. */
  const usingEmbed =
    server === "vidbox" ||
    server === "vidapi" ||
    server === "nxsha" ||
    server === "anime" ||
    server === "viduki";
  const currentEmbedTarget =
    server === "vidapi"
      ? vixsrcTarget
      : server === "nxsha"
        ? nxshaTarget
        : server === "anime"
          ? autoembedUrl
          : server === "viduki"
            ? vidukiTarget
            : vidboxTarget;

  useEffect(() => {
    const target = dramaEmbedUrl({ tmdbId, kind, season: 1, episode: 1 });
    if (!target || off("drama")) {
      setDramaLive(null);
      return;
    }
    let cancelled = false;
    void probeEmbedPage(target).then((r) => {
      if (!cancelled) setDramaLive(r ? r.live : null);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tmdbId, kind]);
  /* The URL of the full-cover iframe server when it is active ("" = none). */
  const iframeServerUrl = autoembedUrl ?? "";

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
  /* The last miss was a provider refusing our Worker, not a provider with
     nothing to offer: its own page plays for the viewer, so the stage says
     that instead of "no server for this title" and offers their player. */
  const [embedBlocked, setEmbedBlocked] = useState(false);
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
  /* The same tap, kept after the race above has spent `tappedServer`, so a race
     that was already running when the viewer chose a server can see that choice
     and stand down instead of arriving late and taking the film back. It also
     carries the title, because picking the next episode of a server the viewer
     chose must stay on that server, not hand the film to whoever answers the
     lineup fastest. */
  const lastTap = useRef<{ movieId: string; raceKey: string; key: string } | null>(null);
  /* Resolved streams this title already died on in the player. They stay black
     if the race hands them back, so the next pick skips them. */
  const deadStreams = useRef<Set<string>>(new Set());
  /* Every server the lineup race loaded for THIS title and episode, keyed by the
     provider page the links came from. One chain answering does not stop the
     others, so when the viewer opens a different server chip its stream is
     already in hand here — the film starts from this map instead of waiting out
     a second resolve of that page. A provider signs its playlist for its own
     session, so this lives only as long as the title it was pulled for. */
  const racedStreams = useRef<Map<string, EmbedCandidate[]>>(new Map());
  /* The title+episode `racedStreams` belongs to, and the one the background
     warm-up has already been asked for, so it never re-fires on a re-render. */
  const warmFor = useRef<string>("");
  const warmedFor = useRef<string>("");

  /* One race per title and episode: season/episode picks from the list under
     the player change this, so each new episode gets every server asked again. */
  const raceKey = `${movieId}|${season ?? 1}|${episode ?? 1}`;

  /* Our player is what loads first on every embed server, and for the servers
     that can hand us a stream it is what *stays*: their provider page is never
     framed here. VidBox and Drama are the two chips that often have nothing of
     ours to play — vidlink keeps most titles as HEVC its own player decodes, and
     Videasy answers nobody — so for them the box goes to the provider once we
     stop asking. The moment VidBox does resolve an H.264 stream, `embedStream`
     supersedes its frame and the viewer is back under our controls. A page the
     provider itself 500s stays hidden either way: its error wall is not a
     player. */
  const iframeOnlyServer = server === "vidbox" || server === "drama";
  const [providerDue, setProviderDue] = useState(false);
  /* The provider's page is ready to be shown, but the box stays ours until the
     viewer presses our own play button. Their player starts by itself once
     framed (verified: vidlink.pro autoplays inside our iframe), so that press
     is what opens the film — no provider skin ever paints first. A chip that
     can feed our player never hands its box over: if the race misses there, our
     cover stays up and the viewer picks another server. */
  const providerReady = iframeOnlyServer && (embedStatus === "failed" || providerDue);
  const [providerOpen, setProviderOpen] = useState(false);
  const providerFramed = providerReady && providerOpen;
  const embedIframe = usingEmbed && !embedStream && embedLive !== false && providerFramed;
  const embedDead = usingEmbed && !embedStream && embedLive === false;
  /* The stage still belongs to us: a provider server is picked, nothing plays
     yet, and its player has not been handed the box. */
  const awaitingPlayer =
    !embedDead && !embedStream && (usingEmbed || usingAutoembed) && !providerFramed;
  /* The race is spent on a chip that can feed our own player. Its cover stays
     up — the provider page is not framed behind the viewer's back — with the
     spinner stopped, the reason in amber, and Try again beside it. */
  const raceSpent = awaitingPlayer && usingEmbed && embedStatus === "failed";

  /* A new title, episode or chip is a clean slate: our stage holds the box
     again, so a provider page left over from the previous one never leaks into
     it. Kept off `embedStatus` on purpose — a race that fails and re-arms must
     not yank away a page already on screen. */
  useEffect(() => {
    setProviderDue(false);
    setProviderOpen(false);
  }, [server, raceKey]);

  useEffect(() => {
    if (!awaitingPlayer || !iframeOnlyServer) return;
    /* Drama only ever frames a page, so it needn't keep the viewer staring at a
       spinner. VidBox is being asked with a real handshake now, and a page that
       flashes into the iframe and straight back out again is worse than waiting
       a few seconds under our own cover — so it gets long enough to answer.
       On a machine that decodes HEVC its file answer is playable for us too,
       so the handshake gets longer still rather than having its box taken away
       mid-flight by the provider's own player. */
    const wait = server === "vidbox" ? (hevc ? 14_000 : 6_000) : 1_500;
    const t = setTimeout(() => setProviderDue(true), wait);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, raceKey, embedStream, usingEmbed, usingAutoembed, embedStatus]);

  /* Provider scrapers rotate: a chain that answered empty a moment ago often
     has a live link seconds later, so a miss is retried before the stage gives
     up. `raceNonce` is what re-arms the resolver effect for the same title. */
  const [raceNonce, setRaceNonce] = useState(0);
  const raceTries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armRaceRetry = useCallback(() => {
    if (retryTimer.current || raceTries.current >= MAX_RACE_TRIES) return false;
    raceTries.current += 1;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      racedFor.current = "";
      streamedFor.current = "";
      setRaceNonce((n) => n + 1);
    }, 2_500);
    return true;
  }, []);
  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );
  /** The cover's "Try again": the viewer's word that this chip is worth
   *  asking once more, so the retry budget is refilled and spent immediately.
   *  It also takes the box back from a provider page the viewer had agreed to
   *  frame — asking again means wanting our own player. */
  const retryRace = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    raceTries.current = 0;
    racedFor.current = "";
    streamedFor.current = "";
    setEmbedStatus("resolving");
    setEmbedError("");
    setProviderOpen(false);
    setRaceNonce((n) => n + 1);
  }, [setEmbedStatus, setEmbedError, setProviderOpen, setRaceNonce]);

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

  /* A provider's own page is what is on screen, and our design sits above it:
     those framed blocks are z-[60] and the native bar layers over them at
     z-[61]. That trade gives up the provider's own play/seek/volume along its
     bottom edge — a cross-origin frame cannot be seeked, muted or read from
     here, so the bar's media buttons are disabled rather than fake, while the
     server chip, the stepper and fullscreen keep working for real. VidNest keys
     its pages per episode, so its stepper rides along. */
  const providerMode =
    embedIframe ||
    usingAutoembed && Boolean(iframeServerUrl) && providerFramed;
  /* Only providers keyed per episode need the stepper, and a film never does —
     `kind` can be unknown on a synthetic route, so hide it for movies rather
     than show an "Ep 1" that changes nothing. */
  const framedEpisodeStepper =
    providerMode && kind !== "movie" && (usingAutoembed || animeServer);
  const providerUrl = (embedUrl || embedSource || iframeServerUrl || "") as string;
  const providerName =
    (embedIframe ? embedHost : servers.find((s) => s.key === server)?.sub?.split(" · ")[0]) ||
    "Provider";

  /* Over a framed provider our bar is painted for the design, but the media
     controls drive our own element, which sits behind that page — so they are
     left inert and say why, rather than moving a picture we cannot move. */
  const inertTitle = `${providerName}'s player runs this film — these controls drive our own stream, not its page`;
  const INERT = "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

  /* The bar's left slot carries a clock on our own streams; over a frame it
     names the host instead — same footprint, and tapping it still opens the
     resolver log the old top band used to. */
  const providerSlot =
    embedStatus === "resolving"
      ? "Trying…"
      : embedStatus === "failed" && embedBlocked
        ? `${providerName} refused us`
        : embedStatus === "failed" && !embedCarried
          ? `${providerName} · none`
          : providerName;
  const providerSlotTitle =
    embedStatus === "failed" && embedBlocked
      ? `${providerName} refused this site's resolver but serves you — press play on its picture, and tap for what every server answered`
      : embedStatus === "failed" && !embedCarried
        ? `${providerName} may not carry this title — tap to see what every server answered`
        : `${providerName} is running the film — its own play, seek and volume sit inside its page, so ours are switched off. Tap for what every server answered.`;

  /* Every ad-free provider available for this title/episode, honouring the
     servers an admin switched off. These are what the race asks in parallel.
     Drama is left out: nothing ad-free can be pulled from it while its back end
     is down, so it would only ever report a miss.

     Menu order: the chains that can run in our own player are also the ones
     preferred when the race has to pick a provider page to frame. */
  const adFreeChains = () =>
    [
      { key: "nxsha", url: nxshaTarget },
      { key: "vidapi", url: vixsrcTarget },
      { key: "anime", url: autoembedUrl },
      { key: "viduki", url: vidukiTarget },
      { key: "vidbox", url: vidboxTarget },
    ].filter((c) => c.url && !off(c.key)) as { key: string; url: string }[];

  /** Keep a chain's playable links as soon as it answers, win or not. */
  const rememberRaced = useCallback(
    (ready: { url: string; candidates: EmbedCandidate[] }) => {
      racedStreams.current.set(ready.url, ready.candidates);
    },
    [],
  );

  /* Ask every ad-free chain for this title in parallel and keep whatever they
     answer. Nothing plays from this pass — it is for the title whose own file
     is already on screen: no provider can load faster than that, so the race's
     prize here is only that the server chips are ready when opened. */
  const warmAdFree = useCallback(() => {
    const chains = adFreeChains();
    if (chains.length)
      void raceEmbedStreams(chains.map((c) => c.url), null, rememberRaced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rememberRaced]);

  /* Only worth asking what the other servers carry when the viewer looks at
     the server menu: opening a chip then finds its links already resolved,
     exactly as the background warm used to give. Once per title+episode. */
  useEffect(() => {
    if (!serverOpen || usingEmbed || warmedFor.current === raceKey) return;
    warmedFor.current = raceKey;
    warmAdFree();
  }, [serverOpen, usingEmbed, raceKey, warmAdFree]);

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
          resumeKey: raceKey,
          title,
          videoUrl: c.url,
          isHls: c.kind === "hls",
          posterUrl,
          backdropUrl,
        },
        true,
      );
    },
    [start, movieId, raceKey, title, posterUrl, backdropUrl],
  );

  /* A provider page is only as good as the stream we can pull out of it
     server-side. Every provider for the title is asked at once, and our own
     stage stays up while it waits: a hit plays the clean stream here, a miss
     hands the box to that provider's player. A page the provider itself 500s
     stays hidden. `only` narrows the ask to the one provider the viewer tapped. */
  const raceServers = useCallback(
    async (
      activeKey: string,
      chains: { key: string; url: string }[],
      pages: { key: string; url: string }[],
      only = "",
    ) => {
      setEmbedStatus("resolving");
      setEmbedError("");
      setEmbedBlocked(false);

      /* Ask for every provider's stream and check every provider page at the
         same time: the fastest chain wins, and the page probes decide which
         iframe to fall back on without waiting for each server in turn. */
      const liveness = pages.map((p) =>
        probeEmbedPage(p.url).then((r) => ({
          ...p,
          /* A probe that never answered is not evidence the provider is down. */
          live: r ? r.live : true,
          carried: r?.carried ?? false,
          /* The provider answered its visitor fine but refused *our* Worker —
             the honest reason for a miss, and the reason framing helps. */
          blocked: Boolean(r?.blocked),
          reason: r?.reason ?? "",
        })),
      );

      /* Nothing ad-free worked (or what worked later died in the player). For a
         server that can only ever show its provider, that provider's player
         takes the stage and its page probes decide which one — a provider with
         no page for this title is skipped instead of framed. For a server that
         can hand us a stream, our own stage keeps the box and says so. */
      const showProviders = async (why: string, frame: boolean) => {
        const answers = await Promise.all(liveness);
        for (const a of answers) {
          if (a.live) deadEmbeds.current.delete(a.key);
          else deadEmbeds.current.add(a.key);
        }
        const mine = answers.find((a) => a.key === activeKey);
        /* Say *who* refused rather than "no server has this title": vixsrc
           403s Cloudflare while the same URL plays fine in the viewer's own
           browser, and Videasy's back end is offline for everyone. Both are
           the provider's news, and the probe carries it. */
        const honest =
          mine && mine.reason && (mine.blocked || !mine.live) ? mine.reason : why;
        const framedLive = frame && (mine ? mine.live : true);
        setEmbedCandidates([]);
        setEmbedStatus("failed");
        setEmbedBlocked(Boolean(mine && mine.blocked));
        setEmbedError(
          framedLive ? honest
            : mine && mine.blocked
              ? `${honest}. Its page may still play this title in your browser.`
              : honest,
        );

        setEmbedLive(mine ? mine.live : true);
        /* Whose player gets framed: one that says it carries this title beats
           one that merely answers. Several providers serve their own "we don't
           have this" wall at HTTP 200, so staying put would leave the viewer
           staring at it while another server plays the film. */
        const next =
          !frame || !mine || mine.carried
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
      /* A tapped chip is a cold start only if the lineup race has not already
         pulled its links. Every chain keeps resolving after one of them wins, so
         the server the viewer opens next usually has a playable ladder waiting
         here, and the film starts from it instead of after a second trip through
         that provider's page. */
      const warm = solo ? racedStreams.current.get(only) : undefined;
      const race: EmbedRaceResult = warm?.length
        ? { win: { url: only, candidates: warm }, error: "" }
        : await raceEmbedStreams(
            solo
              ? chains.filter((c) => c.url === only).map((c) => c.url)
              : chains.map((c) => c.url),
            solo
              ? { tmdbId: null }
              : { tmdbId, kind, season, episode: usingAutoembed ? aeEpisode : (episode ?? 1) },
            rememberRaced,
          );
      /* A chip the viewer tapped outranks any race they did not ask for. That
         one asks the whole lineup, so when it lands it would move the label and
         swap the film out from under the server they just chose — which reads
         as "this server does not work" — and it does the same thing one
         episode late: the lineup race for the next episode can pick a different
         provider and slide the tab sideways even though the tapped server was
         playing fine. So a tap holds for the rest of the title. */
      if (
        !solo &&
        lastTap.current?.movieId === movieId &&
        lastTap.current.key !== activeKey
      )
        return;
      if (race.win) {
        const step = chains.find((c) => c.url === race.win?.url);
        /* Skip links this title already failed on, and — for a viewer without
           HEVC decode — anything the provider labels HEVC. */
        const pool = race.win.candidates.filter(
          (c) => !deadStreams.current.has(c.url) && (hevc || c.codec !== "hevc"),
        );
        if (pool.length) {
          raceTries.current = 0;
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

      const why = race.win
        ? "Every stream it offered died in this player."
        : race.error || "No ad-free chain worked.";
      /* This page's own answers are what just failed, so drop them: the next
         pass — the armed retry or the cover's Try again — has to ask that
         provider again instead of replaying the same links out of the warm map.
         The other servers keep theirs; they are still waiting to be opened. */
      racedStreams.current.delete(only || chains.find((c) => c.key === activeKey)?.url || "");
      /* A chip that can feed our own player keeps the stage and asks again —
         the providers rotate their scrapers, so the second or third pass often
         answers when the first was empty. VidBox is in that group now: its
         handshake is a fresh ask every pass, so it retries before its own screen
         takes the box. Only Drama, which answers nobody ad-free, gives up
         straight away. */
      const retryable = activeKey !== "drama";
      if (retryable && armRaceRetry()) {
        setEmbedStatus("resolving");
        setEmbedError(why);
        return;
      }
      /* Whose screen takes the box when we do stop asking: Drama always, VidBox
         for the titles vidlink holds only as HEVC — a provider page at least
         plays there, while our player would paint black. */
      await showProviders(why, activeKey === "vidbox" || activeKey === "drama");
    },
    [playEmbedCandidate, armRaceRetry, server, movieId, tmdbId, kind, season, episode, aeEpisode, hevc, raceKey, rememberRaced],
  );

  /** The resolver panel's button: retry the page currently in the box. */
  const runEmbedResolve = useCallback(
    (url: string) => {
      /* Asking again means not replaying what this page already handed us. */
      racedStreams.current.delete(url);
      return raceServers(server, [{ key: server, url }], [{ key: server, url }]);
    },
    [raceServers, server],
  );

  /* An embed server (vidbox/vidapi/nxsha) is showing: fire the whole provider
     race for this title+episode. Switching servers or episodes re-runs it,
     clearing the previous server's candidates/stream first; a server switch
     that the race itself caused only re-probes, so it never loops. */
  useEffect(() => {
    /* What the race loaded is signed for the session that minted it, so it only
       belongs to this title and episode. */
    if (warmFor.current !== raceKey) {
      warmFor.current = raceKey;
      racedStreams.current.clear();
      warmedFor.current = "";
    }
    if (!usingEmbed) {
      /* Server 1 has the film on our own server and Server 6 answers nobody
         ad-free, so neither has a race to win. The lineup is asked when the
         viewer opens the chip menu instead — see the warming effect below:
         racing every title in the background spent a round of provider asks on
         titles whose server was never changed. */
      return;
    }
    /* A retry is armed by disarming it first: the effect re-runs for the title,
       chip or manual ask that supersedes the queued pass, and the timer is
       spent the moment it fires. Clearing it here unconditionally cancelled the
       very pass that re-ran this effect, so a failed race never asked twice. */
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
    /* A tap on this title's chip outranks the stream already on screen — and it
       keeps outranking it for the rest of this title, so the next episode is
       asked from the server the viewer chose instead of from the whole lineup,
       which would hand the film to whoever answers first and move the tab. */
    const tapped =
      tappedServer.current === `${raceKey}|${server}` ||
      (lastTap.current?.movieId === movieId && lastTap.current.key === server)
        ? currentEmbedTarget
        : "";
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
    void raceServers(server, chains, chains, tapped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usingEmbed, currentEmbedTarget, raceKey, raceNonce]);

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
          { movieId, resumeKey: raceKey, title, videoUrl: page, posterUrl, backdropUrl },
          true,
        );
    },
    [embedStream, currentEmbedTarget, embedSource, start, movieId, raceKey, title, posterUrl, backdropUrl],
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

  /* A stream the resolver handed over still has to produce its first frame, and
     the cover comes down the moment the URL arrives. That gap is a black
     rectangle with our bar on it — which is exactly what reads as "this server
     is empty". So watch the media element itself: our mark stays up until it has
     a picture, and comes back if the picture stalls mid-film. */
  const [pictureUp, setPictureUp] = useState(false);
  useEffect(() => {
    /* The film's own element, never the first `<video>` in the box: while a
       pre-roll is up its creative is mounted inside this same container ahead of
       it, and a watcher that read that element would call the ad's first frame
       the film's arrival. */
    const el = containerRef.current?.querySelector<HTMLVideoElement>("[data-film]");
    if (!el) return;
    /* `loadstart` is the reset: a new source drops readyState to 0, so the mark
       comes back on its own without a second effect. */
    const mark = () => setPictureUp(el.readyState >= 3);
    const events = [
      "loadstart",
      "loadeddata",
      "canplay",
      "playing",
      "timeupdate",
      "waiting",
      "stalled",
    ] as const;
    events.forEach((e) => el.addEventListener(e, mark));
    mark();
    return () => events.forEach((e) => el.removeEventListener(e, mark));
  }, [embedStream, mode]);
  const streamWarming = Boolean(embedStream) && !pictureUp;

  /* ------------------------------------------------------------ pre-roll */

  /* The one gap on this page that belongs to nobody but us is the wait between
     the viewer's click and the server's first frame, so that is the only place
     an ad may appear: it paints over our own cover while the film loads. Once it
     has the box it keeps it for the creative's whole length — a frame arriving
     behind it does not cut it short — and the movie takes the stage back when
     the ad ends by itself or when the viewer skips it, which is theirs after
     five seconds. It never sits over a provider's page, and a load that answers
     fast never sees it. */
  const [vast, setVast] = useState<VastAd | null>(null);
  const [adUp, setAdUp] = useState(false);
  const adShownFor = useRef("");
  const adLastAt = useRef(0);
  /* Where the film's second hand stood when the ad took the box, or -1 while no
     ad has one to give back. The film keeps running muted behind the creative,
     so this is the mark it is brought back to when the ad is done. */
  const adFilmMark = useRef(-1);
  const stageLoading =
    (awaitingPlayer || streamWarming) && !embedDead && !providerFramed && !raceSpent;

  useEffect(() => {
    const ac = new AbortController();
    const stop = setTimeout(() => ac.abort(), 12_000);
    fetchHilltopVast(ac.signal)
      .then((ad) => {
        clearTimeout(stop);
        setVast(ad);
      })
      .catch(() => undefined);
    return () => {
      clearTimeout(stop);
      ac.abort();
    };
  }, [raceKey]);

  /* TEST KNOB: above 0 the creative is cut off at this many seconds whatever it
     asked for, which is how the owner looks at the ad for a fixed length. The
     shipped rule needs no timer: the ad ends when its own length is done. */
  useEffect(() => {
    if (!adUp || AD_TEST_SECONDS <= 0) return;
    const stop = setTimeout(() => setAdUp(false), AD_TEST_SECONDS * 1000);
    return () => clearTimeout(stop);
  }, [adUp]);

  /* An ad owns the sound and the box while it is up. The film is deliberately not
     paused for it — a paused element stalls hls.js's own recovery and the frame
     never comes back — so it is muted instead, and gets its volume and its place
     back at the hand-off. A viewer who had the film muted keeps it muted, and one
     who unmutes it mid-ad is not muted again behind their back. */
  const adMutedFilm = useRef(false);
  useEffect(() => {
    if (adUp && !muted) {
      adMutedFilm.current = true;
      controls.toggleMute();
    } else if (!adUp) {
      if (adMutedFilm.current && muted) controls.toggleMute();
      adMutedFilm.current = false;
      /* The film ran the whole time behind a creative nobody was watching, so it
         is brought back to where the ad found it: a viewer who sat through a
         minute of advertisement is not owed minute one of the film's opening.
         Only an ad that actually held the box is paid back — the -1 mark says
         there was none, so a title resuming mid-film keeps its place. */
      if (adFilmMark.current >= 0) {
        const drift = currentTime - adFilmMark.current;
        adFilmMark.current = -1;
        if (drift > 1) controls.seekBy(-drift);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adUp]);

  useEffect(() => {
    if (adUp || !vast || !stageLoading) return;
    /* One ad per viewing of a title, and never two in quick succession: a
       viewer stepping through servers or episodes must not be re-advertised at
       every step. */
    const key = `${raceKey}|${server}`;
    if (adShownFor.current === key) return;
    const t = setTimeout(() => {
      if (Date.now() - adLastAt.current < 45_000) return;
      adShownFor.current = key;
      adLastAt.current = Date.now();
      adFilmMark.current = currentTime;
      setAdUp(true);
    }, 1_500);
    return () => clearTimeout(t);
  }, [adUp, vast, stageLoading, raceKey, server]);

  const selectServer = (key: string) => {
    /* Tapping a server is the viewer changing their mind about a language
       hand-off, so an unfinished one must not fire on the stream they just
       asked for. (handOffLanguage calls this and then re-arms its intent.) */
    clearPendingLang();
    const next:
      | "original"
      | "vidbox"
      | "vidapi"
      | "nxsha"
      | "anime"
      | "viduki"
      | "drama" =
      key === "vidbox"
        ? "vidbox"
        : key === "vidapi"
          ? "vidapi"
          : key === "nxsha"
            ? "nxsha"
            : key === "anime"
              ? "anime"
              : key === "viduki"
                ? "viduki"
                : key === "drama"
                  ? "drama"
                  : "original";
    /* Remember the choice for this title: the resolvers answer that server
       alone instead of leaving the race's winner on screen under a new name. */
    tappedServer.current = next === server ? "" : `${raceKey}|${next}`;
    lastTap.current = { movieId, raceKey, key: next };
    if (next === "original" && embedStream) {
      setEmbedStream(null);
      streamedFor.current = "";
      start(
        {
          movieId,
          resumeKey: raceKey,
          title,
          videoUrl: embedSource ? "" : videoUrl,
          posterUrl,
          backdropUrl,
        },
        true,
      );
    }
    if ((next === "anime" || next === "drama") && embedStream) {
      /* That provider's own player was asked for, so it takes the stage rather
         than keeping a stream pulled from somewhere else. */
      setEmbedStream(null);
      streamedFor.current = "";
      start(
        {
          movieId,
          resumeKey: raceKey,
          title,
          videoUrl:
            next === "anime"
              ? animeEmbedUrl({ tmdbId, kind, season, episode: aeEpisode })
              : dramaEmbedUrl({ tmdbId, kind, season, episode: aeEpisode }),
          posterUrl,
          backdropUrl,
        },
        true,
      );
    }
    setServer(next);
    /* Our stage takes the box and the providers are raced behind it; the
       resolver panel stays behind the "Ad-free stream" button in the strip
       shown once a provider player is framed. */
    bumpControlsActivity();
  };

  /* A viewer can reach Server 6 in the moment before the probe answers. Once it
     says the provider is offline, that tab has already left the list — leaving
     them inside it would keep them watching a wall, so hand them to the next
     server on offer and say why. */
  useEffect(() => {
    if (dramaLive !== false || server !== "drama") return;
    const next = servers.find((s) => s.key !== "drama");
    if (!next) return;
    toast.info(`Videasy is offline right now — using ${next.label} instead.`);
    selectServer(next.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dramaLive, server]);

  /* -------- Every server's languages, for one language pick -------- */
  /* A playlist is the only honest witness for how many voices a film has, and
     every server holds its own. So opening the language menu asks each server
     on offer for its master playlist and reads its audio renditions; a pick
     that lives on another server becomes a hand-off — change server, and when
     that stream parses, land on the language. */
  const [sweep, setSweep] = useState<{
    key: string;
    status: "idle" | "loading" | "done";
    map: Record<string, ServerAudio[]>;
  }>({ key: "", status: "idle", map: {} });
  const sweepStartedFor = useRef("");
  const pendingLang = useRef<{
    key: string;
    label: string;
    server: string;
    dubLabel?: string | null;
    /** The language list in play at the moment of the tap — a hand-off must
     *  not apply itself to it, or it would set a track id on the *previous*
     *  server's stream. */
    stale: PlayerAudioTrack[];
  } | null>(null);
  const pendingLangTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const embedTargets: Record<string, string> = {
    nxsha: nxshaTarget || "",
    vidapi: vixsrcTarget || "",
    viduki: vidukiTarget || "",
    vidbox: vidboxTarget || "",
    anime: tmdbId ? animeEmbedUrl({ tmdbId, kind, season, episode: aeEpisode }) : "",
  };
  const audioSweepKey = `${raceKey}|${aeEpisode}`;

  useEffect(() => {
    if (!langOpen || sweepStartedFor.current === audioSweepKey) return;
    sweepStartedFor.current = audioSweepKey;
    const targets = servers
      .map((s) => [s.key, embedTargets[s.key] ?? ""] as const)
      .filter(([key, url]) => key !== "original" && Boolean(url));
    if (!targets.length) {
      setSweep({ key: audioSweepKey, status: "idle", map: {} });
      return;
    }
    setSweep({ key: audioSweepKey, status: "loading", map: {} });
    /* Each server lands in the menu as it answers rather than all at once at
       the end: a provider that takes twenty seconds shouldn't hold the ones
       that already replied behind a spinner. */
    let settled = 0;
    targets.forEach(([key, url]) => {
      void fetchServerAudio(url).then((list) => {
        if (list.length > 0)
          setSweep((prev) =>
            prev.key === audioSweepKey
              ? { ...prev, map: { ...prev.map, [key]: list } }
              : prev,
          );
        if (++settled === targets.length)
          setSweep((prev) =>
            prev.key === audioSweepKey ? { ...prev, status: "done" } : prev,
          );
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [langOpen, audioSweepKey]);

  /* Results belong to the title they were asked for, so a new film never shows
     the last one's voices. */
  const serverAudio = sweep.key === audioSweepKey ? sweep.map : {};
  const audioProbe = sweep.key === audioSweepKey ? sweep.status : "idle";

  /* Land the language once its server is playing. The list in state is refused
     until it is a *new* one, so a pick made against Server 2 can never set a
     track id on Server 3's stream by mistake; a hand-off whose provider only
     frames its own page (so no list ever arrives) is given up on by the timeout
     below, which says so instead of hanging. */
  const clearPendingLang = () => {
    pendingLang.current = null;
    if (pendingLangTimer.current) {
      clearTimeout(pendingLangTimer.current);
      pendingLangTimer.current = null;
    }
  };

  useEffect(() => {
    const intent = pendingLang.current;
    if (!intent || intent.server !== server) return;
    if (intent.dubLabel !== undefined) {
      if (dubs.length === 0) return;
      clearPendingLang();
      if (activeDub !== intent.dubLabel) setDub(intent.dubLabel);
      return;
    }
    /* An empty list is not an answer: hls.js reports the renditions it has
       parsed, so the first report for a new stream can arrive before its audio
       group is read. Wait for a real list — the timeout below still gives up on
       a server that never produces one. */
    if (audioTracks === intent.stale || audioTracks.length === 0) return;
    const hit = audioTracks.find(
      (t) => audioKeyOf({ name: t.name, lang: t.lang }) === intent.key,
    );
    /* A miss is not a verdict: a provider's first report can name fewer
       renditions than its playlist really carries, and the sources rotate
       between two asks. So the intent stays until either a report names the
       language or the timeout above has heard every report it is going to get. */
    if (!hit) return;
    clearPendingLang();
    if (hit.id !== activeAudioTrack) setAudioTrack(hit.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioTracks, server, dubs, activeDub]);

  const serverName = (key: string) =>
    servers.find((s) => s.key === key)?.label ?? "Server 1";

  /* The tap that starts a hand-off. The toast names the server it went to, so
     the viewer knows why the picture changed underneath them, and the panel
     closes because the answer is no longer in it. */
  const handOffLanguage = (intent: {
    key: string;
    label: string;
    server: string;
    dubLabel?: string | null;
  }) => {
    /* The list this stream reported is the one the new server must replace, so
       take it before the switch clears it. */
    const stale = audioTracks;
    selectServer(intent.server);
    pendingLang.current = { ...intent, stale };
    if (pendingLangTimer.current) clearTimeout(pendingLangTimer.current);
    pendingLangTimer.current = setTimeout(() => {
      if (pendingLang.current?.label !== intent.label) return;
      clearPendingLang();
      toast.info(`${serverName(intent.server)} does not answer with ${intent.label}.`);
    }, 25000);
    toast.info(`Playing ${intent.label} from ${serverName(intent.server)}.`);
    setLangOpen(false);
  };

  /* A new episode, another title or leaving the player cancels a language that
     never landed — its toast would arrive over a film nobody asked it of. */
  useEffect(() => clearPendingLang, // eslint-disable-next-line react-hooks/exhaustive-deps
    [audioSweepKey]);

  /* When an iframe server (autoembed / embed fallback) takes over,
     pause the native file so the two never output audio at once. Our own stage
     covers the box while a race runs, so the file waits for it too. */
  useEffect(() => {
    if ((usingAutoembed || embedIframe || awaitingPlayer) && playing)
      controls.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usingAutoembed, embedIframe, awaitingPlayer, playing]);

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
    setControlsHold(
      langOpen || settingsOpen || serverOpen || qualityOpen || downloadOpen,
    );
  }, [langOpen, settingsOpen, serverOpen, qualityOpen, downloadOpen, setControlsHold]);

  /* Dismiss a player menu from anywhere. The box's own capture handler cannot
     see taps on the picture: the video and its tap-zones are mounted by the
     provider into a slot of their own, so on a phone — where the only way out
     of a menu is a tap — an open menu used to stay open forever. */
  useEffect(() => {
    if (!langOpen && !settingsOpen && !serverOpen && !qualityOpen && !downloadOpen) return;
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-player-menu]")) return;
      setLangOpen(false);
      setSettingsOpen(false);
      setServerOpen(false);
      setQualityOpen(false);
      setDownloadOpen(false);
      setSettingsView("main");
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [langOpen, settingsOpen, serverOpen, qualityOpen, downloadOpen]);

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
      /* Over a framed provider page only fullscreen is ours to key; play, seek
         and volume belong to that page, and driving our hidden video instead
         would fight whoever is actually running the film. */
      if (providerMode && e.key !== "f" && e.key !== "F") return;
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
  }, [isHost, controls, volume, providerMode, bumpControlsActivity]);

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
    const v = document.querySelector("[data-film]");
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
        const v = document.querySelector("[data-film]");
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
                resumeKey: raceKey,
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
    /* Two children now: the stage box, and the row of things to do with it. */
    <div className="w-full">
      <div
        ref={containerCallback}
        className={`group/player relative w-full overflow-hidden bg-black shadow-[0_24px_80px_-24px_rgba(0,0,0,0.9)] ${
          fullscreen
            ? "fixed inset-0 z-[80] rounded-none border-0"
            : "aspect-video max-sm:aspect-[4/3] w-full rounded-xl border border-border/60"
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

        {/* Our design comes up first on every embed server: the poster, our play
            affordance and the server picker hold the box while the providers are
            asked. A provider's own page only ever appears on a chip that cannot
            feed our player at all. */}
        {awaitingPlayer && (
          <div className="absolute inset-0 z-[62] flex flex-col items-center justify-center gap-3 bg-black">
            {movie.backdropUrl || movie.posterUrl ? (
              <img
                src={(movie.backdropUrl ?? movie.posterUrl) as string}
                alt=""
                className="absolute inset-0 size-full object-cover opacity-45"
              />
            ) : null}
            {providerReady && !providerOpen ? (
              /* Our play button, our size, our design — and it is the press that
                 opens the provider's film. The box only becomes theirs after this. */
              <button
                type="button"
                onClick={() => setProviderOpen(true)}
                className="relative z-10 grid size-20 place-items-center rounded-full bg-white/15 text-white backdrop-blur-sm transition-colors hover:bg-white/25 sm:size-24"
                title={`Play this title on ${providerName}'s player`}
                aria-label={`Play on ${providerName}`}
              >
                <Play className="size-9 fill-current sm:size-11" />
              </button>
            ) : (
              <LoadingOrbit paused={raceSpent} className="relative z-10 text-[5.5rem] sm:text-[7rem]" />
            )}
            <span className="relative z-10 max-w-[86vw] truncate rounded-full bg-black/60 px-4 py-1.5 font-display text-sm font-semibold text-white backdrop-blur-sm">
              {title}
            </span>
            {/* While the race runs the orbit is the whole message. A miss is not
                the viewer's problem to read: the reason lives in the resolver log
                behind the bar's status slot, and the cover just offers another
                server. */}
            {!raceSpent && (
              <p className="relative z-10 max-w-[86vw] text-center text-xs text-white/70">
                Loading this server's player…
              </p>
            )}
            {providerReady && !providerOpen && (
              <p className="relative z-10 max-w-[86vw] text-center text-xs text-white/70">
                {`Press play and ${providerName}'s own player starts here — click its picture to pause; its seek and volume hide under our bar.`}
              </p>
            )}
            <div className="relative z-10 mt-1 flex max-w-[94vw] flex-wrap items-center justify-center gap-2">
              <ServerSwitcher
                servers={servers}
                activeKey={server}
                onSelect={selectServer}
                open={serverOpen}
                setOpen={setServerOpen}
                align="left"
                drop="up"
              />
              {raceSpent && (
                <button
                  type="button"
                  onClick={retryRace}
                  className="flex items-center gap-1.5 rounded-lg bg-white/15 px-2.5 py-1.5 text-xs font-semibold text-white backdrop-blur-sm transition-colors hover:bg-white/25"
                  title="Ask every provider for this server again"
                >
                  <RotateCcw className="size-3.5" />
                  Try again
                </button>
              )}
            </div>
          </div>
        )}

        {/* The hand-off gap: the race is over, a stream is attached, and the
            element has not painted a frame yet. Clicks pass straight through, so
            the viewer can still press play while the first segment downloads. */}
        {streamWarming && (
          <div className="pointer-events-none absolute inset-0 z-[62] flex flex-col items-center justify-center gap-2.5">
            <LoadingOrbit className="text-[4.25rem] sm:text-[5.25rem]" />
            <p className="rounded-full bg-black/55 px-3 py-1 text-xs text-white/80 backdrop-blur-sm">
              {`Loading the first frame from ${providerName}…`}
            </p>
          </div>
        )}

        {/* The ad belongs to the wait, not to the movie: it is painted over our
            own loading cover and keeps the box for the creative's whole length,
            handing the film back when it ends or when the viewer skips it. */}
        {adUp && vast && <PreRollAd ad={vast} onDone={() => setAdUp(false)} />}

        {/* Same beat on a chip that can only show the provider's own page: its
            first paint is silent to us, so our mark opens the box for a few
            seconds and then fades out — click-through the whole time, so the
            provider's play button is pressable under it. */}
        {providerMode && (
          <div
            key={providerUrl}
            className="ff-warm pointer-events-none absolute inset-0 z-[62] flex flex-col items-center justify-center gap-2.5"
          >
            <LoadingOrbit className="text-[4.25rem] sm:text-[5.25rem]" />
            <p className="rounded-full bg-black/55 px-3 py-1 text-xs text-white/80 backdrop-blur-sm">
              {`Waiting for ${providerName}…`}
            </p>
          </div>
        )}

        {/* An iframe-only server (VidBox, Videasy) keeps the whole stage for its
            own player, with our native bar over its bottom edge — see the
            `providerMode` blocks below. */}
        {usingAutoembed && iframeServerUrl && providerFramed && (
          <div className="absolute inset-0 z-[60] bg-black">
            <iframe
              key={iframeServerUrl}
              src={iframeServerUrl}
              title={`${title} — ${providerName}`}
              className="absolute inset-0 size-full border-0"
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write"
              allowFullScreen
              referrerPolicy="origin"
            />
          </div>
        )}

        {/* Embed servers that ended up framing their own player: only reached once
            the race failed or the viewer asked for it, so our stage was up first. */}
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
                one case where a framed provider page reads as a broken site. It
                is said from the top band, the one edge our bar leaves free. */}
          </div>
        )}

        {/* Nothing of ours goes along the TOP edge any more: a provider paints its
            own title there, and two labels on one line read as a broken page. All
            of our chrome — including the status line and the link that opens the
            provider in its own tab — lives in the one bottom bar, the same bar
            every other server uses. */}

        {/* Every embed server on this title answered with an error page: say so
            plainly rather than framing the provider's stack trace as a player. */}
        {embedDead && (
          <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black px-4">
            <div className="w-full max-w-sm rounded-2xl border border-border/60 bg-card/95 p-5 text-center">
              <p className="font-display text-base font-semibold">
                No working server for this title
              </p>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {embedError ||
                  "Every provider we tried has no player for this id right now."}{" "}
                Pick another server, or open it in its own tab.
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

        {/* Controls — float up from the bottom edge on hover/tap. Over a framed
            provider this same bar is the bar, painted on top of its page at a
            higher z, and it stays up because a cross-origin frame gives no
            pointer signal back to us to auto-hide on. Its backing goes solid
            there: the provider's own play, seek and volume sit along the bottom
            of its page, and a wash they showed through read as two players. */}
        <div
          onMouseEnter={() => setHoveringControls(true)}
          onMouseLeave={() => setHoveringControls(false)}
          className={`absolute inset-x-0 bottom-0 px-2 pb-2.5 pt-10 transition-all duration-300 ease-out max-sm:pt-6 sm:px-4 ${
            providerMode
              ? "z-[61] bg-gradient-to-t from-black via-black/95 to-black/75"
              : "z-20 bg-gradient-to-t from-black/95 via-black/70 to-transparent"
          } ${
            providerMode || controlsVisible || !playing
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-3 opacity-0"
          }`}
        >
          {/* Progress / seek bar — click to jump, drag to scrub. Over a framed
              provider it is the same line at the same height, only dimmed: this
              site cannot seek a page it cannot read. */}
          <div
            ref={scrubRef}
            data-player-scrubber
            className={`group/scrub mb-2 flex h-6 touch-none items-center transition-opacity ${
              providerMode ? "opacity-45" : "cursor-pointer"
            }`}
            onPointerDown={(e) => {
              if (providerMode || duration <= 0) return;
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

          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 sm:gap-x-2.5">
            {providerMode ? (
              /* The clock's slot names the host running the film instead — same
                 footprint, and it still opens the resolver log the way the top
                 band used to. */
              <button
                type="button"
                onClick={() => setEmbedPanelOpen(true)}
                className={`max-w-[42%] shrink-0 truncate rounded-lg px-1 py-0.5 text-left text-[11px] font-medium tabular-nums text-white/80 transition-colors hover:bg-white/10 ${
                  embedStatus === "failed" && !embedCarried ? "text-amber-200" : ""
                }`}
                title={providerSlotTitle}
              >
                {providerSlot}
              </button>
            ) : (
              <span className="w-10 shrink-0 text-[11px] font-medium tabular-nums text-white/80">
                {formatTime(currentTime)}
              </span>
            )}
            {framedEpisodeStepper && (
              <EpisodeStepper episode={aeEpisode} onChange={setAeEpisode} />
            )}
            <button
              type="button"
              onClick={() => controls.togglePlay()}
              className={`rounded-lg p-2 text-white transition-colors hover:bg-white/15 ${INERT}`}
              aria-label={playing ? "Pause" : "Play"}
              disabled={providerMode}
              title={providerMode ? inertTitle : undefined}
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
              className={`rounded-lg p-2 text-white transition-colors hover:bg-white/15 ${INERT}`}
              aria-label="Back 10 seconds"
              disabled={providerMode}
              title={providerMode ? inertTitle : undefined}
            >
              <RotateCcw className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => seekBy(10)}
              className={`rounded-lg p-2 text-white transition-colors hover:bg-white/15 ${INERT}`}
              aria-label="Forward 10 seconds"
              disabled={providerMode}
              title={providerMode ? inertTitle : undefined}
            >
              <RotateCw className="size-4" />
            </button>

            {/* Volume: hover-expand on desktop, plain mute toggle on touch. */}
            <div className={`group/vol flex items-center max-sm:hidden ${providerMode ? "w-9" : ""}`}>
              <button
                type="button"
                onClick={() => controls.toggleMute()}
                className={`rounded-lg p-2 text-white transition-colors hover:bg-white/15 ${INERT}`}
                aria-label={muted ? "Unmute" : "Mute"}
                disabled={providerMode}
                title={providerMode ? inertTitle : undefined}
              >
                {muted || volume === 0 ? (
                  <VolumeX className="size-5" />
                ) : volume < 0.5 ? (
                  <Volume1 className="size-5" />
                ) : (
                  <Volume2 className="size-5" />
                )}
              </button>
              {/* A slider that opened over a provider's page would drag our own
                  hidden element's volume — a control that only looks alive. */}
              {!providerMode && (
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
              )}
            </div>
            {/* Touch devices have no hover — show the mute toggle here instead. */}
            <button
              type="button"
              onClick={() => controls.toggleMute()}
              className={`rounded-lg p-2 text-white transition-colors hover:bg-white/15 sm:hidden ${INERT}`}
              aria-label={muted ? "Unmute" : "Mute"}
              disabled={providerMode}
              title={providerMode ? inertTitle : undefined}
            >
              {muted || volume === 0 ? (
                <VolumeX className="size-5" />
              ) : volume < 0.5 ? (
                <Volume1 className="size-5" />
              ) : (
                <Volume2 className="size-5" />
              )}
            </button>

            <span
              className={`shrink-0 text-[11px] font-medium tabular-nums text-white/80 ${
                providerMode ? "hidden" : "w-10"
              }`}
            >
              {formatTime(duration)}
            </span>

            {/* Twelve controls never fit across a phone — the row used to walk off
                the right edge and take the gear, PiP and fullscreen with it. This
                spacer gives the provider cluster its own line until there is room
                for one row (a landscape phone is still narrower than a laptop). */}
            <span aria-hidden className="hidden basis-full shrink-0 max-[820px]:block" />

            {/* Which language the film is heard in, beside the server that
                carries it: a viewer picks a source and its voice together, and
                the pick is still there in fullscreen, where the row under the
                box is not. Over a framed provider the chip holds its place in
                the row but cannot be picked — the audio belongs to that page. */}
            {providerMode ? (
              <div className="relative shrink-0" data-player-menu>
                <button
                  type="button"
                  disabled
                  className={`flex items-center gap-1.5 rounded-lg px-2 py-2 text-white transition-colors hover:bg-white/15 ${INERT}`}
                  aria-label="Audio language"
                  title={inertTitle}
                >
                  <Languages className="size-5 shrink-0" />
                  <span className="hidden whitespace-nowrap text-xs font-semibold min-[380px]:inline">
                    Language
                  </span>
                </button>
              </div>
            ) : servers.length > 1 || dubs.length > 0 || audioTracks.length > 0 ? (
              <LanguageMenu
                tracks={audioTracks}
                activeTrack={activeAudioTrack}
                onSelectTrack={setAudioTrack}
                dubs={dubs}
                activeDub={activeDub}
                onSelectDub={setDub}
                serverAudio={serverAudio}
                serverKeys={servers.map((s) => s.key)}
                serverName={serverName}
                currentServer={server}
                probe={audioProbe}
                onHandOff={handOffLanguage}
                open={langOpen}
                setOpen={setLangOpen}
              />
            ) : null}

            {/* Playback server — switch between this site's file and the embed
                servers. Shown whenever more than one server is available. */}
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

            {/* How sharp to watch it — right where the server was picked, since
                a resolution belongs to the source that carries it. The ladder
                comes from the playlist itself, so a provider title with 480p /
                720p / 1080p renditions gets the choice without our catalog
                knowing anything. A stream that ships one variant shows nothing:
                there is nothing to pick, and a dead control on a phone bar is
                worse than no control. */}
            {providerMode ? (
              levels.length > 1 || qualities.length > 0 ? (
                <div className="relative shrink-0" data-player-menu>
                  <button
                    type="button"
                    disabled
                    className={`flex items-center gap-1.5 rounded-lg px-2 py-2 text-white transition-colors hover:bg-white/15 ${INERT}`}
                    aria-label="Resolution"
                    title={inertTitle}
                  >
                    <MonitorPlay className="size-5 shrink-0" />
                    <span className="hidden whitespace-nowrap text-xs font-semibold min-[380px]:inline">
                      Quality
                    </span>
                  </button>
                </div>
              ) : null
            ) : (
              <QualityMenu
                levels={levels}
                activeLevel={activeLevel}
                onSelectLevel={setLevel}
                qualities={qualities}
                activeQuality={activeQuality}
                onSelectQuality={setQuality}
                open={qualityOpen}
                setOpen={setQualityOpen}
              />
            )}

            {/* The one thing on this row that always reaches a framed page: the
                provider's own tab, where its play, seek and volume do work.
                Below `sm` it steps out — Share › Open provider page under the
                box says the same thing, and the extra chip is what pushed our
                phone bar onto a third row over a 275 px picture. */}
            {providerMode && (
              <a
                href={providerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden shrink-0 rounded-lg p-2 text-white transition-colors hover:bg-white/15 sm:flex"
                aria-label="Open the provider directly"
                title={`${providerName}'s own page — its controls work there`}
              >
                <ExternalLink className="size-5" />
              </a>
            )}

            {/* Settings gear: night mode, loop, rotate, captions, speed, quality.
                Every one of those acts on our own media element, so over a framed
                provider it is switched off like the rest of them — the wrapper
                stays, it holds the row's right edge up. */}
            <div className="relative ml-auto shrink-0" data-player-menu>
              <button
                type="button"
                onClick={() => {
                  setSettingsOpen((v) => !v);
                  setSettingsView("main");
                  setLangOpen(false);
                  setQualityOpen(false);
                }}
                className={`rounded-lg p-2 text-white transition-colors hover:bg-white/15 ${INERT} ${
                  settingsOpen || nightMode || loop || rotation !== 0 || playbackRate !== 1 || activeQuality || activeSubtitle
                    ? "text-primary"
                    : ""
                }`}
                aria-label="Player settings"
                disabled={providerMode}
                title={providerMode ? inertTitle : "Settings"}
              >
                <Settings className="size-5" />
              </button>

              {!providerMode && settingsOpen && (
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
              className={`rounded-lg p-2 text-white transition-colors hover:bg-white/15 ${INERT}`}
              aria-label="Picture-in-picture"
              title={providerMode ? inertTitle : "Picture-in-picture"}
              disabled={providerMode}
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
      {/* The box plays; everything the viewer does *with* the title —
          tell a friend about it, keep a file, save it for later — lives under
          it, in the page's own design. The bar never has to squeeze them in. */}
      {!fullscreen && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={shareMovie} className={CHIP} aria-label="Share this movie">
            <Share2 className="size-4 shrink-0" />
            Share
          </button>
          <DownloadMenu
            tone="chip"
            files={downloadFiles}
            streamUrl={streamProbeUrl}
            referer={providerUrl}
            iframeUrl={iframeServerUrl || embedSource}
            ids={{
              tmdbId,
              imdbId,
              kind,
              season,
              episode: usingAutoembed || animeServer ? aeEpisode : (episode ?? aeEpisode),
            }}
            title={title}
            open={downloadOpen}
            setOpen={setDownloadOpen}
            align="left"
            drop="down"
          />
          {onToggleSave && (
            <button
              type="button"
              onClick={onToggleSave}
              className={CHIP}
              aria-pressed={saved}
              title={saved ? "Remove from your list" : "Save this title for later"}
            >
              <Bookmark className={`size-4 shrink-0 ${saved ? "fill-primary text-primary" : ""}`} />
              {saved ? "Saved" : "Save"}
            </button>
          )}
          <ShareMenu providerUrl={providerUrl} />
        </div>
      )}
    </div>
  );
}

/* ------------------------- Server switcher ------------------------- */

/** Episode stepper for the providers keyed per episode (`tv/{id}/{season}/{ep}`).
 *  Shared by the full-cover iframe strip and the embed server's top strip. */
function EpisodeStepper({
  episode,
  onChange,
}: {
  episode: number;
  onChange: (episode: number) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-black/55 text-white backdrop-blur-sm">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, episode - 1))}
        className="rounded-lg p-1.5 transition-colors hover:bg-white/15"
        aria-label="Previous episode"
      >
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-[64px] text-center text-xs font-semibold tabular-nums">
        Ep {episode}
      </span>
      <button
        type="button"
        onClick={() => onChange(episode + 1)}
        className="rounded-lg p-1.5 transition-colors hover:bg-white/15"
        aria-label="Next episode"
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

/** The player's loading mark: embers orbiting a centre, collapsing through it
 *  and streaming back out. Everything is sized in `em`, so the caller picks the
 *  whole size with one font-size class. */
const ORBIT_DOTS = [
  { d: 0.15, r: 0.4 },
  { d: 0.07, r: 0.3 },
  { d: 0.12, r: 0.44 },
  { d: 0.06, r: 0.26 },
  { d: 0.16, r: 0.36 },
  { d: 0.09, r: 0.46 },
  { d: 0.11, r: 0.28 },
  { d: 0.06, r: 0.42 },
  { d: 0.14, r: 0.33 },
  { d: 0.08, r: 0.45 },
  { d: 0.1, r: 0.3 },
];
/* Tone follows size: the near, big embers catch the light, the small far ones
   sink into shadow — depth in one red instead of three colours. */
const orbitTone = (d: number) =>
  d >= 0.14
    ? "var(--ff-orbit-bright)"
    : d >= 0.09
      ? "var(--ff-orbit-red)"
      : "var(--ff-orbit-deep)";

function LoadingOrbit({
  className = "",
  paused = false,
}: {
  className?: string;
  /** Freeze the orbit where it stands — the stage is waiting for a tap, not
   *  for a server that already answered. */
  paused?: boolean;
}) {
  return (
    <span aria-hidden className={`ff-orbit ${paused ? "ff-orbit--paused" : ""} ${className}`}>
      {ORBIT_DOTS.map((dot, i) => (
        <span
          key={i}
          className="ff-orbit__spoke"
          style={{ transform: `rotate(${(i / ORBIT_DOTS.length) * 360}deg)` }}
        >
          <span
            className="ff-orbit__dot"
            style={
              {
                "--ff-dot": `${dot.d}em`,
                "--ff-r": `${dot.r}em`,
                "--ff-c": orbitTone(dot.d),
                animationDelay: `${(-i / ORBIT_DOTS.length) * 1.4}s`,
              } as CSSProperties
            }
          />
        </span>
      ))}
    </span>
  );
}

/** Dropdown that picks the playback server (this site's file vs a provider).
 *  Shared by the native control bar, our bar over a framed provider, and the
 *  awaiting-player cover. */
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
    <div className="relative shrink-0" data-player-menu>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-2 text-white transition-colors hover:bg-white/15"
        aria-label="Playback server"
        aria-expanded={open}
        title="Server"
      >
        <Server className="size-5 shrink-0" />
        <span className="hidden whitespace-nowrap text-xs font-semibold min-[380px]:inline">
          {active?.label ?? "Server"}
        </span>
      </button>
      {open && (
        <div
          className={`absolute z-30 min-w-[220px] max-w-[86vw] overflow-hidden rounded-xl border border-white/15 bg-black/95 py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.95)] backdrop-blur ${
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
  /* A piped stream's own name ends in the pipe's path, so ask what it proxies. */
  const ext =
    /\.(m3u8|mp4|mkv|webm|mov|m4v)(\?|#|$)/i
      .exec(pipedTarget(url) || url)
      ?.[1]?.toLowerCase() ?? "mp4";
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
  tone = "bar",
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
  /** "bar" floats over the film in white; "chip" wears the page's own colors. */
  tone?: "bar" | "chip";
}) {
  const [qualities, setQualities] = useState<{ label: string; url: string }[]>([]);
  /** What the Worker read in the live stream's own master playlist. Its
   *  rendition links often have no `.m3u8` in them, so this is the honest way
   *  to know the rows below are streams rather than files. */
  const [streamKind, setStreamKind] = useState<"hls" | "direct" | "">("");
  /** Content verdicts for rows neither the file name nor the probe settled. */
  const [playlists, setPlaylists] = useState<Record<string, boolean>>({});
  const [providers, setProviders] = useState<TitleDownloadProvider[]>([]);
  const [probeStatus, setProbeStatus] = useState<"idle" | "loading" | "done">("idle");
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [savedNote, setSavedNote] = useState<Record<string, string>>({});
  /** Why a row failed, kept for the retry button's tooltip — the reason the
   *  owner needs when a download dies, and nothing the film itself should wear. */
  const [why, setWhy] = useState<Record<string, string>>({});
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
            .then((r) => {
              setStreamKind(r.kind === "hls" || r.kind === "direct" ? r.kind : "");
              return r.entries ?? [];
            })
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

  /* Whichever Referer this CDN's host answered our player with beats the page
     the viewer happens to be standing on: a sweep row from another server is
     gated by that server's host, not by this one's. */
  const refFor = (url: string) => refererFor(pipedTarget(url) || url) || referer || "";

  /** Rows the file name cannot settle are settled by their first bytes. */
  const fromMaster = new Set(streamKind === "hls" ? qualities.map((q) => q.url) : []);
  const isStream = (url: string) => isHlsLink(url) || playlists[url] === true || fromMaster.has(url);

  /* Nothing may be offered as a plain file until we know it is one — a manifest
     saved under an .mp4 name is exactly the download that never played. */
  useEffect(() => {
    if (!open) return;
    const candidates = [...listed, ...detected.map((s) => s.url)].filter(
      (u) => u && !isHlsLink(u) && playlists[u] === undefined && !fromMaster.has(u),
    );
    for (const u of candidates) {
      void hlsByContent(u, refFor(u)).then((hls) =>
        setPlaylists((p) => (p[u] === hls ? p : { ...p, [u]: hls })),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, probeKey, attempt, providers, qualities, detected.length, streamKind, referer]);

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
          ?.writeText(proxyUrl(url, refFor(url) || undefined, downloadName(title, label, url)))
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
        href={proxyUrl(url, refFor(url) || undefined, downloadName(title, label, url))}
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
    if (!isStream(url)) return row(label, sub, url);
    const pct = progress[url];
    const busy = pct !== undefined && pct >= 0 && pct < 1;
    const start = () => {
      setProgress((p) => ({ ...p, [url]: 0 }));
      downloadHls(url, (f) => setProgress((p) => ({ ...p, [url]: f })), { referer: refFor(url) })
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
        .catch((err: unknown) => {
          setWhy((w) => ({ ...w, [url]: String(err?.toString?.() ?? err).slice(0, 120) }));
          setProgress((p) => ({ ...p, [url]: -1 }));
        });
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
            title={why[url] || undefined}
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
    <div className="relative shrink-0" data-player-menu>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={
          tone === "chip"
            ? CHIP
            : "flex items-center gap-1.5 rounded-lg px-2 py-2 text-white transition-colors hover:bg-white/15"
        }
        aria-label="Download"
        title="Download"
      >
        <Download className={tone === "chip" ? "size-4 shrink-0" : "size-5 shrink-0"} />
        {tone === "chip" ? (
          "Download"
        ) : (
          <span className="hidden whitespace-nowrap text-xs font-semibold min-[380px]:inline">
            Download
          </span>
        )}
      </button>
      {open && (
        <div
          className={`absolute z-30 min-w-[220px] max-w-[86vw] max-h-[60vh] overflow-y-auto rounded-xl border border-white/15 bg-black/95 py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.95)] backdrop-blur ${
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

/* ------------------- Language control (beside the server pick) ------------------- */

/** How many languages this film can be heard in *on any server on offer*, and
 *  the pick that changes it. Three sources feed one list: the audio renditions
 *  the playing stream declares (`EXT-X-MEDIA:TYPE=AUDIO`), the same lines read
 *  off every other server's playlist when the menu is opened, and the dub files
 *  an admin attached to the catalog row. A language this server carries switches
 *  in place — position, mute and volume survive it. A language only another
 *  server carries hands playback over there and lands on it once that stream
 *  parses. Nothing here is guesswork: a server that answers no audio lines
 *  simply contributes no rows. */
function LanguageMenu({
  tracks,
  activeTrack,
  onSelectTrack,
  dubs,
  activeDub,
  onSelectDub,
  serverAudio,
  serverKeys,
  serverName,
  currentServer,
  probe,
  onHandOff,
  open,
  setOpen,
}: {
  tracks: PlayerAudioTrack[];
  activeTrack: number | null;
  onSelectTrack: (id: number) => void;
  dubs: PlayerDub[];
  activeDub: string | null;
  onSelectDub: (label: string | null) => void;
  serverAudio: Record<string, ServerAudio[]>;
  serverKeys: string[];
  serverName: (key: string) => string;
  currentServer: string;
  probe: "idle" | "loading" | "done";
  onHandOff: (intent: {
    key: string;
    label: string;
    server: string;
    dubLabel?: string | null;
  }) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  /* Nothing picked yet = whatever the playlist marks DEFAULT, because that is
     the rendition actually playing. */
  const currentTrack =
    tracks.find((t) => t.id === activeTrack) ??
    tracks.find((t) => t.isDefault) ??
    tracks[0];
  const playingKey =
    currentServer === "original" && dubs.length > 0
      ? audioKeyOf({ name: activeDub ?? "Original" })
      : currentTrack
        ? audioKeyOf({ name: currentTrack.name, lang: currentTrack.lang })
        : "";

  /** One server's claim on a language: a rendition of its own stream, one of
   *  the catalog's dub files, or an audio line its playlist offered. */
  type Entry = {
    server: string;
    kind: "track" | "dub" | "audio";
    label: string;
    id?: number;
  };
  const rows: { key: string; label: string; entries: Entry[] }[] = [];
  const rowAt = new Map<string, number>();
  const add = (key: string, label: string, entry: Entry) => {
    if (!key || key === "unknown" || !label.trim()) return;
    const at = rowAt.get(key);
    if (at === undefined) {
      rowAt.set(key, rows.length);
      rows.push({ key, label, entries: [entry] });
      return;
    }
    const row = rows[at];
    if (!row.entries.some((e) => e.server === entry.server)) row.entries.push(entry);
  };

  tracks.forEach((t) =>
    add(audioKeyOf({ name: t.name, lang: t.lang }), t.name, {
      server: currentServer,
      kind: "track",
      label: t.name,
      id: t.id,
    }),
  );
  if (dubs.length > 0)
    add(audioKeyOf({ name: "Original" }), "Original", {
      server: "original",
      kind: "dub",
      label: "Original",
    });
  dubs.forEach((d) =>
    add(audioKeyOf({ name: d.label }), d.label, {
      server: "original",
      kind: "dub",
      label: d.label,
    }),
  );
  serverKeys.forEach((key) =>
    (serverAudio[key] ?? []).forEach((a) =>
      add(audioKeyOf({ name: a.name, lang: a.lang }), a.name, {
        server: key,
        kind: "audio",
        label: a.name,
      }),
    ),
  );

  const options = rows.map((row) => {
    /* Prefer acting on the server already playing: a rendition of its stream
       (in place), a dub file it holds, then a language its playlist promised.
       Only a server we are not on makes this a hand-off. */
    const local =
      row.entries.find((e) => e.kind === "track" && e.server === currentServer) ??
      row.entries.find((e) => e.kind === "dub" && e.server === currentServer) ??
      row.entries.find((e) => e.server === currentServer);
    const target = local ?? row.entries[0];
    const on = row.key === playingKey;
    const elseWhere = row.entries
      .filter((e) => e.server !== currentServer)
      .map((e) => serverName(e.server).replace(/\D+/g, ""))
      .filter(Boolean);
    const hint = on
      ? "✓"
      : elseWhere.length === 0
        ? "Here"
        : elseWhere.length === 1
          ? `Server ${elseWhere[0]}`
          : `Servers ${elseWhere.join(" · ")}`;
    const choose = () => {
      if (on) return;
      if (target.kind === "track" && target.id !== undefined) {
        onSelectTrack(target.id);
        return;
      }
      if (target.kind === "dub" && currentServer === "original") {
        onSelectDub(target.label === "Original" ? null : target.label);
        return;
      }
      onHandOff({
        key: row.key,
        label: row.label,
        server: target.server,
        dubLabel:
          target.kind === "dub"
            ? target.label === "Original"
              ? null
              : target.label
            : undefined,
      });
    };
    return { key: row.key, label: row.label, on, hint, choose };
  });

  const count = options.length;
  const plural = count === 1 ? "language" : "languages";
  const playing = options.find((o) => o.on)?.label ?? options[0]?.label ?? "";

  return (
    <div className="relative shrink-0" data-player-menu>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 rounded-lg px-2 py-2 transition-colors hover:bg-white/15 ${
          open ? "text-primary" : "text-white"
        }`}
        aria-label={
          playing
            ? `Audio language: ${playing}. This title is in ${count} ${plural} across its servers`
            : "Audio language"
        }
        aria-expanded={open}
        title={
          playing
            ? `Playing in ${playing} — tap to hear it in another of its ${count} ${plural}`
            : "Audio language"
        }
      >
        <Languages className="size-5 shrink-0" />
        <span className="hidden whitespace-nowrap text-xs font-semibold min-[380px]:inline">
          {playing ? `${playing} · ${count}` : "Language"}
        </span>
      </button>
      {open && (
        /* Opens to the RIGHT of its own left edge: on a phone this button is the
           first of the cluster, so a right-anchored menu walked off the screen. */
        <div className="absolute bottom-full left-0 z-30 mb-2 max-h-[46vh] min-w-[210px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-white/15 bg-black/95 py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.95)] backdrop-blur">
          <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/50">
            {count > 0 ? `Audio language · ${count} ${plural}` : "Audio language"}
          </p>
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => {
                o.choose();
                if (o.on) setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 ${
                o.on ? "bg-primary/25 font-semibold text-primary" : ""
              }`}
            >
              {o.label}
              <span
                className={`shrink-0 text-[10px] ${o.on ? "text-primary" : "text-white/45"}`}
              >
                {o.hint}
              </span>
            </button>
          ))}
          {probe !== "done" && (
            <p className="px-3 py-2 text-[11px] text-white/50">
              Checking every server…
            </p>
          )}
          {probe === "done" && count === 0 && (
            <p className="px-3 py-2 text-[11px] text-white/50">
              None of these servers says which language it carries.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------- Resolution control (beside the server pick) ------------------- */

/** What the film is watched at, and what else it could be. Two sources feed one
 *  list: the renditions the playing playlist declares — hls.js can pin any of
 *  them in place, so the second, the mute and the volume all survive the pick —
 *  and the separate quality files an admin attached to the catalog row, which
 *  are different URLs and so change the source. A stream that ships one variant
 *  has nothing to offer, and the chip stays out of the bar. */
function QualityMenu({
  levels,
  activeLevel,
  onSelectLevel,
  qualities,
  activeQuality,
  onSelectQuality,
  open,
  setOpen,
}: {
  levels: PlayerLevel[];
  activeLevel: number | null;
  onSelectLevel: (id: number) => void;
  qualities: { label: string; videoUrl: string }[];
  activeQuality: string | null;
  onSelectQuality: (label: string | null) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  /* Tallest first, which is how every other player lists them. */
  const ladder = [...levels].sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
  const labelOf = (l: PlayerLevel) =>
    l.height ? `${l.height}p` : `${Math.max(1, Math.round(l.bitrate / 1_000_000))} Mbps`;
  /** What Auto is serving this second, so the row can say what it is worth. */
  const serving = ladder.find((l) => l.playing);
  const pinned = activeLevel === null ? undefined : ladder.find((l) => l.id === activeLevel);
  const autoOn = activeQuality === null && activeLevel === null;

  type Row = { key: string; label: string; hint: string; on: boolean; choose: () => void };
  const rows: Row[] = [];
  if (ladder.length > 0 || qualities.length > 0)
    rows.push({
      key: "auto",
      label: "Auto",
      hint: serving ? `now ${labelOf(serving)}` : "",
      on: autoOn,
      choose: () => {
        onSelectQuality(null);
        onSelectLevel(-1);
      },
    });
  ladder.forEach((l) =>
    rows.push({
      key: `level-${l.id}`,
      label: labelOf(l),
      hint: l.bitrate && l.height ? `${(l.bitrate / 1_000_000).toFixed(1)} Mb/s` : "",
      on: activeQuality === null && activeLevel === l.id,
      choose: () => {
        /* A pinned file and a pinned rendition cannot both be true: the level
           belongs to whichever stream is playing now. */
        onSelectQuality(null);
        onSelectLevel(l.id);
      },
    }),
  );
  qualities.forEach((q) =>
    rows.push({
      key: `file-${q.label}`,
      label: q.label,
      hint: "File",
      on: activeQuality === q.label,
      choose: () => onSelectQuality(q.label),
    }),
  );

  /* One rendition and no extra file = the only choice is the one already made. */
  if (ladder.length < 2 && qualities.length === 0) return null;

  const current =
    activeQuality ?? (pinned ? labelOf(pinned) : serving ? `Auto · ${labelOf(serving)}` : "Auto");

  /* This chip sits mid-row, so a menu that simply opens rightward walked off
     the phone screen. Measured at the moment it opens: the panel may use every
     pixel between this button's left edge and the viewport, and never more. */
  const btnRef = useRef<HTMLButtonElement>(null);
  const [maxW, setMaxW] = useState(0);

  return (
    <div className="relative shrink-0" data-player-menu>
      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          if (!open) {
            const r = btnRef.current?.getBoundingClientRect();
            setMaxW(r ? Math.max(150, window.innerWidth - r.left - 12) : 0);
          }
          setOpen(!open);
        }}
        className={`flex items-center gap-1.5 rounded-lg px-2 py-2 transition-colors hover:bg-white/15 ${
          open || !autoOn ? "text-primary" : "text-white"
        }`}
        aria-label={`Resolution: ${current}`}
        aria-expanded={open}
        title={`Watch at another resolution — now ${current}`}
      >
        <MonitorPlay className="size-5 shrink-0" />
        <span className="hidden whitespace-nowrap text-xs font-semibold min-[380px]:inline">
          {current}
        </span>
      </button>
      {open && (
        /* Opens rightward from its own left edge, like the language menu: on a
           phone this chip sits mid-row and a right-anchored panel walked off
           the screen. */
        /* min-width beats max-width in CSS, so both are set inline here. */
        <div
          style={maxW ? { minWidth: Math.min(190, maxW), maxWidth: maxW } : undefined}
          className="absolute bottom-full left-0 z-30 mb-2 max-h-[46vh] min-w-[190px] overflow-y-auto rounded-xl border border-white/15 bg-black/95 py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.95)] backdrop-blur"
        >
          <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/50">
            Resolution
          </p>
          {rows.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => {
                r.choose();
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 ${
                r.on ? "bg-primary/25 font-semibold text-primary" : ""
              }`}
            >
              {r.label}
              <span
                className={`shrink-0 text-[10px] ${r.on ? "text-primary" : "text-white/45"}`}
              >
                {r.on ? "✓" : r.hint}
              </span>
            </button>
          ))}
          {ladder.length === 0 && qualities.length > 0 && (
            <p className="border-t border-white/10 px-3 py-2 text-[11px] leading-snug text-white/50">
              This stream ships one resolution; the others are separate files.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------- Share menu (under the box) ------------------------- */

/** Copy the link, or open the provider's own page. This is a decision about the
 *  title, not about playback, so it lives under the box where the bar's
 *  auto-hide can never take it away mid-share. */
function ShareMenu({ providerUrl }: { providerUrl?: string }) {
  const [open, setOpen] = useState(false);
  const url = typeof window === "undefined" ? "" : window.location.href;
  const item =
    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-popover-foreground transition-colors hover:bg-muted";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${CHIP} px-3`}
        aria-label="More share options"
        aria-expanded={open}
        title="More"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <>
          {/* A press anywhere else closes it — the row sits outside the stage
              box, so the bar's own click-catcher never sees these clicks. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-full left-0 z-30 mb-2 min-w-[200px] overflow-hidden rounded-xl border border-border/60 bg-popover py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.5)]">
            <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Share
            </p>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  toast.success("Link copied — paste it anywhere to share");
                } catch {
                  toast.error("Could not copy the link");
                }
                setOpen(false);
              }}
              className={item}
            >
              <Link2 className="size-3.5" />
              Copy link
            </button>
            {providerUrl && (
              <>
                <div className="my-1 h-px bg-border/60" />
                <a
                  href={providerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className={item}
                >
                  <ExternalLink className="size-3.5" />
                  Open provider page
                </a>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
