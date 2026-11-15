// Flight tracker relay for Cloudflare Workers.
// Fetches flight and weather data server-side and lets the tracker page read it.
// Use: https://<your-worker>.workers.dev/?url=<encoded https URL on an allowed host>

const ALLOWED_HOSTS = [
  "api.adsb.lol",
  "globe.adsb.lol",
  "api.airplanes.live",
  "opendata.adsb.fi",
  "opensky-network.org",
  "api.open-meteo.com",
  "api.adsbdb.com",
  "api.planespotters.net",
  "overpass-api.de",
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return new Response("GET only", { status: 405, headers: CORS });

    const target = new URL(request.url).searchParams.get("url");
    let url;
    try { url = new URL(target); } catch {
      return new Response("Relay is running. Add ?url=<https address>.", { status: 400, headers: CORS });
    }
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.includes(url.hostname)) {
      return new Response("Host not allowed: " + url.hostname, { status: 403, headers: CORS });
    }

    let upstream;
    try {
      upstream = await fetch(url.toString(), {
        headers: { "User-Agent": "personal-flight-tracker-relay", "Accept": "application/json" },
        cf: { cacheTtl: 3, cacheEverything: true },
      });
    } catch (e) {
      return new Response("Upstream unreachable: " + e.message, { status: 502, headers: CORS });
    }

    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    headers.delete("set-cookie");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
