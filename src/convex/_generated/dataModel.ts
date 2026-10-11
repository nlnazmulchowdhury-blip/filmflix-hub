/**
 * Replaces the Convex generated data model. Components only ever use these
 * types as opaque ids / doc shapes; keep them permissive so the codebase
 * compiles while the backend is D1 now.
 */
export type Id<Table extends string = string> = string & { readonly __table: Table };
export type Doc<Table extends string = string> = { readonly _id: Id<Table>; readonly _creationTime: number } & Record<string, any>;
export type WithoutSystemRange = any;
