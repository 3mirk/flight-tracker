// Flight tracker relay for Cloudflare Workers.
//
//   GET  /?url=<encoded https URL>       relay to an allowed data service (backup route for the page)
//   GET  /api/schedule?f=AA3101           scheduled/recent flights for a flight number (AeroDataBox, then AirLabs)
//   GET  /api/aircraft?reg=N921US         aircraft details and today's flights (AeroDataBox, then AirLabs)
//   GET  /api/flights?code=AA3101         list of saved flights for a number (all numbers if code is empty)
//   GET  /api/flight?id=...               one saved flight
//   POST /api/flight                      save or update a flight recorded by the page (max 500 kept)
//
// Needs (set in the Cloudflare dashboard, never in this file):
//   DATA          KV namespace binding (see wrangler.toml)
//   ADB_KEY       AeroDataBox key from RapidAPI            (secret, optional)
//   AIRLABS_KEY   AirLabs API key                          (secret, optional)
// Paid lookups are cached in KV and capped per day, so free tiers are not exceeded.

const ALLOWED_HOSTS = [
  "api.adsb.lol",
  "globe.adsb.lol",
  "api.airplanes.live",
  "opendata.adsb.fi",
  "opensky-network.org",
  "api.open-meteo.com",
  "api.rainviewer.com",
  "aviationweather.gov",
  "api.adsbdb.com",
  "api.planespotters.net",
  "overpass-api.de",
  "overpass.kumi.systems",
  "overpass.private.coffee",
];

// Only the tracker page may use this relay from a browser.
const ALLOWED_ORIGINS = ["https://3mirk.github.io"];

const LIMITS = {
  adbPerDay: 40,        // AeroDataBox calls per day, all users together
  airlabsPerDay: 40,    // AirLabs calls per day, all users together
  perUserPer10Min: 20,  // /api requests per visitor (IP) per 10 minutes
  maxFlights: 500,      // saved flights kept
  maxFlightBytes: 400000,
  minSaveGapMs: 5 * 60 * 1000,
};

function corsFor(request) {
  const origin = request.headers.get("Origin") || "";
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    ok,
    headers: {
      "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    },
  };
}

const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), { status: status || 200, headers: { ...headers, "Content-Type": "application/json" } });

export default {
  async fetch(request, env) {
    const { ok, headers: CORS } = corsFor(request);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    // A browser on another site sends its own Origin; refuse it. (Opening the address directly sends none.)
    if (!ok && request.headers.get("Origin")) return new Response("Origin not allowed", { status: 403, headers: CORS });

    const u = new URL(request.url);
    if (u.pathname.startsWith("/api/")) {
      try { return await api(request, env, u, CORS); }
      catch (e) { return json({ error: "server", detail: String(e && e.message || e) }, 500, CORS); }
    }
    if (request.method !== "GET") return new Response("GET only", { status: 405, headers: CORS });
    return relay(u, CORS);
  },
};

/* ---------- plain relay ---------- */
async function relay(u, CORS) {
  const target = u.searchParams.get("url");
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
  // Tell the page this answer came from the service behind the relay, so a refusal there isn't blamed on the relay.
  headers.set("X-Relay-Upstream", String(upstream.status));
  headers.set("Access-Control-Expose-Headers", "X-Relay-Upstream");
  return new Response(upstream.body, { status: upstream.status, headers });
}

/* ---------- API ---------- */
const recent = new Map();   // per-isolate request counter per visitor; resets as isolates recycle
function tooMany(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (recent.get(ip) || []).filter(t => now - t < win);
  list.push(now); recent.set(ip, list);
  if (recent.size > 5000) recent.clear();
  return list.length > LIMITS.perUserPer10Min;
}

async function api(request, env, u, CORS) {
  if (!env.DATA) return json({ error: "no-storage", detail: "KV binding DATA is not set up" }, 503, CORS);
  const path = u.pathname;
  if (path === "/api/faa" && request.method === "GET") return json(await faaStatus(u.searchParams.get("code") || ""), 200, CORS);
  if (path === "/api/route" && request.method === "GET") return json(await liveRoute(u), 200, CORS);
  if (path === "/api/flights" && request.method === "GET") return json(await listFlights(env, u.searchParams.get("code") || ""), 200, CORS);
  if (path === "/api/flight" && request.method === "GET") {
    const rec = await env.DATA.get("f:" + (u.searchParams.get("id") || ""), "json");
    return rec ? json(rec, 200, CORS) : json({ error: "not-found" }, 404, CORS);
  }
  if (path === "/api/flight" && request.method === "POST") {
    if (tooMany(request)) return json({ error: "slow-down" }, 429, CORS);
    return json(await saveFlight(env, request), 200, CORS);
  }
  if (tooMany(request)) return json({ error: "slow-down" }, 429, CORS);
  if (path === "/api/schedule") return json(await schedule(env, (u.searchParams.get("f") || "").toUpperCase().replace(/[^A-Z0-9]/g, "")), 200, CORS);
  if (path === "/api/aircraft") return json(await aircraft(env, (u.searchParams.get("reg") || "").toUpperCase().replace(/[^A-Z0-9-]/g, "")), 200, CORS);
  return json({ error: "unknown" }, 404, CORS);
}

/* daily caps, counted in KV (one write per paid call; paid calls are rare because results are cached) */
const today = () => new Date().toISOString().slice(0, 10);
async function takeQuota(env, name, max) {
  const k = "cap:" + name + ":" + today();
  const n = parseInt(await env.DATA.get(k) || "0", 10);
  if (n >= max) return false;
  await env.DATA.put(k, String(n + 1), { expirationTtl: 3 * 86400 });
  return true;
}
async function cached(env, key, ttlSec, produce) {
  const hit = await env.DATA.get(key, "json");
  if (hit && Date.now() - hit.at < ttlSec * 1000) return { ...hit.v, cached: true };
  try {
    const v = await produce();
    if (v && !v.error) await env.DATA.put(key, JSON.stringify({ at: Date.now(), v }), { expirationTtl: Math.max(60, ttlSec * 4) });
    return v || (hit ? { ...hit.v, cached: true, stale: true } : { error: "unavailable" });
  } catch (e) {
    return hit ? { ...hit.v, cached: true, stale: true } : { error: "unavailable", detail: String(e.message || e) };
  }
}

/* AeroDataBox (RapidAPI) */
async function adb(env, path) {
  if (!env.ADB_KEY) throw new Error("no ADB key");
  if (!(await takeQuota(env, "adb", LIMITS.adbPerDay))) throw new Error("ADB daily cap reached");
  const r = await fetch("https://aerodatabox.p.rapidapi.com" + path, {
    headers: { "X-RapidAPI-Key": env.ADB_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" },
  });
  if (r.status === 204) return [];
  if (!r.ok) throw new Error("ADB HTTP " + r.status);
  return r.json();
}
/* AirLabs */
async function airlabs(env, endpoint, params) {
  if (!env.AIRLABS_KEY) throw new Error("no AirLabs key");
  if (!(await takeQuota(env, "airlabs", LIMITS.airlabsPerDay))) throw new Error("AirLabs daily cap reached");
  const q = new URLSearchParams({ ...params, api_key: env.AIRLABS_KEY });
  const r = await fetch("https://airlabs.co/api/v9/" + endpoint + "?" + q);
  if (!r.ok) throw new Error("AirLabs HTTP " + r.status);
  const j = await r.json();
  if (j.error) throw new Error("AirLabs " + (j.error.message || j.error.code || "error"));
  return j.response;
}

const utcMs = s => (s ? Date.parse(String(s).replace(" ", "T").replace(/Z?$/, "Z")) : null);
function fromAdb(list) {
  return (list || []).map(f => ({
    number: f.number, callSign: f.callSign || null, status: f.status || null,
    from: f.departure && f.departure.airport && (f.departure.airport.iata || f.departure.airport.icao) || null,
    to: f.arrival && f.arrival.airport && (f.arrival.airport.iata || f.arrival.airport.icao) || null,
    dep: utcMs(f.departure && f.departure.scheduledTime && f.departure.scheduledTime.utc),
    depActual: utcMs(f.departure && (f.departure.runwayTime || f.departure.revisedTime) && (f.departure.runwayTime || f.departure.revisedTime).utc),
    arr: utcMs(f.arrival && f.arrival.scheduledTime && f.arrival.scheduledTime.utc),
    arrActual: utcMs(f.arrival && (f.arrival.runwayTime || f.arrival.revisedTime) && (f.arrival.runwayTime || f.arrival.revisedTime).utc),
    reg: f.aircraft && f.aircraft.reg || null, hex: f.aircraft && f.aircraft.modeS ? f.aircraft.modeS.toLowerCase() : null,
    model: f.aircraft && f.aircraft.model || null,
    fromLL: ll(f.departure && f.departure.airport), toLL: ll(f.arrival && f.arrival.airport),
    fromIcao: f.departure && f.departure.airport && f.departure.airport.icao || null, toIcao: f.arrival && f.arrival.airport && f.arrival.airport.icao || null,
    depTerm: f.departure && f.departure.terminal || null, depGate: f.departure && f.departure.gate || null, depRwy: f.departure && f.departure.runway || null,
    depCheckIn: f.departure && f.departure.checkInDesk || null,
    arrTerm: f.arrival && f.arrival.terminal || null, arrGate: f.arrival && f.arrival.gate || null, arrBelt: f.arrival && f.arrival.baggageBelt || null, arrRwy: f.arrival && f.arrival.runway || null,
    depRevised: utcMs(f.departure && f.departure.revisedTime && f.departure.revisedTime.utc), arrRevised: utcMs(f.arrival && f.arrival.revisedTime && f.arrival.revisedTime.utc),
    fromName: f.departure && f.departure.airport && (f.departure.airport.municipalityName || f.departure.airport.shortName || f.departure.airport.name) || null,
    toName: f.arrival && f.arrival.airport && (f.arrival.airport.municipalityName || f.arrival.airport.shortName || f.arrival.airport.name) || null,
  })).filter(x => x.dep);
}
/* FAA National Airspace System status (US airports): ground stops, ground delay programs, delays, closures. XML -> JSON. */
async function faaStatus(code) {
  code = String(code).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  if (!code) return { error: "bad-request" };
  const r = await fetch("https://nasstatus.faa.gov/api/airport-status-information", {
    headers: { "User-Agent": "personal-flight-tracker-relay", "Accept": "application/xml" }, cf: { cacheTtl: 120, cacheEverything: true } });
  if (!r.ok) return { error: "upstream", status: r.status };
  const x = await r.text(), out = [];
  const upd = (/<Update_Time>([^<]*)<\/Update_Time>/.exec(x) || [])[1] || null;
  for (const blk of x.split("<Delay_type>").slice(1)) {
    const type = ((/<Name>([^<]*)<\/Name>/.exec(blk) || [])[1] || "").trim();
    // every record that names an airport: grab its simple <Tag>value</Tag> pairs
    const recs = blk.split(/<(?=ARPT>)/).slice(1);
    for (const rec of recs) {
      const arpt = ((/^ARPT>([^<]*)</.exec(rec) || [])[1] || "").trim().toUpperCase();
      if (arpt !== code && "K" + arpt !== code && arpt !== "K" + code) continue;
      const o = { type };
      for (const m of rec.matchAll(/<([A-Za-z_]+)(?:\s+Type="([^"]*)")?>([^<]+)<\/\1>/g)) o[m[2] ? m[2] + "_" + m[1] : m[1]] = m[3].trim();
      const ad = /<Arrival_Departure Type="([^"]*)">/.exec(rec); if (ad) o.dir = ad[1];
      out.push(o);
    }
  }
  return { code, updated: upd, events: out };
}
function ll(a) { const l = a && a.location; return l && typeof l.lat === "number" && typeof l.lon === "number" ? [l.lat, l.lon] : null; }

/* Route for a callsign seen at a position, checked for plausibility (adsb.lol's routeset, which only takes POST). */
async function liveRoute(u) {
  const cs = String(u.searchParams.get("cs") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const lat = +u.searchParams.get("lat"), lon = +u.searchParams.get("lon");
  if (!cs || !isFinite(lat) || !isFinite(lon)) return { error: "bad-request" };
  const r = await fetch("https://api.adsb.lol/api/0/routeset", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "personal-flight-tracker-relay" },
    body: JSON.stringify({ planes: [{ callsign: cs, lat, lng: lon }] }),
  });
  if (!r.ok) return { error: "upstream", status: r.status };
  return { routes: await r.json() };
}
function fromAirlabs(list) {
  return (list || []).map(f => ({
    number: f.flight_iata, callSign: f.flight_icao || null, status: f.status || null,
    from: f.dep_iata || f.dep_icao || null, to: f.arr_iata || f.arr_icao || null,
    dep: utcMs(f.dep_time_utc), depActual: utcMs(f.dep_actual_utc), arr: utcMs(f.arr_time_utc), arrActual: utcMs(f.arr_actual_utc),
    reg: f.reg_number || null, hex: f.hex ? String(f.hex).toLowerCase() : null, model: f.aircraft_icao || null,
  })).filter(x => x.dep);
}

/* Flights for a number: yesterday, today and the next two days. Each day is cached on its own:
   finished days for a day, today for 20 minutes, future days for 6 hours. */
async function schedule(env, f) {
  if (!/^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(f)) return { error: "bad-flight" };
  const days = [-1, 0, 1, 2].map(k => new Date(Date.now() + k * 86400000).toISOString().slice(0, 10));
  const out = []; let source = null; const errors = [];
  for (const [i, d] of days.entries()) {
    const ttl = i === 0 ? 86400 : i === 1 ? 1200 : 21600;
    const v = await cached(env, "s:" + f + ":" + d, ttl, async () => ({ src: "AeroDataBox", flights: fromAdb(await adb(env, "/flights/number/" + f + "/" + d + "?withAircraftImage=false&withLocation=false")) }));
    if (v && v.flights) { out.push(...v.flights); source = source || v.src; } else errors.push(d + ": " + (v && (v.detail || v.error)));
  }
  if (!out.length) {
    const v = await cached(env, "sa:" + f, 1200, async () => ({ src: "AirLabs", flights: fromAirlabs(await airlabs(env, "schedules", { flight_iata: f })) }));
    if (v && v.flights) { out.push(...v.flights); source = v.src; } else errors.push("airlabs: " + (v && (v.detail || v.error)));
  }
  const seen = new Set();
  const flights = out.filter(x => { const k = x.dep + ":" + x.from; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.dep - b.dep);
  return flights.length ? { source, flights } : { error: "unavailable", detail: errors.join("; ") };
}

/* Aircraft: build details (cached a week) and today's flights (cached 30 minutes). */
async function aircraft(env, reg) {
  if (!/^[A-Z0-9-]{3,10}$/.test(reg)) return { error: "bad-reg" };
  const info = await cached(env, "a:" + reg, 7 * 86400, async () => {
    try {
      const a = await adb(env, "/aircrafts/reg/" + reg);
      return { src: "AeroDataBox", model: a.typeName || a.model || null, airline: a.airlineName || null, serial: a.serial || null,
        productionLine: a.productionLine || null, firstFlight: a.firstFlightDate || null, delivered: a.deliveryDate || null,
        registered: a.registrationDate || null, ageYears: a.ageYears != null ? a.ageYears : null, seats: a.numSeats || null };
    } catch (e) {
      const r = await airlabs(env, "fleets", { reg_number: reg });
      const a = Array.isArray(r) ? r[0] : r;
      if (!a) throw e;
      return { src: "AirLabs", model: a.model || a.aircraft_icao || null, airline: a.airline_iata || null, serial: a.msn || null,
        productionLine: null, firstFlight: null, delivered: a.delivered || null, registered: null,
        ageYears: a.age != null ? a.age : null, built: a.built || null, seats: null };
    }
  });
  const d = today();
  const t = await cached(env, "at:" + reg + ":" + d, 1800, async () => ({ src: "AeroDataBox", flights: fromAdb(await adb(env, "/flights/reg/" + reg + "/" + d + "?withAircraftImage=false&withLocation=false")) }));
  return { info: info && !info.error ? info : null, today: t && t.flights ? t.flights : null };
}

/* ---------- saved flights (KV), newest 500 kept ---------- */
async function listFlights(env, code) {
  const idx = (await env.DATA.get("idx", "json")) || [];
  return { flights: code ? idx.filter(x => x.code === code) : idx };
}
async function saveFlight(env, request) {
  const text = await request.text();
  if (text.length > LIMITS.maxFlightBytes) return { error: "too-big" };
  let rec; try { rec = JSON.parse(text); } catch { return { error: "bad-json" }; }
  if (!rec || !/^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(rec.code || "") || !(rec.t0 > 0) || !(rec.t1 >= rec.t0)) return { error: "bad-record" };
  for (const k of ["alt", "spd", "vs", "hdg", "pos"]) if (rec[k] && !Array.isArray(rec[k])) return { error: "bad-record" };
  const idx = (await env.DATA.get("idx", "json")) || [];
  // same flight = same number with overlapping time (30 min slack)
  const e = idx.find(x => x.code === rec.code && x.t0 < rec.t1 + 1800000 && x.t1 > rec.t0 - 1800000);
  const now = Date.now();
  if (e && !rec.final && now - (e.saved || 0) < LIMITS.minSaveGapMs) return { ok: true, id: e.id, skipped: true };
  const old = e ? await env.DATA.get("f:" + e.id, "json") : null;
  const id = e ? e.id : rec.code + "-" + rec.t0;
  const merged = mergeRec(old, rec); merged.id = id; delete merged.final;
  await env.DATA.put("f:" + id, JSON.stringify(merged));
  const entry = { id, code: merged.code, t0: merged.t0, t1: merged.t1, from: merged.from || "", to: merged.to || "", hex: merged.hex || "", saved: now };
  const next = idx.filter(x => x.id !== id).concat(entry).sort((a, b) => a.t0 - b.t0);
  const drop = next.length > LIMITS.maxFlights ? next.splice(0, next.length - LIMITS.maxFlights) : [];
  for (const x of drop) await env.DATA.delete("f:" + x.id);
  await env.DATA.put("idx", JSON.stringify(next));
  return { ok: true, id };
}
function mergeRec(a, b) {
  if (!a) return b;
  const out = { ...a, ...b, t0: Math.min(a.t0, b.t0), t1: Math.max(a.t1, b.t1) };
  for (const k of ["alt", "spd", "vs", "hdg", "pos"]) {
    const all = (a[k] || []).concat(b[k] || []).sort((x, y) => x[0] - y[0]), m = [];
    for (const q of all) if (!m.length || q[0] - m[m.length - 1][0] >= 15000) m.push(q);
    out[k] = m;
  }
  return out;
}
