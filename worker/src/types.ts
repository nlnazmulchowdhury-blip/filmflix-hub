export interface Target {
  kind: "movie" | "tv";
  name: string;
  movieId?: string;
  channelId?: string;
}

export interface ProbeResult {
  status: "ok" | "fail";
  httpStatus?: number;
  error?: string;
}
