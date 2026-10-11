/**
 * Replaces the once-generated Convex api module.
 *
 * Every existing `import { api } from "@/convex/_generated/api"` now hands
 * the REST shim a lazy proxy object: `api.movies.list.__key ===
 * "movies.list"`, and the shim maps that key onto the Worker route table.
 * No component import changes needed for the backend switch.
 */
import { makeApiProxy } from "@/lib/rest-client";

export const api = makeApiProxy();

/** The old generated modules also exported `internal` (server refs) — only
 *  Convex server code used it, but some client files import the type. */
export const internal = api;
