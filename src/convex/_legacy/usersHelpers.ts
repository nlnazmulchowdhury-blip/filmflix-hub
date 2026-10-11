import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

export async function getFullUser(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db.get(userId);
}
