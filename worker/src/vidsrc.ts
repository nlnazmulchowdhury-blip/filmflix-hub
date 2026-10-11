import { Hono } from "hono";
import type { Env } from "./index";
import { vidSrcSearch } from "../../src/lib/vidsrc-imdb";

/** Public: resolve a typed title to IMDb suggestions so out-of-catalog
 *  titles can still play via the VidSrc embed (Landing search). */
export const vidsrcRoutes = new Hono<Env>();

vidsrcRoutes.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  try {
    return c.json(await vidSrcSearch(q));
  } catch (err) {
    console.error("vidsrc search failed", err);
    return c.json([]);
  }
});
