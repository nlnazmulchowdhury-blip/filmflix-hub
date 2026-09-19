import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // add other tables here

    /** Named catalog sections (Hollywood, Bengali, Anime, …). Created
     *  directly by admins; movies reference them by name. */
    categories: defineTable({
      name: v.string(),
      createdAt: v.number(),
    }).index("by_name", ["name"]),

    movies: defineTable({
      title: v.string(),
      description: v.optional(v.string()),
      posterUrl: v.optional(v.string()),
      backdropUrl: v.optional(v.string()),
      videoUrl: v.optional(v.string()),
      genre: v.optional(v.string()),
      /** Display category/section, e.g. Hollywood, Bengali, Anime, Trending.
       *  Legacy single value (kept so old rows keep working). */
      category: v.optional(v.string()),
      /** One movie can live in several sections at once. */
      categories: v.optional(v.array(v.string())),
      year: v.optional(v.number()),
      rating: v.optional(v.number()),
      kind: v.optional(v.union(v.literal("movie"), v.literal("series"))),
      /** Ordered list of episodes/extra parts. Played from the playlist under
       *  the player on the movie page. */
      episodes: v.optional(
        v.array(
          v.object({
            title: v.string(),
            videoUrl: v.string(),
            durationSec: v.optional(v.number()),
          }),
        ),
      ),
      /** Alternate language versions (e.g. Hindi Dub, Bengali Dub). Each has
       *  its own video URL; viewers switch between them in the player and
       *  the playback position is kept. */
      dubs: v.optional(
        v.array(
          v.object({
            label: v.string(),
            videoUrl: v.string(),
          }),
        ),
      ),
      seasons: v.optional(
        v.array(
          v.object({
            id: v.id("movies"),
            title: v.string(),
            episodes: v.array(
              v.object({
                id: v.string(),
                title: v.string(),
                videoUrl: v.string(),
                durationSec: v.optional(v.number()),
              }),
            ),
          }),
        ),
      ),
      order: v.optional(v.number()),
      contributorId: v.optional(v.id("users")),
    })
      .index("order", ["order"])
      .index("by_contributor", ["contributorId"]),

    screenings: defineTable({
      movieId: v.id("movies"),
      userId: v.id("users"),
      scheduledFor: v.number(), // epoch ms
      note: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("by_movie", ["movieId"])
      .index("by_user", ["userId"]),

    comments: defineTable({
      movieId: v.id("movies"),
      userId: v.id("users"),
      text: v.string(),
      createdAt: v.number(),
    }).index("by_movie", ["movieId"]),

    orders: defineTable({
      userId: v.id("users"),
      plan: v.string(), // "crew" | "premiere"
      amountCents: v.number(),
      status: v.string(),
      createdAt: v.number(),
    }).index("by_user", ["userId"]),

    /** Cache of resolved short links so we never resolve the same tinyurl /
     *  is.gd link twice. shortUrl -> realUrl. */
    shortlinks: defineTable({
      shortUrl: v.string(),
      realUrl: v.string(),
      resolvedAt: v.number(),
    }).index("by_short", ["shortUrl"]),

    /** AI dubbing jobs (ElevenLabs): track auto-translation of a movie into
     *  Bengali/Hindi etc. Status: queued → dubbing → dubbed | failed. */
    dubJobs: defineTable({
      movieId: v.id("movies"),
      movieTitle: v.string(),
      targetLang: v.string(), // "bn" | "hi" | …
      status: v.string(),
      dubbingId: v.optional(v.string()),
      error: v.optional(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    }).index("by_movie", ["movieId"]),

    /** Web analytics: one row per page view. Written by a lightweight client
     *  tracker on every route change; summarized in the admin panel. */
    pageViews: defineTable({
      path: v.string(),
      movieId: v.optional(v.id("movies")),
      userId: v.optional(v.id("users")),
      referrer: v.optional(v.string()),
      device: v.optional(v.string()), // "mobile" | "tablet" | "desktop"
      country: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("by_created", ["createdAt"])
      .index("by_path", ["path"])
      .index("by_movie", ["movieId"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
