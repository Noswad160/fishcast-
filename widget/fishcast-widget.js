// Fishcast widget for Scriptable (https://scriptable.app).
// Shows the bite score for one spot on the home screen or lock screen, using the same engine as the app.
//
// Widget parameter (long-press the widget > Edit Widget > Parameter). Copy it from the app:
// Fishcast > Spots > edit a spot > Home screen widget. Format:
//   lat,lon | name | water | species      e.g.  35.25,-91.74 | Searcy | river | lmb

const APP = "https://noswad160.github.io/fishcast-/";
const EXAMPLE = "35.25,-91.74 | Searcy | river | lmb";

// ---------------------------------------------------------------- web APIs the engine expects
if (typeof globalThis.URLSearchParams === "undefined") {
  globalThis.URLSearchParams = class {
    constructor(o) { this.o = o || {}; }
    toString() { return Object.entries(this.o).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&"); }
  };
}
if (typeof globalThis.AbortController === "undefined") globalThis.AbortController = class { constructor() { this.signal = {}; } abort() {} };
if (typeof globalThis.setTimeout === "undefined") {
  globalThis.setTimeout = (fn, ms) => Timer.schedule(ms, false, fn);
  globalThis.clearTimeout = t => { try { t && t.invalidate(); } catch (e) { /* already fired */ } };
}
globalThis.fetch = async url => {
  const r = new Request(String(url));
  r.timeoutInterval = 15;
  const body = await r.loadString();
  const status = (r.response && r.response.statusCode) || 200;
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body) };
};

// ---------------------------------------------------------------- engine and forecast, cached for offline
const fm = FileManager.local(), dir = fm.joinPath(fm.documentsDirectory(), "fishcast");
if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
const cachePath = name => fm.joinPath(dir, name);
async function loadEngine() {
  const path = cachePath("engine.js");
  try {
    const code = await new Request(APP + "engine.js").loadString();
    if (code.includes("function buildCtx")) fm.writeString(path, code);
  } catch (e) { /* offline: use the saved copy */ }
  if (!fm.fileExists(path)) throw new Error("Open the widget once with a connection to download Fishcast.");
  return new Function(fm.readString(path) + "\nreturn { loadLive, buildCtx, headline, bestWindows, whenWord, fmtTime, scoreLabel, sceneOf, skyStops, fmtRange, dayWord, speciesFor, parseCoords, compass, SPECIES, WATER_TYPES };")();
}

function parseParam(E) {
  const parts = String(args.widgetParameter || EXAMPLE).split("|").map(s => s.trim());
  const c = E.parseCoords(parts[0] || "");
  if (!c) return null;
  const water = E.WATER_TYPES[parts[2]] ? parts[2] : "lake";
  const species = E.SPECIES[parts[3]] ? [parts[3]] : [];
  return { id: "widget_" + c.lat + "_" + c.lon, name: parts[1] || "My spot", lat: c.lat, lon: c.lon, water, clarity: "stained", species, structures: [] };
}

async function loadCond(E, spot) {
  const path = cachePath(spot.id.replace(/[^\w.-]/g, "_") + ".json");
  const prev = fm.fileExists(path) ? JSON.parse(fm.readString(path)) : null;
  try {
    const cond = await E.loadLive(spot, prev);
    fm.writeString(path, JSON.stringify(cond));
    return { cond, stale: false };
  } catch (e) {
    if (prev) return { cond: prev, stale: true };
    throw new Error("No connection, and no saved forecast yet.");
  }
}

// ---------------------------------------------------------------- drawing
const BAND_COLORS = { Hot: "#ff7a30", Good: "#3aa99d", Fair: "#e2b443", Slow: "#9fb4ae" };
const WHITE = Color.white(), SOFT = new Color("#ffffff", 0.74);

// The app's bobber at the waterline; pulled lower the higher the score.
function bobber(score, size) {
  const dc = new DrawContext();
  dc.size = new Size(size, size); dc.opaque = false; dc.respectScreenScale = true;
  const r = size * 0.24, cx = size / 2, water = size * 0.7, cy = size * (0.36 + Math.min(99, Math.max(1, score)) * 0.0033);
  // stem
  const stem = new Path(); stem.move(new Point(cx, cy - r - size * 0.15)); stem.addLine(new Point(cx, cy - r));
  dc.addPath(stem); dc.setStrokeColor(WHITE); dc.setLineWidth(size * 0.035); dc.strokePath();
  // body: orange top, white bottom
  dc.setFillColor(new Color("#e4560a")); dc.fillEllipse(new Rect(cx - r, cy - r, 2 * r, 2 * r));
  const k = 0.5523 * r, half = new Path();
  half.move(new Point(cx - r, cy));
  half.addCurve(new Point(cx, cy + r), new Point(cx - r, cy + k), new Point(cx - k, cy + r));
  half.addCurve(new Point(cx + r, cy), new Point(cx + k, cy + r), new Point(cx + r, cy + k));
  half.closeSubpath();
  dc.addPath(half); dc.setFillColor(WHITE); dc.fillPath();
  // water over the lower part, and the waterline
  dc.setFillColor(new Color("#072a27", 0.55)); dc.fillRect(new Rect(size * 0.08, water, size * 0.84, size - water));
  const line = new Path(); line.move(new Point(size * 0.04, water)); line.addLine(new Point(size * 0.96, water));
  dc.addPath(line); dc.setStrokeColor(new Color("#ffffff", 0.6)); dc.setLineWidth(size * 0.02); dc.strokePath();
  return dc.getImage();
}

function text(stack, s, font, color = WHITE, lines = 1) {
  const t = stack.addText(s); t.font = font; t.textColor = color; t.lineLimit = lines; t.minimumScaleFactor = 0.7;
  return t;
}
function dot(stack, color) {
  const d = stack.addStack(); d.size = new Size(8, 8); d.cornerRadius = 4; d.backgroundColor = new Color(color);
  return d;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function nextWindowText(E, ctx) {
  const w = E.bestWindows(ctx.future, ctx.astro).find(x => x.best);
  if (!w) return "";
  return w.start <= Date.now() ? `Best now, until ${E.fmtTime(w.end, ctx.tz)}` : `Best: ${E.whenWord(w, ctx.tz)}`;
}

function buildWidget(E, spot, ctx, stale) {
  const family = config.widgetFamily || "medium";
  const score = ctx.now.score, label = E.scoreLabel(score), when = nextWindowText(E, ctx);
  const w = new ListWidget();
  w.url = APP;
  w.refreshAfterDate = new Date(Date.now() + 30 * 60e3);

  if (family === "accessoryInline") {
    text(w, `${spot.name}: ${label} bite ${score}`, Font.semiboldSystemFont(12));
    return w;
  }
  if (family === "accessoryCircular") {
    w.addAccessoryWidgetBackground = true;
    const s = w.addStack(); s.layoutVertically(); s.centerAlignContent();
    text(s, String(score), Font.heavyRoundedSystemFont(20)).centerAlignText();
    text(s, label.toUpperCase(), Font.boldSystemFont(8)).centerAlignText();
    return w;
  }
  if (family === "accessoryRectangular") {
    text(w, `${spot.name} · ${label} ${score}`, Font.boldSystemFont(13));
    if (when) text(w, when, Font.systemFont(12));
    text(w, `Start: ${ctx.phase.baits[0].replace(/\s*\(.*\)$/, "")}`, Font.systemFont(11), WHITE, 1);
    return w;
  }

  // Home screen: the sky at the spot right now, as in the app.
  const stops = E.skyStops(E.sceneOf(spot, ctx.cond));
  const g = new LinearGradient(); g.colors = stops.map(c => new Color(c)); g.locations = [0, 0.45, 1]; w.backgroundGradient = g;
  w.setPadding(12, 14, 12, 14);

  const head = w.addStack(); head.centerAlignContent();
  text(head, spot.name.toUpperCase(), Font.boldSystemFont(11), SOFT);
  head.addSpacer();
  if (stale) text(head, "offline", Font.systemFont(10), SOFT);

  const body = w.addStack(); body.layoutHorizontally(); body.topAlignContent();
  const left = body.addStack(); left.layoutVertically();
  const row = left.addStack(); row.centerAlignContent();
  const img = row.addImage(bobber(score, 46)); img.imageSize = new Size(46, 46);
  row.addSpacer(4);
  text(row, String(score), Font.heavyRoundedSystemFont(40));
  const pill = left.addStack(); pill.centerAlignContent(); pill.spacing = 5;
  dot(pill, BAND_COLORS[label]);
  text(pill, `${label} bite`, Font.boldSystemFont(13));
  left.addSpacer(4);
  if (when) text(left, when, Font.mediumSystemFont(12), SOFT);

  if (family !== "small") {
    body.addSpacer(12);
    const right = body.addStack(); right.layoutVertically();
    text(right, E.headline(ctx), Font.semiboldSystemFont(13), WHITE, family === "medium" ? 4 : 6);
    right.addSpacer(6);
    const h = ctx.h;
    text(right, `Water ${ctx.water.v}°F · Wind ${Math.round(h.wind)} ${E.compass(h.dir)}`, Font.systemFont(11), SOFT);
  }
  w.addSpacer();
  return w;
}

function errorWidget(message) {
  const w = new ListWidget();
  const g = new LinearGradient(); g.colors = [new Color("#1d6f86"), new Color("#0f5c56")]; g.locations = [0, 1]; w.backgroundGradient = g;
  text(w, "FISHCAST", Font.boldSystemFont(11), SOFT);
  w.addSpacer(4);
  text(w, message, Font.systemFont(12), WHITE, 5);
  w.url = APP;
  return w;
}

// ---------------------------------------------------------------- run
let widget;
try {
  const E = await loadEngine();
  const spot = parseParam(E);
  if (!spot) throw new Error("Set the widget parameter to a spot code from Fishcast (Spots > edit spot > Home screen widget).");
  const { cond, stale } = await loadCond(E, spot);
  const ctx = E.buildCtx(spot, cond, spot.species[0]);
  widget = buildWidget(E, spot, ctx, stale);
} catch (e) {
  widget = errorWidget(e.message || String(e));
}
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
