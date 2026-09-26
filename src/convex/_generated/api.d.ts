/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as analytics from "../analytics.js";
import type * as auth from "../auth.js";
import type * as auth_emailOtp from "../auth/emailOtp.js";
import type * as categories from "../categories.js";
import type * as comments from "../comments.js";
import type * as crons from "../crons.js";
import type * as dubbing from "../dubbing.js";
import type * as http from "../http.js";
import type * as linkHealth from "../linkHealth.js";
import type * as movies from "../movies.js";
import type * as orders from "../orders.js";
import type * as screenings from "../screenings.js";
import type * as shortlinks from "../shortlinks.js";
import type * as storageCleanup from "../storageCleanup.js";
import type * as supabaseStorage from "../supabaseStorage.js";
import type * as support from "../support.js";
import type * as tvCategories from "../tvCategories.js";
import type * as tvChannels from "../tvChannels.js";
import type * as users from "../users.js";
import type * as usersHelpers from "../usersHelpers.js";
import type * as videoProxy from "../videoProxy.js";
import type * as videoUpload from "../videoUpload.js";
import type * as watchlist from "../watchlist.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  analytics: typeof analytics;
  auth: typeof auth;
  "auth/emailOtp": typeof auth_emailOtp;
  categories: typeof categories;
  comments: typeof comments;
  crons: typeof crons;
  dubbing: typeof dubbing;
  http: typeof http;
  linkHealth: typeof linkHealth;
  movies: typeof movies;
  orders: typeof orders;
  screenings: typeof screenings;
  shortlinks: typeof shortlinks;
  storageCleanup: typeof storageCleanup;
  supabaseStorage: typeof supabaseStorage;
  support: typeof support;
  tvCategories: typeof tvCategories;
  tvChannels: typeof tvChannels;
  users: typeof users;
  usersHelpers: typeof usersHelpers;
  videoProxy: typeof videoProxy;
  videoUpload: typeof videoUpload;
  watchlist: typeof watchlist;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
