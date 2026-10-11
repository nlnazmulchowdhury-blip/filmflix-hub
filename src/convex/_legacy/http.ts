import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { handleVideoProxy } from "./videoProxy";

const http = httpRouter();

auth.addHttpRoutes(http);

// HTTPS streaming proxy so http:// movie links (e.g. LAN/FTP HTTP dirs)
// play in the browser with Range/seek support. See videoProxy.ts.
http.route({
  path: "/video-proxy",
  method: "GET",
  handler: handleVideoProxy,
});

export default http;
