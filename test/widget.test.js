// Runs widget/fishcast-widget.js against stand-ins for Scriptable's API and checks what it draws.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SCRIPT = fs.readFileSync(path.join(ROOT, "widget", "fishcast-widget.js"), "utf8");
const ENGINE = fs.readFileSync(path.join(ROOT, "engine.js"), "utf8");

function forecast() {
  const now = Math.floor(Date.now() / 3600e3) * 3600, H = { time: [], temperature_2m: [], pressure_msl: [], wind_speed_10m: [], wind_direction_10m: [], wind_gusts_10m: [], cloud_cover: [], precipitation: [], weather_code: [] };
  for (let t = now - 7 * 86400; t < now + 3 * 86400; t += 3600) {
    H.time.push(t); H.temperature_2m.push(62); H.pressure_msl.push(1016 - Math.max(0, t - now) / 3600 * 0.3); H.wind_speed_10m.push(9);
    H.wind_direction_10m.push(200); H.wind_gusts_10m.push(14); H.cloud_cover.push(60); H.precipitation.push(0); H.weather_code.push(2);
  }
  return { utc_offset_seconds: -18000, hourly: H };
}

// Minimal Scriptable world: every widget element records what was added to it.
function world({ family, param, online = true, files = {} }) {
  const out = { widget: null, presented: false };
  class Node { constructor(kind) { this.kind = kind; this.children = []; }
    addText(s) { const t = new Node("text"); t.text = s; t.centerAlignText = () => {}; this.children.push(t); return t; }
    addStack() { const s = new Node("stack"); s.layoutVertically = s.layoutHorizontally = s.centerAlignContent = s.topAlignContent = () => {}; this.children.push(s); return s; }
    addImage(img) { const i = new Node("image"); i.img = img; this.children.push(i); return i; }
    addSpacer() { this.children.push(new Node("spacer")); }
    setPadding() {} }
  class ListWidget extends Node { constructor() { super("widget"); } async presentMedium() { out.presented = true; } }
  const any = new Proxy({}, { get: () => () => ({}) });
  class Request { constructor(url) { this.url = url; }
    async loadString() {
      if (!online) throw new Error("offline");
      this.response = { statusCode: 200 };
      if (this.url.endsWith("engine.js")) return ENGINE;
      if (this.url.includes("open-meteo")) return JSON.stringify(forecast());
      if (this.url.includes("usgs")) return JSON.stringify({ value: { timeSeries: [] } });
      throw new Error("unexpected " + this.url);
    } }
  const fm = { documentsDirectory: () => "/docs", joinPath: (a, b) => a + "/" + b, fileExists: p => p === "/docs/fishcast" || p in files,
    createDirectory() {}, writeString: (p, s) => { files[p] = s; }, readString: p => files[p] };
  const draw = class { constructor() { this.ops = 0; } addPath() { this.ops++; } setStrokeColor() {} setLineWidth() {} strokePath() { this.ops++; } setFillColor() {}
    fillEllipse() { this.ops++; } fillPath() { this.ops++; } fillRect() { this.ops++; } getImage() { return { drawn: this.ops }; } };
  const g = {
    ListWidget, Request, DrawContext: draw, LinearGradient: class {}, Path: class { move() {} addLine() {} addCurve() {} closeSubpath() {} },
    Point: class {}, Size: class {}, Rect: class {},
    Color: Object.assign(class { constructor(hex, a) { this.hex = hex; this.a = a; } }, { white: () => ({ hex: "#fff" }) }),
    Font: any, Timer: { schedule: () => ({ invalidate() {} }) }, FileManager: { local: () => fm },
    args: { widgetParameter: param }, config: { runsInWidget: !!family, widgetFamily: family },
    Script: { setWidget: w => { out.widget = w; }, complete() {} },
  };
  return { g, out, files };
}
async function run(opts) {
  const { g, out, files } = world(opts);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction(...Object.keys(g), SCRIPT)(...Object.values(g));
  const texts = [], walk = n => { if (n.text) texts.push(n.text); (n.children || []).forEach(walk); };
  walk(out.widget || {});
  return { out, texts, files, widget: out.widget };
}
const PARAM = "35.25,-91.74 | Searcy | river | lmb";

test("medium widget shows the spot, score, best time, advice and conditions", async () => {
  const { texts, widget } = await run({ family: "medium", param: PARAM });
  assert.strictEqual(texts[0], "SEARCY");
  assert.ok(texts.some(t => /^\d{1,2}$/.test(t)), texts.join(" | "));
  assert.ok(texts.some(t => / bite$/.test(t)));
  assert.ok(texts.some(t => /^Best(: (this|tonight|tomorrow|midday|Sun|Mon|Tue|Wed|Thu|Fri|Sat)| now, until)/.test(t)), texts.join(" | "));
  assert.ok(texts.some(t => /largemouth bass/.test(t)));
  assert.ok(texts.some(t => /^Water \d+°F · Wind \d+ [NESW]+$/.test(t)));
  assert.ok(widget.backgroundGradient.colors.length === 3, "sky gradient");
  assert.ok(widget.children.some(function has(n) { return n.kind === "image" && n.img.drawn > 3 || (n.children || []).some(has); }), "bobber drawn");
  assert.strictEqual(widget.url, "https://noswad160.github.io/fishcast-/");
});

test("small and lock screen widgets", async () => {
  const small = await run({ family: "small", param: PARAM });
  assert.ok(!small.texts.some(t => /largemouth bass/.test(t)), "small has no headline");
  const circ = await run({ family: "accessoryCircular", param: PARAM });
  assert.ok(circ.widget.addAccessoryWidgetBackground && /^\d+$/.test(circ.texts[0]) && /^(HOT|GOOD|FAIR|SLOW)$/.test(circ.texts[1]), circ.texts.join(" | "));
  const rect = await run({ family: "accessoryRectangular", param: PARAM });
  assert.match(rect.texts[0], /^Searcy · (Hot|Good|Fair|Slow) \d+$/);
  assert.match(rect.texts[rect.texts.length - 1], /^Start: /);
  const inline = await run({ family: "accessoryInline", param: PARAM });
  assert.match(inline.texts[0], /^Searcy: (Hot|Good|Fair|Slow) bite \d+$/);
});

test("Apple Maps style coordinates work in the parameter", async () => {
  const { texts } = await run({ family: "small", param: "35.25010° N, 91.74000° W | Bald Knob | lake | crappie" });
  assert.strictEqual(texts[0], "BALD KNOB");
});

test("a bad parameter explains how to fix it", async () => {
  const { texts } = await run({ family: "small", param: "nowhere" });
  assert.ok(texts.some(t => /spot code from Fishcast/.test(t)), texts.join(" | "));
});

test("offline: uses the saved engine and forecast, and says so", async () => {
  const first = await run({ family: "small", param: PARAM });
  const again = await run({ family: "small", param: PARAM, online: false, files: first.files });
  assert.ok(again.texts.includes("offline"), again.texts.join(" | "));
  const never = await run({ family: "small", param: PARAM, online: false });
  assert.ok(never.texts.some(t => /with a connection/.test(t)), never.texts.join(" | "));
});

test("running it in the Scriptable app shows a preview", async () => {
  const { out } = await run({ family: undefined, param: PARAM });
  assert.ok(out.presented);
});
