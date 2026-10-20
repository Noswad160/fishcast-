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
