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

    movies: defineTable({
      title: v.string(),
      description: v.optional(v.string()),
      posterUrl: v.optional(v.string()),
      backdropUrl: v.optional(v.string()),
      videoUrl: v.optional(v.string()),
      genre: v.optional(v.string()),
      year: v.optional(v.number()),
      rating: v.optional(v.number()),
      kind: v.optional(v.union(v.literal("movie"), v.literal("series"))),
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
    }).index("order", ["order"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
