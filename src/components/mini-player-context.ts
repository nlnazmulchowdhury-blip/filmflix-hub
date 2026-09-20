import { createContext, useContext } from "react";

export interface PlayerDub {
  label: string;
  videoUrl: string;
}

/** Extra quality rendition (480p/720p/…) with its own file URL. */
export interface PlayerQuality {
  label: string;
  videoUrl: string;
}

/** Subtitle/caption track backed by a WebVTT file. */
export interface PlayerSubtitle {
  label: string;
  url: string;
}

export interface MiniPlayerMovie {
  movieId: string;
  title: string;
  videoUrl: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  /** Alternate language versions; empty for original-only movies. */
  dubs?: PlayerDub[];
  /** Quality renditions (480p/720p/…); empty = original file only. */
  qualities?: PlayerQuality[];
  /** WebVTT subtitle tracks; empty = no captions available. */
  subtitles?: PlayerSubtitle[];
}

export interface PlayerControls {
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  toggleMute: () => void;
  setVolume: (v: number) => void;
  seekBy: (deltaSec: number) => void;
  seekToRatio: (ratio: number) => void;
}

/** Clockwise rotation of the picture, for videos shot sideways. */
export type PlayerRotation = 0 | 90 | 180 | 270;

export interface MiniPlayerContextValue {
  movie: MiniPlayerMovie | null;
  /** "inline" = video lives on the movie page, "mini" = floating corner player */
  mode: "inline" | "mini";
  isActive: boolean;
  /** True once playback has begun (poster overlay should hide). */
  hasStarted: boolean;
  /** Live playback state for control bars. */
  playing: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  /** Currently playing audio version: null = original, else the dub label. */
  activeDub: string | null;
  /** Switch audio version without losing the playback position. */
  setDub: (label: string | null) => void;
  /** --- Viewer settings (YouTube-style gear menu) --- */
  /** Night mode: dims the picture for dark-room viewing. */
  nightMode: boolean;
  setNightMode: (on: boolean) => void;
  /** Replay from the start when the video ends. */
  loop: boolean;
  setLoop: (on: boolean) => void;
  /** Rotate the picture 90° clockwise steps (0/90/180/270). */
  rotation: PlayerRotation;
  setRotation: (r: PlayerRotation) => void;
  /** Playback speed multiplier (0.25 – 2). */
  playbackRate: number;
  setPlaybackRate: (r: number) => void;
  /** Active quality rendition: null = original (auto) file. */
  activeQuality: string | null;
  /** Switch quality file without losing the playback position. */
  setQuality: (label: string | null) => void;
  /** Active subtitle track: null = captions off. */
  activeSubtitle: string | null;
  setSubtitle: (label: string | null) => void;
  /** Register the inline stage slot; the persistent video is portaled here. */
  registerStage: (el: HTMLElement | null) => void;
  /** Begin a movie (optionally autoplaying) on the inline stage. */
  start: (movie: MiniPlayerMovie, autoplay?: boolean) => void;
  /** Move the playing video between the inline stage and the floating card. */
  setMode: (mode: "inline" | "mini") => void;
  /** Stop playback and clear the player. */
  close: () => void;
  controls: PlayerControls;
}

export const MiniPlayerContext = createContext<MiniPlayerContextValue>({
  movie: null,
  mode: "inline",
  isActive: false,
  hasStarted: false,
  playing: false,
  muted: false,
  volume: 1,
  currentTime: 0,
  duration: 0,
  activeDub: null,
  setDub: () => undefined,
  nightMode: false,
  setNightMode: () => undefined,
  loop: false,
  setLoop: () => undefined,
  rotation: 0,
  setRotation: () => undefined,
  playbackRate: 1,
  setPlaybackRate: () => undefined,
  activeQuality: null,
  setQuality: () => undefined,
  activeSubtitle: null,
  setSubtitle: () => undefined,
  registerStage: () => undefined,
  start: () => undefined,
  setMode: () => undefined,
  close: () => undefined,
  controls: {
    play: () => undefined,
    pause: () => undefined,
    togglePlay: () => undefined,
    toggleMute: () => undefined,
    setVolume: () => undefined,
    seekBy: () => undefined,
    seekToRatio: () => undefined,
  },
});

export function useMiniPlayer() {
  return useContext(MiniPlayerContext);
}
