import { createContext, useContext } from "react";

export interface MiniPlayerVideo {
  movieId: string;
  title: string;
  videoUrl: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
}

export interface MiniPlayerContextValue {
  video: MiniPlayerVideo | null;
  /** Hand a playing video to the floating miniplayer. */
  show: (video: MiniPlayerVideo) => void;
  /** Close the miniplayer (video is discarded). */
  close: () => void;
  /** True while the miniplayer holds a video. */
  isActive: boolean;
}

export const MiniPlayerContext = createContext<MiniPlayerContextValue>({
  video: null,
  show: () => undefined,
  close: () => undefined,
  isActive: false,
});

export function useMiniPlayer() {
  return useContext(MiniPlayerContext);
}
