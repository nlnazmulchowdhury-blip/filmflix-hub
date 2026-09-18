import { createContext, useContext } from "react";

export interface MiniPlayerMovie {
  movieId: string;
  title: string;
  videoUrl: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
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
