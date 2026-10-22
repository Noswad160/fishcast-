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
