// Fetches what Netflix, Disney+, Hulu, HBO Max, Peacock, Paramount+ and Apple TV+ added,
// and saves it to data/new-on-streaming.json for the TV Today page to read.
// Runs on a schedule in GitHub Actions (see .github/workflows/update-new-on-streaming.yml).
// API keys come from repository secrets: MOTN_KEY (RapidAPI, Streaming Availability) and WATCHMODE_KEY.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const OUT = "data/new-on-streaming.json";
const KEEP_DAYS = 21;
const MOTN_HOST = "streaming-availability.p.rapidapi.com";
const MOTN_CATALOGS = { netflix: "Netflix", disney: "Disney+", hulu: "Hulu", hbo: "HBO Max", peacock: "Peacock", paramount: "Paramount+", apple: "Apple TV+" };
const WM_SERVICES = { 203: "Netflix", 157: "Hulu", 634: "Hulu", 372: "Disney+", 387: "HBO Max", 389: "Peacock", 388: "Peacock", 444: "Paramount+", 371: "Apple TV+" };
const MAX_MOTN_PAGES = 10;

const now = Math.floor(Date.now() / 1000);
let data = { updated: 0, motnUpdatedTo: 0, motn: [], watchmode: [], log: [] };
try { data = { ...data, ...JSON.parse(await readFile(OUT, "utf8")) }; } catch { /* first run */ }
const log = [];

// ---- Streaming Availability API: titles newly added to each service ----
if (process.env.MOTN_KEY) {
  // fetch from where the last run stopped (1 hour overlap), or the last 3 days on the first run
  const from = data.motnUpdatedTo ? data.motnUpdatedTo - 3600 : now - 3 * 86400;
  let cursor = "", pages = 0, added = 0, maxTs = 0;
  const seen = new Set(data.motn.map(x => `${x.id}|${x.svc}`));
  try {
    do {
      const q = `/changes?change_type=new&item_type=show&country=us&catalogs=${Object.keys(MOTN_CATALOGS).join(",")}` +
        `&from=${from}&to=${now}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const r = await fetch(`https://${MOTN_HOST}${q}`, { headers: { "X-RapidAPI-Key": process.env.MOTN_KEY, "X-RapidAPI-Host": MOTN_HOST } });
      if (!r.ok) throw new Error(`Streaming Availability API HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      pages++;
      const shows = j.shows || {};
      for (const ch of j.changes || []) {
        if (ch.timestamp && ch.timestamp > maxTs) maxTs = ch.timestamp;
        const svcId = ch.service && ch.service.id;
        if (!MOTN_CATALOGS[svcId]) continue;
        if (ch.streamingOptionType && !/subscription|free|addon/.test(ch.streamingOptionType)) continue; // skip rent/buy
        const svc = MOTN_CATALOGS[svcId];
        const k = `${ch.showId}|${svc}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const sh = shows[ch.showId] || {};
        const vp = sh.imageSet && sh.imageSet.verticalPoster;
        data.motn.push({
          id: ch.showId, ts: ch.timestamp || now, svc, title: sh.title || String(ch.showId),
          type: ch.showType || sh.showType || "", imdb: sh.imdbId || "", tmdb: sh.tmdbId || "",
          year: sh.releaseYear || sh.firstAirYear || "", poster: (vp && (vp.w240 || vp.w360)) || "",
          overview: sh.overview || "", genres: (sh.genres || []).map(g => g.name || g).filter(Boolean)
        });
        added++;
      }
      cursor = j.hasMore ? j.nextCursor : "";
    } while (cursor && pages < MAX_MOTN_PAGES);
    // if we stopped at the page limit, resume from the last change we saw next time (results come oldest first)
    data.motnUpdatedTo = cursor && maxTs ? maxTs + 3600 : now;
    log.push(`Streaming Availability: ${added} new, ${pages} request(s)${cursor ? " (stopped at page limit)" : ""}`);
  } catch (e) {
    log.push(`Streaming Availability error: ${e.message}`);
  }
} else log.push("MOTN_KEY secret not set — skipped Streaming Availability");

// ---- Watchmode: release dates, with the "original" flag ----
if (process.env.WATCHMODE_KEY) {
  const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
  const sd = ymd(new Date(Date.now() - 3 * 86400000)), ed = ymd(new Date(Date.now() + 2 * 86400000));
  try {
    const r = await fetch(`https://api.watchmode.com/v1/releases/?start_date=${sd}&end_date=${ed}&limit=250`, { headers: { "X-API-Key": process.env.WATCHMODE_KEY } });
    if (!r.ok) throw new Error(`Watchmode HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const fresh = (j.releases || []).filter(x => WM_SERVICES[x.source_id]);
    const byKey = new Map(data.watchmode.map(x => [`${x.id}|${x.source_id}`, x]));
    fresh.forEach(x => byKey.set(`${x.id}|${x.source_id}`, x));
    data.watchmode = [...byKey.values()];
    log.push(`Watchmode: ${fresh.length} releases in window, 1 request`);
  } catch (e) {
    log.push(`Watchmode error: ${e.message}`);
  }
} else log.push("WATCHMODE_KEY secret not set — skipped Watchmode");

// ---- prune and save ----
const cutoff = now - KEEP_DAYS * 86400;
const cutoffDate = new Date(cutoff * 1000).toISOString().slice(0, 10);
data.motn = data.motn.filter(x => x.ts >= cutoff);
data.watchmode = data.watchmode.filter(x => String(x.source_release_date || "").slice(0, 10) >= cutoffDate);
data.updated = now;
data.log = [`${new Date(now * 1000).toISOString()} — ${log.join(" · ")}`, ...(data.log || [])].slice(0, 20);
await mkdir("data", { recursive: true });
await writeFile(OUT, JSON.stringify(data));
console.log(log.join("\n"));
