// Run with: node --test test/
const test = require("node:test");
const assert = require("node:assert");
const E = require("../engine.js");

const lake = { lat: 34.42, lon: -86.23, water: "reservoir", clarity: "stained", structures: ["grass", "rock"], species: ["lmb"] };
const ctxWith = (M, spot = lake) => E.buildCtx(spot, E.manualCond(M), "lmb");
const base = { air: 70, water: 66, wind: 10, windDir: "SW", sky: "overcast", trend: "steady" };

test("sunrise and sunset for Guntersville on 2026-10-20 are within 5 minutes of the almanac", () => {
  const t0 = Date.UTC(2026, 9, 20, 5), ev = E.astroEvents(t0, t0 + 864e5, 34.42, -86.23);
  assert.ok(Math.abs(ev.sunrise[0] - Date.UTC(2026, 9, 20, 12, 1)) < 6 * 60e3, "sunrise ~7:01 CDT");
  assert.ok(Math.abs(ev.sunset[0] - Date.UTC(2026, 9, 20, 23, 11)) < 6 * 60e3, "sunset ~6:11 CDT");
});

test("full moon on 2026-10-26", () => {
  assert.strictEqual(E.moonPhaseName(E.moonIllum(Date.UTC(2026, 9, 26, 4)).phase), "Full moon");
});

test("falling pressure and overcast outscore a calm post-front bluebird day", () => {
  const good = ctxWith({ ...base, trend: "falling" }), bad = ctxWith({ ...base, wind: 1, sky: "sunny", trend: "post-front" });
  assert.ok(good.now.score > bad.now.score + 15, `${good.now.score} vs ${bad.now.score}`);
});

test("water-temperature tips use the temperature, not the reading object", () => {
  const hot = ctxWith({ ...base, water: 88 }), cold = ctxWith({ ...base, water: 44 }), mid = ctxWith({ ...base, water: 66 });
  assert.ok(E.conditionTips(hot).some(t => t.title === "Hot water"));
  assert.ok(E.conditionTips(cold).some(t => /Very cold water/.test(t.title)));
  assert.ok(!E.conditionTips(mid).some(t => /Hot water|Very cold/.test(t.title)));
  assert.match(E.structureTip("grass", hot), /Frog or punch/);
  assert.match(E.structureTip("grass", cold), /lipless/);
});

// Shape of the USGS NWIS instantaneous-values JSON (waterservices.usgs.gov/nwis/iv, format=json).
function usgs(sites) {
  return { value: { timeSeries: sites.map(s => ({
    sourceInfo: { siteName: s.name, siteCode: [{ value: s.id, agencyCode: "USGS" }], geoLocation: { geogLocation: { srs: "EPSG:4326", latitude: s.lat, longitude: s.lon } } },
    variable: { variableCode: [{ value: "00010" }], unit: { unitCode: "deg C" }, noDataValue: -999999 },
    values: [{ value: s.vals.map(([hoursAgo, c]) => ({ value: String(c), qualifiers: ["P"], dateTime: new Date(Date.now() - hoursAgo * 36e5).toISOString() })) }],
  })) } };
}

test("picks the nearest fresh gauge, converts to °F and computes the 3-day change", () => {
  const g = E.parseGauges(usgs([
    { id: "far", name: "FAR CREEK", lat: 34.6, lon: -86.0, vals: [[2, 20]] },
    { id: "near", name: "NEAR RIVER", lat: 34.45, lon: -86.25, vals: [[70, 15], [30, 16], [1, 17], [0.5, -999999]] },
  ]), lake);
  assert.strictEqual(g.id, "near");
  assert.strictEqual(g.f, 62.6);          // 17 °C
  assert.strictEqual(g.change, 3.6);      // +2 °C over ~69 h
  assert.ok(g.dist < 3);
});

test("ignores stale or distant gauges", () => {
  assert.strictEqual(E.parseGauges(usgs([{ id: "old", name: "OLD", lat: 34.43, lon: -86.23, vals: [[30, 18]] }]), lake), null);
  assert.strictEqual(E.parseGauges(usgs([{ id: "far", name: "FAR", lat: 35.2, lon: -86.23, vals: [[1, 18]] }]), lake), null);
  assert.strictEqual(E.parseGauges({}, lake), null);
});

test("a gauge feeds water temperature and a trend tip, and can be turned off per spot", () => {
  const cond = E.manualCond(base);
  cond.mode = "live";
  cond.gauge = { id: "x", name: "NEAR RIVER", dist: 4.2, at: Date.now() - 36e5, f: 58.3, change: -3.2, spanH: 70 };
  const ctx = E.buildCtx(lake, cond, "lmb");
  assert.strictEqual(ctx.water.v, 58);
  assert.match(ctx.water.src, /USGS · 4 mi/);
  assert.ok(E.conditionTips(ctx).some(t => /Water cooled 3.2°F/.test(t.title)));
  assert.notStrictEqual(E.buildCtx({ ...lake, gauge: "off" }, cond, "lmb").water.src.slice(0, 4), "USGS");
  // Ponds ignore gauges unless turned on; rivers use them by default. "auto" (saved by older versions) means the default.
  const pond = { ...lake, water: "pond" };
  assert.strictEqual(E.buildCtx(pond, cond, "lmb").water.src, "estimate");
  assert.strictEqual(E.buildCtx({ ...pond, gauge: "auto" }, cond, "lmb").water.src, "estimate");
  assert.match(E.buildCtx({ ...pond, gauge: "on" }, cond, "lmb").water.src, /^USGS/);
  assert.match(E.buildCtx({ ...lake, water: "river" }, cond, "lmb").water.src, /^USGS/);
  assert.ok(!E.conditionTips(E.buildCtx(pond, cond, "lmb")).some(t => /Water cooled/.test(t.title)), "no gauge trend tip for a pond");
});

test("time ranges and day words read naturally", () => {
  const tz = -18000, mid = Math.floor((Date.now() + tz * 1000) / 864e5) * 864e5 - tz * 1000, h = 36e5;
  assert.strictEqual(E.fmtRange(mid + 7 * h, mid + 9 * h, tz), "7–9 AM");
  assert.strictEqual(E.fmtRange(mid + 11 * h, mid + 13 * h, tz), "11 AM–1 PM");
  assert.strictEqual(E.fmtRange(mid + 23 * h, mid + 25 * h, tz), "11 PM–1 AM");
  assert.strictEqual(E.dayWord(mid + 5 * h, tz), "today");
  assert.strictEqual(E.dayWord(mid + 29 * h, tz), "tomorrow");
  assert.match(E.dayWord(mid + 53 * h, tz), /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
});

test("reads coordinates in the formats people paste", () => {
  const want = { lat: 35.2501, lon: -91.7365 };
  for (const s of [
    "35.2501, -91.7365",                       // Google Maps
    "35.2501,-91.7365",
    "35.2501 -91.7365",
    "  35.2501 , -91.7365  ",
    "35.2501° N, 91.7365° W",                  // Apple Maps
    "35.2501°N 91.7365°W",
    "N 35.2501, W 91.7365",
    "91.7365° W, 35.2501° N",                  // longitude first, with letters
    "35.2501, −91.7365",                  // Unicode minus
    "35.2501, -91.7365",                  // non-breaking space
    "https://www.google.com/maps/place/Lake/@35.2501,-91.7365,15z/data=!3m1",
    "https://maps.apple.com/?ll=35.2501,-91.7365&q=Dropped%20Pin",
    "https://maps.google.com/?q=35.2501,-91.7365",
  ]) assert.deepStrictEqual(E.parseCoords(s), want, s);
  // Degrees, minutes, seconds (35°15'00.4"N = 35.25011)
  const dms = E.parseCoords(`35°15'00.4"N 91°44'11.4"W`);
  assert.ok(Math.abs(dms.lat - 35.25011) < 1e-4 && Math.abs(dms.lon + 91.73650) < 1e-4, JSON.stringify(dms));
  const dms2 = E.parseCoords("35°15′00.4″N 91°44′11.4″W");
  assert.ok(Math.abs(dms2.lat - 35.25011) < 1e-4 && Math.abs(dms2.lon + 91.73650) < 1e-4, JSON.stringify(dms2));
  for (const bad of ["", "Searcy", "35.25", "https://maps.app.goo.gl/AbC123xyz", "95, 20", "35, 200"]) assert.strictEqual(E.parseCoords(bad), null, bad);
});

test("a trip is scored hour by hour, including partial hours", () => {
  const cond = E.manualCond(base); cond.mode = "live";
  const h0 = cond.hours.find(h => h.t >= Date.now() - 6 * 36e5).t;
  const hours = E.scoreTrip(lake, cond, "lmb", h0 + 30 * 60e3, h0 + 3 * 36e5);   // 2.5 h
  assert.deepStrictEqual(hours.map(h => h.frac), [0.5, 1, 1]);
  assert.ok(hours.every(h => h.score >= 1 && h.score <= 99));
});

test("report card: fish per hour by score band and a verdict", () => {
  const H = 36e5, t0 = Date.UTC(2026, 9, 1, 12);
  const trip = (id, day, scores, extra = {}) => ({ id, kind: "trip", start: t0 + day * 864e5, end: t0 + day * 864e5 + scores.length * H,
    hours: scores.map((score, i) => ({ t: t0 + day * 864e5 + i * H, frac: 1, score })), ...extra });
  const trips = [trip("a", 0, [80, 70, 40]), trip("b", 1, [65, 30, 35]), trip("c", 2, [72, 44])];
  const catch_ = (tripId, day, hr, score) => ({ kind: "catch", tripId, t: t0 + day * 864e5 + hr * H + 600e3, count: 1, snap: score == null ? null : { score } });
  // 5 fish in Good/Hot hours (4 h), 1 fish in Fair/Slow hours (4 h); one catch has no saved score and is placed by its trip hour.
  const catches = [catch_("a", 0, 0, 80), catch_("a", 0, 1, 70), catch_("a", 0, 1, 70), catch_("b", 1, 0, 65), catch_("c", 2, 0, null), catch_("b", 1, 2, 35), catch_("zzz", 0, 0, 90)];
  const r = E.reportCard(trips, catches);
  assert.strictEqual(r.trips, 3);
  assert.strictEqual(r.hi.hours, 4); assert.strictEqual(r.hi.fish, 5);
  assert.strictEqual(r.lo.hours, 4); assert.strictEqual(r.lo.fish, 1);
  assert.strictEqual(r.verdict, "working");
  assert.strictEqual(r.ratio, 5);
  // Not enough trips yet
  assert.strictEqual(E.reportCard(trips.slice(0, 2), catches).verdict, "learning");
  assert.strictEqual(E.reportCard(trips, catches).solid, false);   // 3 trips, 6 fish: an early read
  // Too few fish to judge, even with enough trips and hours
  assert.strictEqual(E.reportCard(trips, [catch_("a", 0, 0, 80), catch_("b", 1, 1, 30)]).verdict, "learning");
  // Same catch rate in both halves: no evidence the score helps
  const even = [0, 1, 1].map(h => catch_("a", 0, h, 75)).concat([2].map(h => catch_("a", 0, h, 40)), [1, 2].map(h => catch_("b", 1, h, 30)));
  assert.strictEqual(E.reportCard(trips, even).verdict, "unclear");
  // Unfinished trips don't count
  assert.strictEqual(E.reportCard([...trips, { id: "live", start: t0, end: null }], catches).trips, 3);
  // A past trip logged with a fish count is credited at its average score
  const past = trip("p", 5, [30, 30, 30], { fish: 3 });
  assert.strictEqual(E.reportCard([...trips, past], catches).lo.fish, 4);
});

test("scene follows the sun at the spot and the current weather", () => {
  // Guntersville, 2026-10-20: sunrise ~12:01 UTC, sunset ~23:11 UTC.
  const at = (h, m = 0) => Date.UTC(2026, 9, 20, h, m);
  const cond = (fields) => ({ hours: [{ t: at(17), cloud: 10, precip: 0, code: 0, ...fields }] });
  assert.strictEqual(E.sceneOf(lake, null, at(17, 30)).sky, "day");
  assert.strictEqual(E.sceneOf(lake, null, at(5)).sky, "night");
  assert.strictEqual(E.sceneOf(lake, null, at(12, 5)).sky, "dawn");
  assert.strictEqual(E.sceneOf(lake, null, at(23, 15)).sky, "dusk");
  const wx = f => E.sceneOf(lake, cond(f), at(17, 30)).wx;
  assert.strictEqual(wx({}), "clear");
  assert.strictEqual(wx({ cloud: 50 }), "partly");
  assert.strictEqual(wx({ cloud: 90, code: 3 }), "cloudy");
  assert.strictEqual(wx({ code: 45 }), "fog");
  assert.strictEqual(wx({ code: 61, precip: 0.05 }), "rain");
  assert.strictEqual(wx({ code: 0, precip: 0.1 }), "rain");      // rain without a code (manual conditions)
  assert.strictEqual(wx({ code: 73 }), "snow");
  assert.strictEqual(wx({ code: 95 }), "storm");
});

test("each hour is blended with its neighbours, so a one-hour spike can't flip the rating", () => {
  const cond = E.manualCond(base); cond.mode = "live";
  const ctx = E.buildCtx(lake, cond, "lmb");
  for (let i = 1; i < ctx.future.length; i++) assert.ok(Math.abs(ctx.future[i].score - ctx.future[i - 1].score) <= 12, `hour ${i}`);
});

test("best times are parts of the day, bounded by the sun, in time order", () => {
  const cond = E.manualCond(base); cond.mode = "live";
  const ctx = E.buildCtx(lake, cond, "lmb"), wins = E.bestWindows(ctx.future, ctx.astro);
  assert.ok(wins.length >= 3 && wins.length <= 6);
  assert.strictEqual(wins.filter(w => w.best).length, 1);
  for (let i = 1; i < wins.length; i++) assert.ok(wins[i].start >= wins[i - 1].end);
  for (const w of wins) {
    assert.ok(["morning", "midday", "evening", "night"].includes(w.part));
    assert.ok(w.end > Date.now() && w.end - w.start >= 36e5);
    if (w.part === "morning") assert.ok(ctx.astro.sunrise.some(r => Math.abs(w.end - (r + 3 * 36e5)) <= 3e5 || Math.abs(w.start - (r - 36e5)) <= 3e5));
  }
  assert.match(E.whenWord({ part: "night", start: Date.now() }, -18000), /^tonight$/);
});

test("small forecast updates barely move the score or the best times", () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, g = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const now = Math.floor(Date.now() / 36e5) * 36e5, hours = [];
  for (let i = -168; i < 72; i++) { const t = now + i * 36e5, hr = ((t / 36e5 - 5) % 24 + 24) % 24;
    hours.push({ t, air: 62 + 9 * Math.sin((hr - 9) / 24 * 2 * Math.PI), pres: 30.05 + 0.12 * Math.sin(i / 20), wind: 7 + 5 * Math.sin(i / 7), dir: 200, gust: 14,
      cloud: 50 + 40 * Math.sin(i / 11), precip: Math.max(0, 0.05 * Math.sin(i / 9) - 0.02), code: 2 }); }
  const cond = hs => ({ mode: "live", tz: -18000, fetchedAt: Date.now(), gauge: null, waterEst: 64, hours: E.deriveHours(hs.map(h => ({ ...h }))) });
  const run = hs => { const c = E.buildCtx(lake, cond(hs), "lmb"); return { s: c.future.map(x => x.score), w: E.bestWindows(c.future, c.astro).filter(w => w.best).map(w => w.start).join() }; };
  const b = run(hours);
  let maxMove = 0, winChanges = 0;
  for (let k = 0; k < 100; k++) {
    const r = run(hours.map(h => ({ ...h, pres: h.pres + g() * 0.006, wind: Math.max(0, h.wind + g() * 1.2), cloud: Math.min(100, Math.max(0, h.cloud + g() * 8)), precip: Math.max(0, h.precip + g() * 0.01), air: h.air + g() * 0.8 })));
    r.s.forEach((v, i) => { maxMove = Math.max(maxMove, Math.abs(v - b.s[i])); });
    if (r.w !== b.w) winChanges++;
  }
  assert.ok(maxMove <= 10, `max move ${maxMove}`);
  assert.ok(winChanges <= 15, `best times changed on ${winChanges}% of updates`);
});

// ---------------------------------------------------------------- loading: the forecast never waits for USGS
function openMeteo() {
  const now = Math.floor(Date.now() / 36e5) * 3600, H = { time: [], temperature_2m: [], pressure_msl: [], wind_speed_10m: [], wind_direction_10m: [], wind_gusts_10m: [], cloud_cover: [], precipitation: [], weather_code: [] };
  for (let t = now - 7 * 86400; t < now + 3 * 86400; t += 3600) { H.time.push(t); H.temperature_2m.push(60); H.pressure_msl.push(1016); H.wind_speed_10m.push(5); H.wind_direction_10m.push(180); H.wind_gusts_10m.push(9); H.cloud_cover.push(40); H.precipitation.push(0); H.weather_code.push(1); }
  return { utc_offset_seconds: -18000, hourly: H };
}
const ogcLatest = (hoursAgo = 1) => ({ type: "FeatureCollection", features: [
  { type: "Feature", geometry: { type: "Point", coordinates: [-86.6, 34.9] }, properties: { monitoring_location_id: "USGS-FAR", parameter_code: "00010", time: new Date(Date.now() - 36e5).toISOString(), value: "20", unit_of_measure: "degC" } },
  { type: "Feature", geometry: { type: "Point", coordinates: [-86.25, 34.45] }, properties: { monitoring_location_id: "USGS-03573000", parameter_code: "00010", time: new Date(Date.now() - hoursAgo * 36e5).toISOString(), value: "16.5", unit_of_measure: "degC" } },
] });
const ogcHistory = { features: [[70, 18.5], [40, 17.5], [1, 16.5]].map(([h, c]) => ({ properties: { time: new Date(Date.now() - h * 36e5).toISOString(), value: String(c), unit_of_measure: "degC" } })) };
function withFetch(routes, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    for (const [re, reply] of routes) if (re.test(url)) {
      if (reply === "hang") return new Promise((_, reject) => opts && opts.signal && opts.signal.addEventListener && opts.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      if (reply === "fail") return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => (typeof reply === "function" ? reply() : reply) };
    }
    throw new Error("unexpected " + url);
  };
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; });
}

test("the forecast loads without waiting for a slow gauge, keeping the last reading", async () => {
  const prev = { gauge: { id: "x", f: 58, at: Date.now() - 36e5, dist: 3 }, gaugeCheckedAt: Date.now() - 10 * 60e3 };
  await withFetch([[/open-meteo/, openMeteo], [/usgs/, "hang"]], async () => {
    const t0 = Date.now(), cond = await E.loadLive({ ...lake, water: "river" }, prev);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
    assert.strictEqual(cond.gauge.f, 58);
  });
});

test("reads the new USGS Water Data API: nearest fresh gauge, °F, 3-day change and name", async () => {
  const g = E.parseLatestOgc(ogcLatest(), lake);
  assert.strictEqual(g.id, "USGS-03573000"); assert.strictEqual(g.f, 61.7); assert.ok(g.dist < 5);
  assert.strictEqual(E.parseLatestOgc(ogcLatest(30), lake), null, "stale readings are ignored");
  const t = E.trendFromOgc(ogcHistory, g);
  assert.strictEqual(t.change, -3.6); assert.ok(t.spanH >= 68);
  await withFetch([[/latest-continuous/, ogcLatest()], [/collections\/continuous/, ogcHistory], [/monitoring-locations/, { properties: { monitoring_location_name: "TENNESSEE RIVER AT GUNTERSVILLE, AL" } }], [/waterservices/, "hang"]], async () => {
    const t0 = Date.now(), r = await E.loadGauge(lake);
    assert.ok(Date.now() - t0 < 1000, "doesn't wait for the old service");
    assert.strictEqual(r.name, "TENNESSEE RIVER AT GUNTERSVILLE, AL"); assert.strictEqual(r.change, -3.6);
  });
});

test("falls back to the old USGS service when the new one fails, and gives up cleanly when both do", async () => {
  const legacy = { value: { timeSeries: [{ sourceInfo: { siteName: "OLD RIVER", siteCode: [{ value: "1" }], geoLocation: { geogLocation: { latitude: 34.45, longitude: -86.25 } } },
    variable: { unit: { unitCode: "deg C" }, noDataValue: -999999 }, values: [{ value: [{ value: "15", dateTime: new Date(Date.now() - 36e5).toISOString() }] }] }] } };
  await withFetch([[/api\.waterdata/, "fail"], [/waterservices/, legacy]], async () => assert.strictEqual((await E.loadGauge(lake)).name, "OLD RIVER"));
  await withFetch([[/api\.waterdata/, "fail"], [/waterservices/, "fail"]], async () => assert.strictEqual(await E.loadGauge(lake), null));
});

test("water estimate lags the air more for big water, and a past reading corrects it", () => {
  // Fall: air cools from 75°F to 55°F over 30 days.
  const now = Math.floor(Date.now() / 36e5) * 36e5, hrs = [];
  for (let k = 720; k >= 0; k--) hrs.push({ t: now - k * 36e5, air: 55 + 20 * k / 720 });
  const pond = E.waterEstimate(hrs, now, "pond"), res = E.waterEstimate(hrs, now, "reservoir");
  assert.ok(pond >= 55 && pond < 60, `pond ${pond}`);
  assert.ok(res > pond + 3, `reservoir ${res} stays warmer than pond ${pond}`);
  assert.strictEqual(E.waterEstimate([], now, "lake"), null);
  const cond = { mode: "live", waterEst: 60, gauge: null };
  const spot = days => ({ water: "pond", reading: { water: 64, estAt: 59, at: Date.now() - days * 864e5, waterAt: Date.now() - days * 864e5 } });
  assert.deepStrictEqual(E.waterOf(spot(1), cond), { v: 64, src: "your reading" });
  assert.strictEqual(E.waterOf(spot(5), cond).v, 65); // estimate + the 5° it was off
  assert.ok(E.waterOf(spot(5), cond).tuned);
  assert.strictEqual(E.waterOf(spot(70), cond).v, 60); // correction has faded
  assert.strictEqual(E.waterOf({ water: "pond", reading: { water: 64, at: Date.now() - 5 * 864e5 } }, cond).v, 60); // old readings without estAt
});

test("readings calibrate the estimate: the offset and how fast the water follows the air", () => {
  // A "pond" that behaves like a lake (7-day lag) and runs 3°F warm, with ±1°F thermometer noise.
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const now = Math.floor(Date.now() / 36e5) * 36e5, hrs = [];
  for (let k = 60 * 24; k >= 0; k--) {
    const t = now - k * 36e5, d = k / 24;
    hrs.push({ t, air: 62 + 12 * Math.sin(d / 9) + 6 * Math.sin(d / 2.3) + 8 * Math.sin(2 * Math.PI * d) });
  }
  const truth = t => E.waterEstimate(hrs, t, "lake", 7) + 3;
  const cal = [];
  for (let d = 30; d >= 2; d -= 4) {
    const t = now - d * 864e5;
    cal.push({ t, water: Math.round(truth(t) + (rnd() * 2 - 1)), est: E.waterEstimates(hrs, t) });
  }
  const spot = { water: "pond", cal }, cond = { mode: "live", gauge: null, waterEst: E.waterEstimate(hrs, now, "pond"), waterEsts: E.waterEstimates(hrs, now) };
  const fit = E.waterCalibration(spot), w = E.waterOf(spot, cond);
  assert.ok(Math.abs(w.v - truth(now)) <= 2, `tuned ${w.v} vs actual ${truth(now)}`);
  assert.ok(fit.sd < 2, `sd ${fit.sd}`);
  assert.ok(fit.lag >= 4 && fit.lag <= 10, `lag ${fit.lag}`);
  assert.ok(w.tuned && w.src.includes("tuned"));
  // Without readings the same spot is plain estimate, and further off.
  assert.ok(Math.abs(E.waterOf({ water: "pond" }, cond).v - truth(now)) > Math.abs(w.v - truth(now)));
});

test("several spots load in one forecast request; the month of air history loads at most twice a day", async () => {
  const urls = [];
  const hist = () => { const now = Math.floor(Date.now() / 36e5) * 3600, time = [], temperature_2m = [];
    for (let t = now - 30 * 86400; t < now + 86400; t += 3600) { time.push(t); temperature_2m.push(now - t > 7 * 86400 ? 80 : 60); }
    return { hourly: { time, temperature_2m } }; };
  const reply = url => { urls.push(url); const n = new URL(url).searchParams.get("latitude").split(",").length;
    const one = url.includes("past_days=30") ? hist : openMeteo; return n > 1 ? Array.from({ length: n }, one) : one(); };
  const a = { ...lake, water: "reservoir" }, b = { ...lake, lat: 35, water: "reservoir" };
  const real = globalThis.fetch;
  globalThis.fetch = async url => ({ ok: true, status: 200, json: async () => reply(url) });
  try {
    const [ca, cb] = await E.loadLiveMany([a, b]);
    assert.strictEqual(urls.length, 2, "one forecast request and one history request for both spots");
    assert.ok(ca.airHist && cb.airHist);
    assert.ok(ca.waterEst > 61, `warm weeks before the last one still count for a reservoir: ${ca.waterEst}`);
    assert.ok(ca.hours.length <= 10 * 24, "the stored forecast stays a week of history plus 3 days");
    urls.length = 0;
    const again = await E.loadLive(a, ca);
    assert.strictEqual(urls.length, 1, "history isn't fetched again within 12 hours");
    assert.strictEqual(again.waterEst, ca.waterEst);
  } finally { globalThis.fetch = real; }
});

test("species offered match the area: no northern pike around Searcy, but up north", () => {
  assert.ok(!E.livesAt("pike", 35.25) && E.livesAt("pike", 45) && E.livesAt("pike", null));
  assert.ok(E.livesAt("lmb", 35.25) && E.livesAt("trout", 35.25));
  for (const k of ["spotted", "whitebass", "hybrid", "lstriper", "rockbass", "drum"]) assert.ok(E.livesAt(k, 35.25), k);
  assert.ok(!E.livesAt("spotted", 46.5), "no spotted bass in Minnesota");
  // Every new species has a phase (tips and baits) for every temperature and season.
  for (const k of ["spotted", "whitebass", "hybrid", "lstriper", "rockbass", "drum"]) for (let water = 34; water <= 92; water += 2)
    for (const season of ["warming", "summer", "cooling"]) {
      const p = E.phaseOf(E.SPECIES[k], water, season);
      assert.ok(p && p.baits.length && p.where, `${k} ${water}°F ${season}`);
    }
  assert.ok(!E.speciesFor({ water: "lake", lat: 35.25 }).includes("pike"));
  assert.deepStrictEqual(E.speciesFor({ water: "lake", lat: 35.25, species: ["pike"] }), ["pike"], "a spot's own picks are kept");
});

test("a tailwater stays cold and steady instead of following the air, and readings still tune it", () => {
  const apr = E.tailwaterEstimate(Date.UTC(2026, 3, 20)), oct = E.tailwaterEstimate(Date.UTC(2026, 9, 20));
  assert.ok(apr >= 48 && apr <= 50 && oct >= 54 && oct <= 56, `${apr} ${oct}`);
  const cond = { mode: "live", gauge: null, waterEst: 55, waterEsts: { tail: 55 } };
  const spot = { water: "tailwater", cal: [{ t: Date.now() - 5 * 864e5, water: 52, est: { tail: 55, 7: 70 } }] };
  assert.strictEqual(E.waterOf(spot, cond).v, 52);
  assert.ok(E.conditionTips(E.buildCtx({ ...lake, water: "tailwater" }, E.manualCond(base), "trout")).some(t => /release schedule/.test(t.title)));
});

test("a reading follows the weather after you enter it, and hands over to the estimate without a jump", () => {
  const day = 864e5, at = Date.now() - 1.5 * day;
  const spot = { water: "pond", reading: { water: 62, at, waterAt: at }, cal: [{ t: at, water: 62, est: { 1.5: 60, 2.5: 60, 4: 60, 7: 60, 10: 60, 14: 60 } }] };
  const cooler = { mode: "live", gauge: null, waterEst: 56, waterEsts: { 1.5: 55, 2.5: 56, 4: 57, 7: 58, 10: 59, 14: 59 } };
  const w = E.waterOf(spot, cooler);
  assert.strictEqual(w.v, 58, "62 entered, the estimate has cooled 4° since, so 58");
  assert.strictEqual(w.change, -4); assert.match(w.src, /your reading/);
  // Right after the 3 days, the calibrated estimate gives the same value.
  const later = { ...spot, reading: { ...spot.reading, waterAt: at - 2 * day, at: at - 2 * day }, cal: [{ ...spot.cal[0], t: at - 2 * day }] };
  assert.strictEqual(E.waterOf(later, cooler).v, 58);
  // No forecast (offline, typed-in conditions): the reading is used as entered.
  assert.strictEqual(E.waterOf(spot, { mode: "manual", waterEst: 70 }).v, 62);
});

test("the water temperature is projected through the forecast, so a cold front cools the later days", () => {
  const now = Math.floor(Date.now() / 36e5) * 36e5, hours = [];
  // A week at 75°F, then a front drops the air to 45°F from tomorrow on.
  for (let i = -168; i < 72; i++) hours.push({ t: now + i * 36e5, air: i < 24 ? 75 : 45, pres: 30, wind: 6, dir: 180, gust: 10, cloud: 50, precip: 0, code: 2 });
  const cond = { mode: "live", tz: -18000, fetchedAt: Date.now(), gauge: null, hours: E.deriveHours(hours) };
  cond.waterEst = E.waterEstimate(hours, now, "pond"); cond.waterEsts = E.waterEstimates(hours, now);
  const pond = { lat: 35.25, lon: -91.74, water: "pond", species: ["lmb"] };
  const ctx = E.buildCtx(pond, cond, "lmb"), w = ctx.water.v;
  assert.strictEqual(ctx.waterAt(now), w, "now is today's value");
  assert.strictEqual(ctx.waterAt(now + 12 * 36e5), w, "no change before the front");
  assert.ok(ctx.waterAt(now + 60 * 36e5) < w - 5, `cooled from ${w} to ${ctx.waterAt(now + 60 * 36e5)}`);
  // A reservoir cools more slowly than a pond.
  const res = E.buildCtx({ ...pond, water: "reservoir" }, cond, "lmb");
  assert.ok(w - ctx.waterAt(now + 60 * 36e5) > res.water.v - res.waterAt(now + 60 * 36e5));
  // A thermometer reading moves by the same amount; typed-in conditions don't move.
  const read = E.buildCtx({ ...pond, reading: { water: 70, at: now, waterAt: now } }, cond, "lmb");
  assert.strictEqual(Math.round(read.waterAt(now + 60 * 36e5) - 70), Math.round(ctx.waterAt(now + 60 * 36e5) - w));
  const typed = ctxWith(base);
  assert.strictEqual(typed.waterAt(now + 60 * 36e5), typed.water.v);
});
