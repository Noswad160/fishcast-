"use strict";
/* Fishcast UI: storage, conditions cache, screens, bottom sheets. Forecast logic lives in engine.js. */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = p => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch (e) { /* not supported */ } };

/* ---------------------------------------------------------------- storage (this device only) */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};
const DATA_KEY = "fishcast.v1";
const Store = {
  items: LS.get(DATA_KEY, {}) || {},
  list(kind) { return Object.entries(this.items).filter(([, v]) => v && v.kind === kind).map(([id, v]) => ({ ...v, id })); },
  put(id, obj) { const clean = JSON.parse(JSON.stringify(obj)); delete clean.id; this.items[id] = clean; this.save(); },
  del(id) { delete this.items[id]; this.save(); },
  save() { if (!LS.set(DATA_KEY, this.items)) toast("Couldn't save on this device. Storage may be full or blocked."); },
};

/* ---------------------------------------------------------------- examples (shown until you add a spot) */
const EXAMPLE_SPOT = { id: "example", example: true, kind: "spot", name: "Lake Guntersville (example)", lat: 34.42, lon: -86.23, water: "reservoir", clarity: "stained", structures: ["grass", "points", "docks", "dropoff"], species: ["lmb", "crappie"], notes: "" };
function exampleCatches() {
  const now = Date.now(), d = 864e5;
  const mk = (ago, species, lure, len, s) => ({ id: "ex" + ago, example: true, kind: "catch", spotId: "example", t: now - ago * d, species, lure, length: len, depth: "", notes: "", count: 1, snap: s });
  return [
    mk(3, "lmb", "Chatterbait", 17, { water: 66, trend: "falling", sky: "overcast", windCat: "breezy", light: "dawn", solunar: "minor", clarity: "stained" }),
    mk(5, "lmb", "Lipless crankbait", 15, { water: 68, trend: "falling", sky: "partly", windCat: "breezy", light: "day", solunar: "", clarity: "stained" }),
    mk(9, "lmb", "Texas-rig creature bait", 19, { water: 70, trend: "post-front", sky: "sunny", windCat: "calm", light: "day", solunar: "major", clarity: "stained" }),
    mk(12, "crappie", "1/16 oz jig", 12, { water: 71, trend: "steady", sky: "overcast", windCat: "calm", light: "dusk", solunar: "", clarity: "clear" }),
    mk(15, "lmb", "Chatterbait", 16, { water: 72, trend: "falling", sky: "overcast", windCat: "breezy", light: "day", solunar: "", clarity: "stained" }),
  ];
}

/* ---------------------------------------------------------------- state */
const S = {
  tab: LS.get("fishcast.tab", "today"), spotId: LS.get("fishcast.spot", null), speciesId: LS.get("fishcast.species", null),
  manual: LS.get("fishcast.manual", { air: 68, water: 64, wind: 8, windDir: "SW", sky: "partly", trend: "steady" }),
  spotsMode: LS.get("fishcast.spotsMode", "list"),
  conds: {}, loading: {}, errors: {}, tried: {}, warming: false,
};
const ownSpots = () => Store.list("spot").sort((a, b) => a.name.localeCompare(b.name));
const spots = () => { const own = ownSpots(); return own.length ? own : [EXAMPLE_SPOT]; };
const entries = () => { const own = Store.list("catch"); return ownSpots().length ? own : own.concat(exampleCatches()); };
const curSpot = () => { const all = spots(); return all.find(s => s.id === S.spotId) || all[0]; };
const curSpecies = spot => { const l = speciesFor(spot); return l.includes(S.speciesId) ? S.speciesId : l[0]; };
function remember() { LS.set("fishcast.tab", S.tab); LS.set("fishcast.spot", S.spotId); LS.set("fishcast.species", S.speciesId); }

/* ---------------------------------------------------------------- conditions, cached per spot */
const FRESH_MS = 30 * 60e3;
function cachedCond(id) {
  if (S.conds[id]) return S.conds[id];
  const c = LS.get("fishcast.cond." + id, null);
  if (c && c.hours) S.conds[id] = c;
  return S.conds[id] || null;
}
const isFresh = c => c && c.mode === "live" && Date.now() - c.fetchedAt < FRESH_MS;
function ensureCond(spot, force) {
  const c = cachedCond(spot.id);
  if (!force && isFresh(c)) return Promise.resolve(c);
  if (S.loading[spot.id]) return S.loading[spot.id];
  S.tried[spot.id] = Date.now();
  const p = (async () => {
    try {
      const live = await loadLive(spot);
      S.conds[spot.id] = live; S.errors[spot.id] = "";
      if (!spot.example) LS.set("fishcast.cond." + spot.id, live);
      return live;
    } catch (e) {
      S.errors[spot.id] = navigator.onLine === false ? "You're offline." : "Couldn't reach the weather service.";
      if (c && c.mode === "live") return c; // an older forecast beats none
      return (S.conds[spot.id] = manualCond(S.manual));
    } finally { delete S.loading[spot.id]; }
  })();
  S.loading[spot.id] = p;
  return p;
}
function refreshCurrent(force) {
  const spot = curSpot();
  if (!force && (isFresh(cachedCond(spot.id)) || S.loading[spot.id] || Date.now() - (S.tried[spot.id] || 0) < 60e3)) return;
  ensureCond(spot, force).then(render);
  $("#refreshBtn").classList.add("spin");
}
// Load forecasts for every spot, one at a time, so the Spots tab can rank them.
async function warmSpots() {
  if (S.warming) return; S.warming = true;
  try {
    for (const s of spots()) {
      if (isFresh(cachedCond(s.id)) || Date.now() - (S.tried[s.id] || 0) < 60e3) continue;
      await ensureCond(s);
      if (S.tab === "spots") render();
    }
  } finally { S.warming = false; }
}

/* ---------------------------------------------------------------- trips */
const trips = () => Store.list("trip");
const activeTrip = () => trips().find(t => !t.end) || null;
const tripCatches = t => Store.list("catch").filter(c => c.tripId === t.id);
const fishIn = list => list.reduce((a, c) => a + (c.count || 1), 0);
const fmtDur = ms => { const m = Math.max(0, Math.round(ms / 60e3)); return m < 60 ? m + " min" : Math.floor(m / 60) + " h" + (m % 60 ? " " + (m % 60) + " min" : ""); };
function tripBar(spot) {
  const t = activeTrip();
  if (t && t.spotId === spot.id) {
    const long = Date.now() - t.start > 10 * 36e5;
    return `<section class="tripbar on" aria-label="Trip in progress"><div><span class="label">Trip in progress</span>
      <b><span data-elapsed>${fmtDur(Date.now() - t.start)}</span> · ${fishIn(tripCatches(t))} fish</b>${long ? `<span class="small">Still fishing? Tap End trip to set how long you fished.</span>` : ""}</div>
      <button class="btn sm accent" data-act="endTrip">End trip</button></section>`;
  }
  if (t) {
    const other = spots().find(s => s.id === t.spotId);
    return `<section class="tripbar on" aria-label="Trip in progress"><div><span class="label">Trip in progress</span><b>${esc(other ? other.name : "Another spot")} · <span data-elapsed>${fmtDur(Date.now() - t.start)}</span></b></div>
      <div class="row"><button class="btn sm ghost" data-act="openSpot" data-id="${esc(t.spotId)}">Go there</button><button class="btn sm accent" data-act="endTrip">End trip</button></div></section>`;
  }
  if (spot.example) return "";
  return `<section class="tripbar" aria-label="Start a trip"><div><b>Heading out?</b><span class="small muted">Start a trip so Fishcast can check its forecast against what you catch.</span></div>
    <button class="btn sm accent" data-act="startTrip">Start trip</button></section>`;
}
setInterval(() => { const t = activeTrip(); if (t) $$("[data-elapsed]").forEach(el => { el.textContent = fmtDur(Date.now() - t.start); }); }, 30e3);

const BAND_SCORE = { Hot: 80, Good: 65, Fair: 50, Slow: 30 };
function reportCardHtml(rc) {
  const x = n => (Math.round(n * 10) / 10).toString();
  const need = rc.need, parts = [need.trips && `${need.trips} more trip${need.trips > 1 ? "s" : ""}`, need.hours > 0 && `about ${Math.ceil(need.hours)} more hours`, need.fish && `${need.fish} more fish`].filter(Boolean);
  const early = rc.solid || rc.verdict === "learning" || rc.verdict === "one-sided" ? "" : "Early read: ";
  const msg = early + {
    learning: `Fishcast needs ${parts.join(", ")} here before it can tell whether its forecast holds up.`,
    "one-sided": `So far you've mostly fished ${rc.hi.hours < 2 ? "Fair and Slow" : "Good and Hot"} hours. Fish some ${rc.hi.hours < 2 ? "Good or Hot" : "Fair or Slow"} hours too, so there's something to compare.`,
    working: rc.lo.fish === 0 ? `The forecast is working here. All your fish came when it said Good or Hot.` : `The forecast is working here. You catch ${x(rc.ratio)}× more fish per hour when it says Good or Hot.`,
    unclear: `No clear difference yet. You catch about the same per hour whatever the score says. Keep logging trips; Fishcast will use them to tune the score for this spot.`,
    backwards: `The score has been backwards here: you catch more when it says Fair or Slow. Fishcast will use this to tune the score for this spot.`,
  }[rc.verdict];
  const max = Math.max(...BANDS.map(k => rc.bands[k].rate), 0.01);
  const rows = BANDS.filter(k => rc.bands[k].hours > 0).map(k => { const b = rc.bands[k]; return `<div class="rcrow">
      <span class="rcband"><i style="background:${scoreColor(BAND_SCORE[k])}"></i>${k}</span>
      <span class="track"><span class="fill" style="width:${Math.round(b.rate / max * 100)}%;background:${scoreColor(BAND_SCORE[k])}"></span></span>
      <span class="mono small">${x(b.rate)}/h</span><span class="small muted">${b.fish} fish · ${x(b.hours)} h</span></div>`; }).join("");
  return `<section class="card" aria-label="Forecast report card"><h3>Forecast report card</h3>
    <p class="verdict ${rc.verdict}">${esc(msg)}</p>
    ${rows ? `<div class="rc"><div class="rcrow head small muted"><span>Score said</span><span>Fish per hour</span><span></span><span></span></div>${rows}</div>` : ""}
    <p class="small muted">${rc.trips} trip${rc.trips === 1 ? "" : "s"} · ${x(rc.all.hours)} h · ${rc.all.fish} fish. Only trips you start in the app, or log as past trips, count.</p></section>`;
}

/* ---------------------------------------------------------------- small UI pieces */
let toastTimer;
function toast(msg, action) {
  const el = $("#toast"), btn = $("#toastAct");
  $("#toastMsg").textContent = msg;
  btn.hidden = !action;
  if (action) { btn.textContent = action.label; btn.onclick = () => { el.hidden = true; action.fn(); }; }
  el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3000);
}
let sheetReturn = null;
function openSheet(html) {
  sheetReturn = document.activeElement;
  $("#sheetBody").innerHTML = html;
  $("#sheet").hidden = false; document.body.classList.add("locked");
  const panel = $("#sheet .panel"); panel.scrollTop = 0; panel.setAttribute("tabindex", "-1"); panel.focus({ preventScroll: true });
}
function closeSheet() {
  $("#sheet").hidden = true; document.body.classList.remove("locked"); $("#sheetBody").innerHTML = "";
  if (sheetReturn && sheetReturn.focus) sheetReturn.focus({ preventScroll: true });
}
// iOS Safari ignores overflow:hidden on the body for touch scrolling, so while a sheet is open, stop any
// finger scroll that would move the page behind: outside the sheet always, inside it once it hits an edge.
(function lockBackground() {
  let lastY = 0;
  document.addEventListener("touchstart", e => { lastY = e.touches[0].clientY; }, { passive: true });
  document.addEventListener("touchmove", e => {
    if ($("#sheet").hidden) return;
    const y = e.touches[0].clientY, down = y > lastY; lastY = y;
    const panel = e.target.closest("#sheet .panel");
    if (!panel) { e.preventDefault(); return; }
    const atTop = panel.scrollTop <= 0, atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;
    if ((atTop && down) || (atBottom && !down)) e.preventDefault();
  }, { passive: false });
})();

// Swipe a sheet down to close it: drag from the handle, or from anywhere once the sheet is scrolled to the top.
(function sheetSwipe() {
  const panel = $("#sheet .panel"), scrim = $("#sheet .scrim"), EASE = "cubic-bezier(.2, .8, .2, 1)";
  let startY = 0, offset = 0, dy = 0, h = 1, tracking = false, dragging = false, samples = [], frame = 0;
  // Writes happen once per screen refresh, and nothing is measured mid-drag, so the phone only slides a layer.
  const paint = () => { frame = 0; panel.style.transform = `translate3d(0, ${dy}px, 0)`; scrim.style.opacity = String(Math.max(0, 1 - dy / h)); };
  const settle = (to, ms, done) => {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    panel.style.transition = `transform ${ms}ms ${EASE}`; scrim.style.transition = `opacity ${ms}ms ${EASE}`;
    panel.style.transform = to; scrim.style.opacity = to ? "0" : "";
    setTimeout(() => { done && done(); panel.classList.remove("dragging"); panel.style.transition = panel.style.transform = scrim.style.transition = scrim.style.opacity = ""; }, ms);
  };
  panel.addEventListener("touchstart", e => {
    tracking = e.touches.length === 1 && (panel.scrollTop <= 0 || !!e.target.closest(".grab"));
    dragging = false; dy = 0; startY = e.touches[0].clientY; samples = [];
  }, { passive: true });
  panel.addEventListener("touchmove", e => {
    if (!tracking) return;
    const d = e.touches[0].clientY - startY;
    if (!dragging) {
      if (d < -4) { tracking = false; return; } // scrolling up: let the sheet scroll
      if (d < 6) return;
      dragging = true; offset = d; h = panel.offsetHeight || 1; // measure once, and start from the finger without a jump
      panel.classList.add("dragging"); panel.style.transition = scrim.style.transition = "none";
    }
    e.preventDefault();
    dy = Math.max(0, d - offset);
    const now = performance.now(); samples.push([now, dy]); while (samples.length > 2 && now - samples[0][0] > 100) samples.shift();
    if (!frame) frame = requestAnimationFrame(paint);
  }, { passive: false });
  const end = () => {
    tracking = false;
    if (!dragging) return;
    dragging = false;
    // Speed over the last ~100 ms, like iOS: a quick flick closes even if the drag was short.
    const [t0, y0] = samples[0] || [0, 0], dt = performance.now() - t0, v = dt > 0 && dt < 250 ? (dy - y0) / dt : 0;
    if (v > 0.5 || dy > Math.min(160, h * 0.25)) {
      const ms = Math.round(Math.min(280, Math.max(140, (h - dy) / Math.max(v, 1.4)))); // faster flicks finish faster
      settle(`translate3d(0, ${h}px, 0)`, ms, closeSheet);
    } else settle("", 220);
  };
  panel.addEventListener("touchend", end);
  panel.addEventListener("touchcancel", end);
})();
const chip = (type, name, value, label, checked) => `<label class="chip"><input type="${type}" name="${name}" value="${esc(value)}"${checked ? " checked" : ""}>${esc(label)}</label>`;
const stepper = (id, value, step, min) => `<span class="stepper"><button type="button" data-act="step" data-for="${id}" data-d="-${step}" aria-label="Less">−</button><input type="number" id="${id}" value="${esc(value)}" step="${step}" min="${min}" inputmode="decimal"><button type="button" data-act="step" data-for="${id}" data-d="${step}" aria-label="More">+</button></span>`;
const ICON_PIN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`;
const ICON_MAP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>`;
// Words people use, for the values saved with each catch.
const LABELS = {
  light: { dawn: "Dawn", day: "Daytime", dusk: "Dusk", night: "Night" },
  trend: { falling: "Falling", steady: "Steady", rising: "Rising", "post-front": "After a front" },
  sky: { sunny: "Sunny", partly: "Partly cloudy", overcast: "Overcast", rain: "Rain" },
  solunar: { major: "Major period", minor: "Minor period", "": "Outside periods" },
};
const ICON_EDIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>`;
const bars = rows => `<div class="bars">${rows.slice(0, 5).map(([k, n]) => `<div class="bar"><span>${esc(k)}</span><span class="track"><span class="fill" style="width:${Math.round(n / rows[0][1] * 100)}%"></span></span><span class="n">${n}</span></div>`).join("")}</div>`;
function tally(list, key) {
  const m = new Map();
  for (const e of list) { const k = typeof key === "function" ? key(e) : e[key]; if (!k) continue; m.set(k, (m.get(k) || 0) + (e.count || 1)); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
const titleCase = s => String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/, (\w\w)\.?$/, (m, st) => ", " + st.toUpperCase());
const ago = ms => { const m = Math.round((Date.now() - ms) / 60e3); return m < 2 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago"; };

/* ---------------------------------------------------------------- scene: the water band shows the sky at the spot */
// [top, middle, bottom] of the band for each sky and weather. Every stop keeps white text above 4.5:1 contrast.
const DAY = {
  clear: ["#1d6f86", "#17677a", "#0f5c56"], partly: ["#2d6878", "#1f5f6a", "#0f5652"], cloudy: ["#4b5d64", "#355a5c", "#1f4f4b"],
  rain: ["#3b4b54", "#2c4b4f", "#1b4542"], fog: ["#526365", "#43595b", "#2f5452"], snow: ["#566c77", "#43636a", "#2a5458"], storm: ["#29333d", "#233a3e", "#163a37"],
};
const SKIES = {
  dawn: { clear: ["#5e3a63", "#9c5140", "#0f5c56"], partly: ["#5d4466", "#8e5547", "#0f5652"] },
  dusk: { clear: ["#33285a", "#8e4436", "#0c4a47"], partly: ["#3a3159", "#7d4a3e", "#0c4744"] },
  night: { clear: ["#08142b", "#0a2236", "#0a3532"], partly: ["#0e1a2d", "#0f2633", "#0b3431"] },
};
const DIM = { dawn: 0.18, dusk: 0.3, night: 0.58 };
const mix = (hex, amt) => "#" + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amt)).toString(16).padStart(2, "0")).join("");
function applyScene() {
  const spot = curSpot(), { sky, wx } = sceneOf(spot, cachedCond(spot.id));
  const stops = (SKIES[sky] && SKIES[sky][wx]) || DAY[wx].map(c => sky === "day" ? c : mix(c, DIM[sky]));
  const root = document.documentElement;
  if (root.dataset.sky === sky && root.dataset.wx === wx) return;
  root.dataset.sky = sky; root.dataset.wx = wx;
  root.style.setProperty("--sky-top", stops[0]); root.style.setProperty("--sky-mid", stops[1]); root.style.setProperty("--band", stops[2]);
  $$('meta[name="theme-color"]').forEach(m => m.setAttribute("content", stops[0]));
}
setInterval(applyScene, 5 * 60e3);

/* ---------------------------------------------------------------- render */
const view = $("#view");
function render() {
  const spot = curSpot();
  $("#spotName").textContent = spot.name;
  $$(".navbtn").forEach(b => b.dataset.tab === S.tab ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  $("#fab").hidden = S.tab === "spots";
  $("#refreshBtn").classList.toggle("spin", !!S.loading[spot.id]);
  if (!(S.tab === "spots" && S.spotsMode === "map")) { dropSpotsMap(); delete view.dataset.screen; }
  // Redrawing resets sideways-scrolling rows (species chips, best times); keep them where they were.
  const rows = $$(".chipbar, .hscroll").map(el => [el.className, el.scrollLeft]);
  if (S.tab === "spots") renderSpots(); else if (S.tab === "log") renderLog(); else renderToday();
  applyScene();
  for (const [cls, left] of rows) { const el = view.querySelector("." + cls.split(" ")[0]); if (el) el.scrollLeft = left; }
  revealSelectedChip();
}
// Make sure the selected species chip is fully on screen.
function revealSelectedChip() {
  const bar = view.querySelector(".chipbar"), sel = bar && bar.querySelector('[aria-pressed="true"]');
  if (!sel) return;
  const pad = 16, left = sel.offsetLeft - bar.offsetLeft, right = left + sel.offsetWidth;
  if (left - pad < bar.scrollLeft) bar.scrollLeft = Math.max(0, left - pad);
  else if (right + pad > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right + pad - bar.clientWidth;
}

// The icon's bobber at the waterline. The higher the score, the further it's pulled under.
function bobberSvg(score) {
  const r = 30, cx = 62, water = 84, cy = Math.round(42 + Math.min(99, Math.max(1, score)) * 0.4);
  return `<svg class="bobber" viewBox="0 0 124 124" role="img" aria-label="Bite score ${score} out of 100">
    <ellipse class="ripple" cx="${cx}" cy="${water}" rx="46" ry="7" fill="none" stroke="var(--band-ink)" stroke-opacity=".35" stroke-width="1.5"/>
    <g class="float">
      <path d="M${cx} ${cy - r - 20}v20" stroke="var(--band-ink)" stroke-width="4" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--foam)"/>
      <path d="M${cx - r} ${cy}a${r} ${r} 0 0 1 ${2 * r} 0z" fill="var(--accent)"/>
      <path d="M${cx - r} ${cy}h${2 * r}" stroke="var(--band-deep)" stroke-opacity=".25" stroke-width="2"/>
    </g>
    <defs><linearGradient id="bobberWater" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" style="stop-color:var(--band-deep);stop-opacity:0"/><stop offset=".22" style="stop-color:var(--band-deep);stop-opacity:.7"/>
      <stop offset=".78" style="stop-color:var(--band-deep);stop-opacity:.7"/><stop offset="1" style="stop-color:var(--band-deep);stop-opacity:0"/></linearGradient></defs>
    <rect x="0" y="${water}" width="124" height="${124 - water}" fill="url(#bobberWater)"/>
    <path d="M0 ${water}q15.5 -5 31 0t31 0t31 0t31 0" fill="none" stroke="var(--band-ink)" stroke-opacity=".55" stroke-width="2"/>
  </svg>`;
}
const WAVE = `<svg class="wave" viewBox="0 0 400 16" preserveAspectRatio="none" aria-hidden="true"><path d="M0 0h400v6c-25 0-25 9-50 9s-25-9-50-9-25 9-50 9-25-9-50-9-25 9-50 9-25-9-50-9-25 9-50 9-25-9-50-9z" fill="var(--band)"/></svg>`;
const waterband = inner => `<section class="waterband">${inner}${WAVE}</section>`;
const ic = (body, extra = "") => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;
const ICONS = {
  thermo: ic('<path d="M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0z"/><path d="M12 9v7"/><path d="M3 20c2 0 2-1.5 4-1.5S9 20 11 20" opacity=".6"/>'),
  sunny: ic('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  partly: ic('<path d="M8 3v1.5M3.5 8H5M4.8 4.8l1 1M12.2 4.8l-1 1"/><path d="M5.6 10.5A3.5 3.5 0 1 1 11.6 7"/><path d="M8 20h9a4 4 0 0 0 0-8 5 5 0 0 0-9.6 1.5A3.3 3.3 0 0 0 8 20z"/>'),
  overcast: ic('<path d="M7 19h10a4.5 4.5 0 0 0 .4-9 6 6 0 0 0-11.6 1.6A3.8 3.8 0 0 0 7 19z"/>'),
  rain: ic('<path d="M7 15h10a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.6A3.3 3.3 0 0 0 7 15z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>'),
  sunrise: ic('<path d="M4 18h16M7 14a5 5 0 0 1 10 0"/><path d="M12 3v5M9.5 5.5 12 3l2.5 2.5"/><path d="M3 21h18" opacity=".6"/>'),
};
// Arrow points the way the wind is blowing (it comes FROM the compass direction).
const windIcon = deg => ic('<path d="M12 4v15M7 14l5 5 5-5"/>', ` style="transform:rotate(${Math.round(deg)}deg)"`);
const gaugeIcon = trend => { const a = trend <= -0.03 ? -50 : trend >= 0.03 ? 50 : 0;
  return ic(`<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l${(Math.sin(a * Math.PI / 180) * 6).toFixed(1)} ${(-Math.cos(a * Math.PI / 180) * 6).toFixed(1)}"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/>`); };
// The moon as it looks tonight: lit side on the right while waxing, on the left while waning.
function moonIcon(phase, fraction) {
  const r = 8, waxing = phase < 0.5, rx = Math.abs(2 * fraction - 1) * r;
  const lit = `M12 ${12 - r}A${r} ${r} 0 0 ${waxing ? 1 : 0} 12 ${12 + r}A${rx.toFixed(2)} ${r} 0 0 ${waxing === fraction > 0.5 ? 1 : 0} 12 ${12 - r}z`;
  return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="${r}" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width="1.5"/><path d="${lit}" fill="currentColor"/></svg>`;
}
function chartSvg(ctx) {
  const data = ctx.future, n = data.length, W = 10, gap = 2, top = 18, H = 100, base = top + H, w = n * (W + gap) + 30;
  let s = `<svg viewBox="0 0 ${w} ${base + 34}" role="img" aria-label="Hourly bite score for the next 48 hours">`;
  [25, 50, 75].forEach(v => { const y = base - v / 100 * H; s += `<line x1="26" x2="${w}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/><text x="22" y="${y + 3}" font-size="8" text-anchor="end" fill="var(--muted)" font-family="IBM Plex Mono, monospace">${v}</text>`; });
  data.forEach((d, i) => {
    const x = 30 + i * (W + gap), hgt = Math.max(2, d.score / 100 * H), hr = new Date(d.t + ctx.tz * 1000).getUTCHours();
    if (d.light === "night") s += `<rect x="${x - 1}" y="${top}" width="${W + gap}" height="${H}" fill="var(--water-soft)" opacity=".55"/>`;
    s += `<rect x="${x}" y="${base - hgt}" width="${W}" height="${hgt}" rx="2" fill="${scoreColor(d.score)}"><title>${fmtDay(d.t, ctx.tz)} ${fmtHour(d.t, ctx.tz)}: ${d.score} (${scoreLabel(d.score)})</title></rect>`;
    if (d.sol) s += `<circle cx="${x + W / 2}" cy="${top - 8}" r="${d.sol === "major" ? 3.5 : 2.2}" fill="var(--ink)"/>`;
    if (hr % 6 === 0) s += `<text x="${x + W / 2}" y="${base + 12}" font-size="8.5" text-anchor="middle" fill="var(--muted)" font-family="IBM Plex Mono, monospace">${fmtHour(d.t, ctx.tz)}</text>`;
    if (i === 0 || (hr === 0 && i >= 4)) s += `<text x="${x}" y="${base + 26}" font-size="9" fill="var(--ink)" font-family="Barlow Condensed, sans-serif" font-weight="600">${i === 0 ? "NOW" : fmtDay(d.t, ctx.tz).toUpperCase()}</text>`;
    if (hr === 0 && i) s += `<line x1="${x - 1}" x2="${x - 1}" y1="${top - 12}" y2="${base + 16}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 2"/>`;
  });
  s += `<rect x="29" y="${top - 1}" width="${W + 2}" height="${H + 2}" fill="none" stroke="var(--ink)" stroke-width="1.2" rx="2"/>`;
  return s + "</svg>";
}

function renderToday() {
  const spot = curSpot(), cond = cachedCond(spot.id);
  refreshCurrent(false);
  const list = speciesFor(spot), spId = curSpecies(spot);
  let band = "";
  if (!ownSpots().length) band += `<section class="banner welcome"><div><span class="label">Welcome to Fishcast</span><b>Set up your own spot in about 30 seconds.</b><span class="small">Until then you're looking at an example lake and example catches.</span><div class="row"><button class="btn" data-act="newSpot">Add my spot</button></div></div></section>`;
  if (list.length > 1) band += `<div class="chipbar" role="group" aria-label="Target species">${list.map(k => `<button class="chip" data-act="species" data-id="${k}" aria-pressed="${k === spId}">${esc(SPECIES[k].name)}</button>`).join("")}</div>`;
  if (!cond) { view.innerHTML = waterband(band + `<div class="skeleton" aria-label="Loading conditions"></div>`) + tripBar(spot); return; }

  const ctx = buildCtx(spot, cond, spId), { h, sp, tz, astro, water } = ctx, now = ctx.now, err = S.errors[spot.id];
  const wins = bestWindows(ctx.future);
  const ups = now.factors.filter(f => f.v > 0).sort((a, b) => b.v - a.v), downs = now.factors.filter(f => f.v < 0).sort((a, b) => a.v - b.v);
  band += `<div class="hero" aria-label="Bite outlook">
      ${bobberSvg(now.score)}
      <div class="scorebox"><span class="label">${esc(ctx.phase.name)} · ${water.v}°F water</span>
        <span class="big">${now.score}</span><span class="pill"><i style="background:${scoreColor(now.score)}"></i>${scoreLabel(now.score)} bite</span></div>
    </div>
    <p class="headline">${esc(headline(ctx))}</p>
    <div class="factors">${ups.map(f => `<span class="factor up">+${f.v} ${esc(f.label)}</span>`).join("")}${downs.map(f => `<span class="factor down">${f.v} ${esc(f.label)}</span>`).join("")}</div>
    <button class="linkbtn small" data-act="howScore" style="padding:0;align-self:flex-start">How is this scored?</button>
    <span class="label">Best times, next 48 hours</span>
    <div class="hscroll">${wins.map(w => { const on = w.start <= Date.now() && w.end > Date.now(); return `<div class="win${on ? " now" : ""}"><span class="small muted">${on ? "Now" : (d => d.charAt(0).toUpperCase() + d.slice(1))(dayWord(w.start, tz))}</span><b>${fmtRange(w.start, w.end, tz)}</b><span class="small" style="color:${scoreColor(w.avg)}">${scoreLabel(w.avg)} · ${w.avg}</span></div>`; }).join("")}</div>`;
  let html = waterband(band) + tripBar(spot);
  if (cond.mode === "manual") html += `<section class="banner warn"><div><b>${esc(err || "Live weather isn't loaded.")} Showing conditions you entered.</b><div class="row"><button class="btn sm" data-act="manual">Edit conditions</button><button class="btn sm ghost" data-act="refresh">Try again</button></div></div></section>`;
  else if (!isFresh(cond) && !S.loading[spot.id]) html += `<section class="banner info"><div><span class="small">${err ? esc(err) + " " : ""}Forecast from ${ago(cond.fetchedAt)}.</span></div></section>`;

  const sunrise = astro.sunrise.find(t => t > Date.now() - 12 * hourMs), sunset = astro.sunset.find(t => t > Date.now() - 2 * hourMs), moon = moonIllum(Date.now());
  const est = water.src === "estimate", salt = ctx.env === "salt", tide = tideOf(spot), sky = skyCat(h);
  html += `<section class="tiles" aria-label="Conditions">
    <button class="tile${est ? " flag" : ""}" data-act="reading">${ICONS.thermo}<span class="label">Water</span><span class="v">${water.v}°F</span><span class="s">${est ? "tap to set" : esc(water.src)}</span></button>
    <div class="tile">${ICONS[sky]}<span class="label">Air</span><span class="v">${Math.round(h.air)}°F</span><span class="s">${LABELS.sky[sky].toLowerCase()}</span></div>
    <div class="tile">${windIcon(h.dir)}<span class="label">Wind</span><span class="v">${Math.round(h.wind)} ${compass(h.dir)}</span><span class="s">mph · gusts ${Math.round(h.gust)}</span></div>
    <div class="tile">${gaugeIcon(h.trend3)}<span class="label">Pressure</span><span class="v">${cond.mode === "manual" ? LABELS.trend[trendCat(h)] : h.pres.toFixed(2)}</span><span class="s">${cond.mode === "manual" ? "you entered" : (LABELS.trend[trendCat(h)] || "").toLowerCase()}</span></div>
    <div class="tile">${ICONS.sunrise}<span class="label">Sunrise</span><span class="v">${sunrise ? fmtTime(sunrise, tz) : "—"}</span><span class="s">sets ${sunset ? fmtTime(sunset, tz) : "—"}</span></div>
    <div class="tile">${moonIcon(moon.phase, moon.fraction)}<span class="label">Moon</span><span class="v">${Math.round(moon.fraction * 100)}%</span><span class="s">${moonPhaseName(moon.phase)}</span></div>
    ${salt ? `<button class="tile${tide ? "" : " flag"}" data-act="reading"><span class="label">Tide</span><span class="v">${tide ? { rising: "Incoming", falling: "Outgoing", slack: "Slack" }[tide] : "Not set"}</span><span class="s">tap to ${tide ? "change" : "set"}</span></button>` : ""}
    ${salt && ctx.wave != null ? `<div class="tile"><span class="label">Waves</span><span class="v">${ctx.wave.toFixed(1)} ft</span><span class="s">forecast</span></div>` : ""}
  </section>`;

  html += `<section class="card" aria-label="48-hour forecast"><h3>Next 48 hours</h3><div class="chart">${chartSvg(ctx)}</div>
    <div class="legend"><span><i style="background:var(--s4)"></i>Hot</span><span><i style="background:var(--s3)"></i>Good</span><span><i style="background:var(--s2)"></i>Fair</span><span><i style="background:var(--s1)"></i>Slow</span><span><i style="background:var(--water-soft)"></i>Night</span><span>● solunar</span></div></section>`;

  const tips = conditionTips(ctx), structs = (spot.structures || []).map(id => ({ id, text: structureTip(id, ctx) })).filter(x => x.text);
  const tipLi = t => `<li class="tip ${t.w >= 9 ? "hi" : t.w <= 4 ? "lo" : ""}"><div><b>${esc(t.title)}</b><span class="small">${esc(t.body)}</span></div></li>`;
  html += `<section class="card" aria-label="Game plan">
    <h3>Game plan</h3>
    <div class="phase">
      <span class="label">Where the ${esc(sp.name.toLowerCase())} are</span>
      <p>${esc(ctx.phase.where.replace("{sunShore}", spot.lat >= 0 ? "north shore" : "south shore"))}</p>
      <span class="label">What to throw</span>
      <div class="baits">${ctx.phase.baits.map(b => `<span class="bait">${esc(b)}</span>`).join("")}</div>
      <p class="small">${esc(ctx.phase.how)}</p>
    </div>
    <span class="label">Today's conditions</span>
    <ul class="tips">${tips.slice(0, 3).map(tipLi).join("")}</ul>
    ${tips.length > 3 ? `<details><summary>${tips.length - 3} more tips</summary><ul class="tips">${tips.slice(3).map(tipLi).join("")}</ul></details>` : ""}
    ${structs.length ? `<span class="label">At this spot</span><ul class="tips">${structs.map(x => `<li class="tip"><div><b>${esc(STRUCTURES[x.id].name)}</b><span class="small">${esc(x.text)}</span></div></li>`).join("")}</ul>`
      : `<button class="linkbtn" data-act="editSpot" data-id="${esc(spot.id)}">Add the structure at this spot for spot-specific tips</button>`}
  </section>`;
  html += historyCard(ctx);
  view.innerHTML = html;
}

function historyCard(ctx) {
  const spot = ctx.spot, salt = ctx.env === "salt";
  const here = entries().filter(e => e.spotId === spot.id && e.count > 0);
  const pool = here.filter(e => e.species === ctx.spId).length ? here.filter(e => e.species === ctx.spId) : here;
  const nowSnap = snapFromCtx(ctx);
  const similar = pool.map(e => ({ e, sim: similarity(nowSnap, e.snap, salt) })).filter(x => x.sim >= 0.6).sort((a, b) => b.sim - a.sim);
  let body;
  if (!here.length) body = `<p class="small muted">Log every catch, and every trip with no bites. Fishcast will show what worked here in conditions like today's.</p>`;
  else if (!similar.length) body = `<p class="small">None of your ${pool.length} catches here came in conditions like today's. Your best lures here overall:</p>${bars(tally(pool, "lure").slice(0, 3))}`;
  else {
    const top = similar[0].e;
    body = `<p class="small">${similar.length} of your catches here came in conditions like these. They hit:</p>${bars(tally(similar.map(x => x.e), "lure"))}
      <p class="small muted">Closest match: ${fmtDate(top.t, ctx.tz)}, ${top.snap.water}°F, ${esc(top.snap.trend)} pressure, ${esc(top.snap.sky)}${top.lure ? ", " + esc(top.lure) : ""}${top.depth ? ", " + esc(top.depth) + " ft" : ""}.</p>`;
  }
  const rc = reportCard(trips().filter(t => t.spotId === spot.id), Store.list("catch").filter(c => c.spotId === spot.id));
  const rcLine = (rc.solid || !["working", "backwards"].includes(rc.verdict) ? "" : "Early read: ") + (rc.verdict === "working" ? (rc.lo.fish === 0 ? "At this spot, all your trip catches came when the score said Good or Hot." : `At this spot you catch ${Math.round(rc.ratio * 10) / 10}× more fish per hour when the score says Good or Hot.`)
    : rc.verdict === "backwards" ? "At this spot the score has been backwards so far. See the report card on the Catches tab." : "");
  return `<section class="card" aria-label="Your history here"><h3>What's worked here ${spot.example ? '<span class="example">Example</span>' : ""}</h3>${["working", "backwards"].includes(rc.verdict) ? `<p class="verdict ${rc.verdict}">${esc(rcLine)}</p>` : ""}${body}</section>`;
}

function spotScore(spot) {
  const c = cachedCond(spot.id);
  if (!c) return null;
  try { return buildCtx(spot, c, curSpecies(spot)).now.score; } catch (e) { return null; }
}
function renderSpots() {
  const own = ownSpots(), list = spots().map(s => ({ s, score: spotScore(s) }));
  list.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const best = list.length > 1 && list[0].score != null && list[0].score > (list[1].score ?? -1) ? list[0].s.id : null;
  // The map keeps its own state; later renders (forecasts arriving) only refresh its pins.
  if (S.spotsMode === "map" && view.dataset.screen === "spotsmap" && spotsMap && $("#spotsMap")) { updateSpotMarkers(false); warmSpots(); return; }
  let html = waterband(`<div class="row" style="justify-content:space-between"><h2>Your spots</h2><button class="btn" data-act="newSpot">${ICON_PIN}Add spot</button></div>
    <div class="chips" role="group" aria-label="Show spots as">${[["list", "List"], ["map", "Map"]].map(([k, l]) => `<button class="chip" data-act="spotsMode" data-id="${k}" aria-pressed="${S.spotsMode === k}">${l}</button>`).join("")}</div>`);
  if (!own.length) html += `<p class="empty">You haven't added a spot yet. Add the places you fish, and Fishcast ranks them by how good the bite is right now.</p>`;
  if (S.spotsMode === "map") {
    view.innerHTML = html + `<div class="mapcard"><div id="spotsMap" class="mapbox" aria-label="Map of your spots"></div><button type="button" class="btn sm maplayer" data-act="mapLayer">${layerPref() === "satellite" ? "Map view" : "Satellite"}</button></div>
      <p class="small muted">Pins show the bite score right now. Tap one for its forecast. To add a spot, tap Add spot, then Pick on map.</p>`;
    view.dataset.screen = "spotsmap";
    showSpotsMap($("#spotsMap")); warmSpots();
    return;
  }
  html += `<div class="list">${list.map(({ s, score }) => `<div class="item${s.id === best ? " best" : ""}" style="display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center">
      <button class="spotcard" data-act="openSpot" data-id="${esc(s.id)}" style="border:0;background:none;padding:0;display:flex;flex-direction:column;gap:2px;align-items:flex-start">
        ${s.id === best ? '<span class="label" style="color:var(--accent)">Best bite right now</span>' : ""}
        <b style="font-size:1.08rem">${esc(s.name)}</b>
        <span class="small muted">${esc(WATER_TYPES[s.water]?.name || "")} · ${speciesFor(s).slice(0, 3).map(k => esc(SPECIES[k].name)).join(", ")}</span>
      </button>
      ${score == null ? `<span class="badge wait"><b>…</b></span>` : `<span class="badge" style="background:${scoreColor(score)}"><b>${score}</b><span>${scoreLabel(score)}</span></span>`}
      ${s.example ? "" : `<button class="iconbtn" data-act="editSpot" data-id="${esc(s.id)}" aria-label="Edit ${esc(s.name)}">${ICON_EDIT}</button>`}
    </div>`).join("")}</div>`;
  html += `<section class="card" aria-label="Backup"><h3>Backup</h3>
    <p class="small muted">Your spots and catches are saved only on this device. Save a backup now and then, or to move to a new phone.</p>
    <div class="row"><button class="btn ghost" data-act="export">Save backup</button><label class="btn ghost" for="importFile">Restore backup</label><input type="file" id="importFile" accept="application/json,.json" hidden></div></section>
    <p class="small muted">Weather from Open-Meteo. Scores are rules of thumb; your catch log is what makes them specific to your water.</p>`;
  view.innerHTML = html;
  warmSpots();
}

function renderLog() {
  const spot = curSpot(), tz = cachedCond(spot.id)?.tz ?? deviceTz();
  const here = entries().filter(e => e.spotId === spot.id).sort((a, b) => b.t - a.t);
  const catches = here.filter(e => e.count > 0), blanks = here.filter(e => !e.count);
  const myTrips = trips().filter(t => t.spotId === spot.id);
  let html = waterband(`<span class="label">Catches at</span><div class="row" style="justify-content:space-between;margin-top:-10px"><h2>${esc(spot.name)}</h2>${spot.example ? '<span class="example">Example</span>' : ""}</div>`);
  html += tripBar(spot);
  if (!spot.example) html += reportCardHtml(reportCard(myTrips, Store.list("catch").filter(c => c.spotId === spot.id)));
  if (!here.length && !myTrips.length) html += `<section class="card"><p>Nothing logged at ${esc(spot.name)} yet.</p><p class="small muted">Tap <b>Start trip</b> when you get to the water and <b>＋ Catch</b> when you land a fish. Times and conditions are saved automatically.</p></section>`;
  if (catches.length) {
    const total = catches.reduce((a, e) => a + (e.count || 1), 0), hrs = blanks.reduce((a, e) => a + (e.hours || 0), 0);
    const band = e => e.snap?.water == null ? "" : (Math.floor(e.snap.water / 5) * 5) + "–" + (Math.floor(e.snap.water / 5) * 5 + 4) + "°F";
    const groups = [
      ["Lure", tally(catches, "lure")],
      ["Time of day", tally(catches, e => LABELS.light[e.snap?.light])],
      ["Pressure", tally(catches, e => LABELS.trend[e.snap?.trend])],
      ["Water temp", tally(catches, band)],
      ["Sky", tally(catches, e => LABELS.sky[e.snap?.sky])],
      ["Solunar", tally(catches, e => e.snap ? LABELS.solunar[e.snap.solunar || ""] : "")],
    ].filter(([, rows]) => rows.length);
    const sec = ([title, rows]) => `<div class="field"><span class="label">${title}</span>${bars(rows)}</div>`;
    html += `<section class="card" aria-label="Patterns"><h3>What's working</h3>
      <p class="small muted">${total} fish${blanks.length ? ` · ${blanks.length} trip${blanks.length > 1 ? "s" : ""} (${hrs} h) with no bites` : ""}</p>
      <dl class="stats">${groups.slice(0, 4).map(([title, rows]) => `<div><dt class="label">${title}</dt><dd>${esc(rows[0][0])}<span class="muted small">${rows[0][1]} of ${total} fish</span></dd></div>`).join("")}</dl>
      <details><summary>All patterns</summary><div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin-top:8px">${groups.map(sec).join("")}</div></details>
    </section>`;
  }
  const history = here.concat(myTrips.filter(t => t.end).map(t => ({ ...t, isTrip: true, t: t.start }))).sort((a, b) => b.t - a.t);
  const tripItem = e => { const w = (e.hours || []).reduce((a, h) => a + h.frac, 0), avg = w ? Math.round(e.hours.reduce((a, h) => a + h.score * h.frac, 0) / w) : null, n = e.fish ?? fishIn(tripCatches(e));
    return `<div class="item trip"><div class="head"><span style="display:flex;flex-direction:column;min-width:0"><b>Trip · ${fmtDur(e.end - e.start)} · ${n} fish</b><span class="small muted">${fmtDate(e.start, tz)} · ${fmtTime(e.start, tz)}–${fmtTime(e.end, tz)}</span></span>
      <button class="iconbtn del" data-act="delTrip" data-id="${esc(e.id)}" aria-label="Delete this trip">${ICON_TRASH}</button></div>
      <span class="small">${avg == null ? "Too long ago to grade against the forecast." : `Forecast averaged <b style="color:${scoreColor(avg)}">${scoreLabel(avg)} (${avg})</b>`}${e.tried ? " · " + esc(e.tried) : ""}</span></div>`; };
  if (history.length) html += `<section class="list" aria-label="History">${history.map(e => e.isTrip ? tripItem(e) : `<div class="item">
    <div class="head"><span style="display:flex;flex-direction:column;min-width:0"><b>${e.count > 0 ? `${e.count > 1 ? e.count + " × " : ""}${esc(SPECIES[e.species]?.name || e.species)}${e.length ? ` · ${esc(e.length)} in` : ""}` : `No bites · ${esc(e.hours)} h`}</b><span class="small muted">${fmtDate(e.t, tz)} · ${fmtTime(e.t, tz)}</span></span>
      ${e.example ? "" : `<button class="iconbtn del" data-act="delEntry" data-id="${esc(e.id)}" aria-label="Delete this entry">${ICON_TRASH}</button>`}</div>
    ${e.lure || e.depth || e.notes ? `<span class="small">${[e.lure, e.depth ? e.depth + " ft" : "", e.notes].filter(Boolean).map(esc).join(" · ")}</span>` : ""}
    ${e.snap ? `<span class="small muted">${[e.snap.water + "°F water", LABELS.trend[e.snap.trend] && LABELS.trend[e.snap.trend].toLowerCase() + " pressure", LABELS.sky[e.snap.sky] && LABELS.sky[e.snap.sky].toLowerCase(), LABELS.light[e.snap.light] && LABELS.light[e.snap.light].toLowerCase(), e.snap.wind != null ? `wind ${e.snap.wind} mph ${e.snap.windDir || ""}`.trim() : ""].filter(Boolean).map(esc).join(" · ")}</span>` : ""}
  </div>`).join("")}</section>`;
  view.innerHTML = html;
}

/* ---------------------------------------------------------------- sheets */
function spotPickerSheet() {
  const cur = curSpot();
  openSheet(`<div class="body"><h3 id="sheetTitle">Choose a spot</h3><div>${spots().map(s => {
    const sc = spotScore(s);
    return `<button class="pickrow" data-act="chooseSpot" data-id="${esc(s.id)}" aria-current="${s.id === cur.id}"><span style="display:flex;flex-direction:column;min-width:0"><b>${esc(s.name)}</b><span class="small muted">${esc(WATER_TYPES[s.water]?.name || "")}</span></span>${sc == null ? "" : `<span class="badge" style="width:46px;height:46px;background:${scoreColor(sc)}"><b style="font-size:1.25rem">${sc}</b></span>`}</button>`;
  }).join("")}</div><button class="btn big ghost" data-act="newSpot">${ICON_PIN}Add a spot</button></div>`);
}

function logSheet(kind) {
  const spot = curSpot();
  if (kind === "blank") {
    const local = ms => { const d = new Date(ms); return new Date(ms - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16); };
    openSheet(`<form id="pastTripForm" novalidate><div class="sheethead"><h3 id="sheetTitle">Log a past trip</h3><span class="small muted">${esc(spot.name)}</span></div>
      <p class="small muted">For a trip you didn't start in the app. Trips from the last 7 days are graded against the forecast. Slow trips count too.</p>
      <label class="field"><span class="label">Started</span><input type="datetime-local" id="pStart" value="${local(Date.now() - 3 * 36e5)}" min="${local(Date.now() - 7 * 864e5)}" max="${local(Date.now())}"></label>
      <div class="grid2"><div class="field"><span class="label">Hours fished</span>${stepper("pHours", 2, 0.5, 0.5)}</div><div class="field"><span class="label">Fish caught</span>${stepper("pFish", 0, 1, 0)}</div></div>
      <label class="field"><span class="label">What you tried</span><input type="text" id="pTried" placeholder="Jerkbait, jig, docks and points"></label>
      <p id="pErr" class="small" style="color:var(--bad)" role="alert" hidden></p>
      <button class="btn big" type="submit">Save trip</button></form>`);
    return;
  }
  const spId = curSpecies(spot), list = Object.keys(SPECIES).filter(k => SPECIES[k].env === envOf(spot));
  const mine = speciesFor(spot), order = mine.concat(list.filter(k => !mine.includes(k)));
  const recent = [];
  for (const e of entries().filter(e => e.spotId === spot.id && e.lure).sort((a, b) => b.t - a.t)) if (!recent.includes(e.lure)) recent.push(e.lure);
  const cond = cachedCond(spot.id);
  if (recent.length < 4 && cond) for (const b of buildCtx(spot, cond, spId).phase.baits) { const short = b.replace(/\s*\(.*\)$/, "").replace(/,.*$/, ""); if (!recent.includes(short)) recent.push(short); }
  openSheet(`<form id="logForm" data-kind="catch" novalidate>
    <div class="sheethead"><h3 id="sheetTitle">Log a catch</h3><span class="small muted">${esc(spot.name)}</span></div>
    <div class="field"><span class="label">Species</span><div class="chips">${order.slice(0, mine.length + 2).map(k => chip("radio", "lSpecies", k, SPECIES[k].name, k === spId)).join("")}</div></div>
    <div class="field"><span class="label">Caught on</span><div class="chips">${recent.slice(0, 6).map(l => chip("radio", "lLure", l, l, false)).join("")}${chip("radio", "lLure", "__other", "Something else…", false)}</div>
      <input type="text" id="lLureOther" placeholder="Lure or bait, e.g. white chatterbait" hidden></div>
    <div class="grid2"><label class="field"><span class="label">Length (in)</span><input type="number" id="lLen" step="0.25" inputmode="decimal" placeholder="optional"></label>
      <div class="field"><span class="label">How many</span>${stepper("lCount", 1, 1, 1)}</div></div>
    <details><summary>Depth and notes</summary><div class="grid2" style="margin-top:8px"><label class="field"><span class="label">Depth (ft)</span><input type="number" id="lDepth" inputmode="numeric"></label>
      <label class="field"><span class="label">Notes</span><input type="text" id="lNotes" placeholder="Windy side of the point"></label></div></details>
    <button class="btn big accent" type="submit">Save catch</button>
    <button type="button" class="linkbtn" data-act="logBlank">Forgot to start a trip? Log a past trip</button>
  </form>`);
}

function endTripSheet() {
  const t = activeTrip(); if (!t) return;
  const spot = spots().find(s => s.id === t.spotId), el = Date.now() - t.start, long = el > 10 * 36e5;
  const hrs = long ? 3 : Math.max(0.25, Math.round(el / 36e5 * 4) / 4);
  openSheet(`<form id="endTripForm" novalidate><h3 id="sheetTitle">End trip</h3>
    <p class="small muted">${esc(spot ? spot.name : "")} · started ${fmtTime(t.start, deviceTz())} · ${fishIn(tripCatches(t))} fish logged</p>
    ${long ? `<p class="banner warn small">This trip has been running ${fmtDur(el)}. If you forgot to end it, set how long you actually fished.</p>` : ""}
    <div class="field"><span class="label">Hours fished</span>${stepper("tHours", hrs, 0.25, 0.25)}</div>
    <button class="btn big accent" type="submit">Save trip</button>
    <button type="button" class="linkbtn" data-act="discardTrip" style="color:var(--bad)">Discard this trip (your catches stay)</button></form>`);
}

function spotSheet(spot) {
  const s = { name: "", water: "lake", clarity: "stained", structures: [], species: [], ...(spot || {}) };
  openSheet(`<form id="spotForm" data-id="${esc(s.id || "")}" novalidate>
    <h3 id="sheetTitle">${s.id ? "Edit spot" : "Add a spot"}</h3>
    <div class="field"><span class="label">Where is it?</span>
      <div class="grid2"><button type="button" class="btn" data-act="geoloc">${ICON_PIN}I'm here now</button><button type="button" class="btn ghost" data-act="pickOnMap">${ICON_MAP}Pick on map</button></div>
      <div class="row"><input type="search" id="fSearch" placeholder="Search a lake or town" style="flex:1 1 160px"><button type="button" class="btn ghost" data-act="search">Search</button></div>
      <div id="searchOut" class="list"></div>
      <input type="text" id="fCoords" value="${s.lat != null ? esc(s.lat + ", " + s.lon) : ""}" placeholder="or paste coordinates, e.g. 34.4201, -86.2310">
      <span class="small muted" id="coordNote" role="status"></span>
    </div>
    <label class="field"><span class="label">Name</span><input type="text" id="fName" value="${esc(s.name)}" placeholder="North point, Lake Murray"></label>
    <div class="field"><span class="label">Type of water</span><div class="chips">${Object.entries(WATER_TYPES).filter(([k, v]) => v.env === "fresh" || k === s.water).map(([k, v]) => chip("radio", "fWater", k, v.name, k === s.water)).join("")}</div></div>
    <div class="field"><span class="label">What you fish for here</span><div class="chips" id="fSpeciesBox"></div></div>
    <details${s.id ? " open" : ""}><summary>Structure, clarity and notes (better tips)</summary>
      <div class="body" style="margin-top:10px">
        <div class="field"><span class="label">Structure here</span><div class="chips" id="fStructBox"></div></div>
        <div class="field"><span class="label">Usual clarity</span><div class="chips">${["clear", "stained", "muddy"].map(c => chip("radio", "fClarity", c, c, c === s.clarity)).join("")}</div></div>
        <label class="field"><span class="label">Notes</span><textarea id="fNotes" placeholder="Depths, launch, hazards">${esc(s.notes || "")}</textarea></label>
      </div></details>
    <p id="formErr" class="small" style="color:var(--bad)" role="alert" hidden></p>
    <button class="btn big" type="submit">Save spot</button>
    ${s.id ? `<div id="delArea"><button type="button" class="linkbtn" data-act="askDelSpot" style="color:var(--bad)">Delete this spot</button></div>` : ""}
  </form>`);
  fillEnvBoxes(s.species || [], s.structures || []);
}
function fillEnvBoxes(selSpecies, selStructs) {
  const env = WATER_TYPES[$('input[name="fWater"]:checked')?.value || "lake"].env;
  $("#fSpeciesBox").innerHTML = Object.entries(SPECIES).filter(([, v]) => v.env === env).map(([k, v]) => chip("checkbox", "fSpecies", k, v.name, selSpecies.includes(k))).join("");
  $("#fStructBox").innerHTML = Object.entries(STRUCTURES).filter(([, v]) => v.env === env || v.env === "both").map(([k, v]) => chip("checkbox", "fStruct", k, v.name, selStructs.includes(k))).join("");
}
const checked = name => $$(`input[name="${name}"]:checked`).map(x => x.value);

function readingSheet() {
  const spot = curSpot(), cond = cachedCond(spot.id), salt = envOf(spot) === "salt";
  const w = cond ? waterOf(spot, cond) : { v: 60, src: "estimate" }, tide = tideOf(spot), g = cond && cond.gauge, tz = cond ? cond.tz : deviceTz();
  const gaugeHtml = g ? `<div class="field"><span class="label">Nearest USGS gauge</span>
      <p class="small"><b>${esc(titleCase(g.name))}</b>, ${Math.round(g.dist)} mi away: ${g.f}°F at ${fmtTime(g.at, tz)}${g.spanH >= 36 ? `, ${g.change >= 0 ? "up" : "down"} ${Math.abs(g.change)}°F in ${Math.round(g.spanH / 24)} days` : ""}.</p>
      <div class="chips">${chip("radio", "rdGauge", "auto", "Use it here", spot.gauge !== "off")}${chip("radio", "rdGauge", "off", "Don't use it here", spot.gauge === "off")}</div>
      <span class="small muted">A river gauge can read a few degrees off from a lake. Your own reading always comes first.</span></div>`
    : !salt && cond && cond.mode === "live" ? `<p class="small muted">No USGS water-temperature gauge within 20 miles has reported in the last day, so Fishcast estimates it from air temperatures.</p>` : "";
  openSheet(`<form id="readingForm" novalidate>
    <h3 id="sheetTitle">What you see on the water</h3>
    <div class="field"><span class="label">Your water temperature reading (°F)</span>${stepper("rdWater", w.v, 1, 32)}
      <span class="small muted">${w.src === "estimate" ? "Fishcast is estimating this from air temperatures. A thermometer reading makes the tips much better." : w.gauge ? "Leave it as is to keep using the gauge. A reading you enter is used for 3 days." : "Used for 3 days."}</span></div>
    ${gaugeHtml}
    <div class="field"><span class="label">Clarity</span><div class="chips">${["clear", "stained", "muddy"].map(c => chip("radio", "rdClarity", c, c, c === clarityOf(spot))).join("")}</div></div>
    ${salt ? `<div class="field"><span class="label">Tide right now</span><div class="chips">${[["rising", "Incoming"], ["falling", "Outgoing"], ["slack", "Slack"], ["", "Not sure"]].map(([v, l]) => chip("radio", "rdTide", v, l, v === tide)).join("")}</div>
      <span class="small muted">Applies for 3 hours. Look it up on the <a href="https://tidesandcurrents.noaa.gov/map/" target="_blank" rel="noopener">NOAA tide map</a>.</span></div>` : ""}
    <button class="btn big" type="submit">Update tips</button>
    ${spot.reading && spot.reading.water != null ? `<button type="button" class="linkbtn" data-act="clearReading">Go back to the estimated water temperature</button>` : ""}
  </form>`);
}

function manualSheet() {
  const M = S.manual;
  openSheet(`<form id="manualForm" novalidate>
    <h3 id="sheetTitle">Conditions you see</h3>
    <p class="small muted">Live weather isn't available, so tell Fishcast what it's like.</p>
    <div class="grid2"><div class="field"><span class="label">Air (°F)</span>${stepper("mAir", M.air, 1, -20)}</div><div class="field"><span class="label">Water (°F)</span>${stepper("mWater", M.water, 1, 32)}</div>
      <div class="field"><span class="label">Wind (mph)</span>${stepper("mWind", M.wind, 1, 0)}</div></div>
    <div class="field"><span class="label">Wind from</span><div class="chips">${Object.keys(DIR_DEG).map(d => chip("radio", "mDir", d, d, d === M.windDir)).join("")}</div></div>
    <div class="field"><span class="label">Sky</span><div class="chips">${["sunny", "partly", "overcast", "rain"].map(x => chip("radio", "mSky", x, x === "partly" ? "partly cloudy" : x, x === M.sky)).join("")}</div></div>
    <div class="field"><span class="label">Weather trend</span><div class="chips">${[["falling", "Front coming"], ["steady", "Steady"], ["rising", "Clearing"], ["post-front", "Day after a cold front"]].map(([v, l]) => chip("radio", "mTrend", v, l, v === M.trend)).join("")}</div></div>
    <button class="btn big" type="submit">Update forecast</button>
  </form>`);
}

/* ---------------------------------------------------------------- backup */
async function exportBackup() {
  const data = JSON.stringify({ app: "fishcast", version: 1, exportedAt: new Date().toISOString(), items: Store.items }, null, 1);
  const name = "fishcast-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  try {
    const file = new File([data], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "Fishcast backup" }); return; }
  } catch (e) { if (e.name === "AbortError") return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/json" })); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast("Backup saved");
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== "fishcast" || typeof data.items !== "object") throw new Error("bad");
    const before = JSON.stringify(Store.items);
    Object.assign(Store.items, data.items); Store.save();
    const n = k => Object.values(data.items).filter(v => v && v.kind === k).length;
    render();
    toast(`Restored ${n("spot")} spots and ${n("catch")} log entries`, { label: "Undo", fn: () => { Store.items = JSON.parse(before); Store.save(); render(); } });
  } catch (e) { toast("That file isn't a Fishcast backup."); }
}

/* ---------------------------------------------------------------- events */
// What the location box understood, shown under it as you type or paste (parseCoords is in engine.js).
function coordFeedback(text) {
  const note = $("#coordNote"), c = parseCoords(text);
  if (!text.trim()) note.textContent = "";
  else if (c) note.textContent = `Got it: ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`;
  else if (/goo\.gl|maps\.app|apple\.co/i.test(text)) note.textContent = "Short share links don't include the location. In the map app, copy the coordinates instead, or use Pick on map.";
  else note.textContent = "Can't read that yet. Paste it like 35.2501, -91.7365 or 35.2501° N, 91.7365° W.";
  return c;
}
function go(tab) { S.tab = tab; remember(); window.scrollTo(0, 0); render(); }
function selectSpot(id) { S.spotId = id; S.speciesId = null; remember(); }

document.addEventListener("click", async e => {
  const nav = e.target.closest(".navbtn");
  if (nav) { go(nav.dataset.tab); return; }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  switch (act) {
    case "closeSheet": closeSheet(); break;
    case "spotsMode": S.spotsMode = id; LS.set("fishcast.spotsMode", id); render(); break;
    case "pickOnMap": openMapPicker(parseCoords($("#fCoords").value), c => {
      $("#fCoords").value = c.lat + ", " + c.lon; $("#coordNote").textContent = "Location set from the map."; buzz();
    }); break;
    case "mapUse": usePickedSpot(); break;
    case "mapCancel": closeMapPicker(); break;
    case "mapLayer": toggleLayer(); break;
    case "mapLocate": if (picker) locate(picker.map, 15, false); break;
    case "pickSpot": spotPickerSheet(); break;
    case "chooseSpot": selectSpot(id); closeSheet(); go("today"); break;
    case "openSpot": selectSpot(id); go("today"); break;
    case "species": S.speciesId = id; remember(); render(); break;
    case "refresh": S.tried[curSpot().id] = 0; refreshCurrent(true); break;
    case "newSpot": spotSheet(null); break;
    case "editSpot": spotSheet(Store.list("spot").find(s => s.id === id)); break;
    case "logCatch": logSheet("catch"); break;
    case "logBlank": logSheet("blank"); break;
    case "startTrip": {
      const spot = curSpot();
      if (activeTrip()) { toast("A trip is already running."); break; }
      const tid = uid("trip");
      Store.put(tid, { kind: "trip", spotId: spot.id, species: curSpecies(spot), start: Date.now(), end: null });
      buzz(); render(); toast("Trip started. Tap ＋ Catch when you land one.", { label: "Undo", fn: () => { Store.del(tid); render(); } });
      break;
    }
    case "endTrip": endTripSheet(); break;
    case "discardTrip": {
      const t = activeTrip(); if (!t) break;
      const old = Store.items[t.id]; Store.del(t.id); closeSheet(); render();
      toast("Trip discarded", { label: "Undo", fn: () => { Store.items[t.id] = old; Store.save(); render(); } });
      break;
    }
    case "delTrip": {
      const old = Store.items[id]; Store.del(id); render();
      toast("Trip deleted", { label: "Undo", fn: () => { Store.items[id] = old; Store.save(); render(); } });
      break;
    }
    case "reading": readingSheet(); break;
    case "howScore": openSheet(`<div class="body"><h3 id="sheetTitle">How the bite score works</h3>
      <p>Every hour gets a score from 0 to 100 for the species you picked. It starts at 50 and moves with the things that usually make fish feed:</p>
      <ul class="tips">
        <li class="tip"><div><b>Water temperature</b><span class="small">The biggest factor. Water far outside a species' comfort range pulls the score down a lot.</span></div></li>
        <li class="tip"><div><b>Light</b><span class="small">Dawn and dusk score higher, more so for low-light feeders like walleye. Bright midday sun scores lower.</span></div></li>
        <li class="tip"><div><b>Pressure and fronts</b><span class="small">Falling pressure before a front scores higher. The day or two after a cold front scores lower.</span></div></li>
        <li class="tip"><div><b>Wind, clouds and rain</b><span class="small">A light chop, overcast skies and light rain help. Strong wind and heavy rain hurt.</span></div></li>
        <li class="tip"><div><b>Moon</b><span class="small">Solunar periods (moon overhead, underfoot, rising or setting) and new or full moons add a little.</span></div></li>
      </ul>
      <p class="small muted">75+ is Hot, 60+ Good, 45+ Fair, below that Slow. These are rules of thumb anglers have used for decades, not a guarantee. Your catch log shows what actually works at each spot.</p>
      <button class="btn big ghost" data-act="closeSheet">Got it</button></div>`); break;
    case "manual": manualSheet(); break;
    case "export": exportBackup(); break;
    case "step": {
      const inp = $("#" + b.dataset.for), v = (Number(inp.value) || 0) + Number(b.dataset.d), min = Number(inp.min);
      inp.value = String(Math.max(isNaN(min) ? -Infinity : min, Math.round(v * 100) / 100)); buzz(); break;
    }
    case "geoloc":
      if (!navigator.geolocation) { toast("Location isn't available. Search or paste coordinates instead."); break; }
      $("#coordNote").textContent = "Finding you…";
      navigator.geolocation.getCurrentPosition(p => {
        $("#fCoords").value = p.coords.latitude.toFixed(5) + ", " + p.coords.longitude.toFixed(5);
        $("#coordNote").textContent = "Location set to where you're standing."; buzz();
      }, () => { $("#coordNote").textContent = "Couldn't get your location. Check location permission, or search instead."; }, { enableHighAccuracy: true, timeout: 15000 });
      break;
    case "search": {
      const q = $("#fSearch").value.trim(), out = $("#searchOut"); if (!q) break;
      const typed = parseCoords(q);
      if (typed) { $("#fCoords").value = typed.lat + ", " + typed.lon; $("#fSearch").value = ""; coordFeedback($("#fCoords").value); break; }
      out.textContent = "Searching…";
      try {
        const j = await getJSON("https://geocoding-api.open-meteo.com/v1/search?count=6&name=" + encodeURIComponent(q));
        const rs = j.results || [];
        out.innerHTML = rs.length ? rs.map(r => `<button type="button" class="pickrow" data-act="pickPlace" data-lat="${r.latitude}" data-lon="${r.longitude}" data-name="${esc(r.name)}"><span><b>${esc(r.name)}</b><br><span class="small muted">${esc([r.admin1, r.country].filter(Boolean).join(", "))}</span></span></button>`).join("") : `<span class="small muted">No matches. Try a nearby town.</span>`;
      } catch (err) { out.innerHTML = `<span class="small muted">Search needs a connection. Paste coordinates instead.</span>`; }
      break;
    }
    case "pickPlace":
      $("#fCoords").value = Number(b.dataset.lat).toFixed(4) + ", " + Number(b.dataset.lon).toFixed(4);
      if (!$("#fName").value) $("#fName").value = b.dataset.name;
      $("#searchOut").innerHTML = ""; $("#coordNote").textContent = "Location set to " + b.dataset.name + ". Tap Pick on map to put the pin on your exact spot.";
      break;
    case "askDelSpot": {
      const sid = $("#spotForm").dataset.id, n = Store.list("catch").filter(c => c.spotId === sid).length;
      $("#delArea").innerHTML = `<div class="row"><span class="small">Delete this spot${n ? ` and its ${n} log entries` : ""}?</span><button type="button" class="btn sm warn" data-act="delSpot">Delete</button><button type="button" class="btn sm ghost" data-act="keepSpot">Keep</button></div>`;
      break;
    }
    case "keepSpot": $("#delArea").innerHTML = `<button type="button" class="linkbtn" data-act="askDelSpot" style="color:var(--bad)">Delete this spot</button>`; break;
    case "delSpot": {
      const sid = $("#spotForm").dataset.id, before = JSON.stringify(Store.items);
      Store.list("catch").concat(Store.list("trip")).filter(c => c.spotId === sid).forEach(c => delete Store.items[c.id]);
      Store.del(sid); LS.del("fishcast.cond." + sid); delete S.conds[sid];
      if (S.spotId === sid) selectSpot(null);
      closeSheet(); render();
      toast("Spot deleted", { label: "Undo", fn: () => { Store.items = JSON.parse(before); Store.save(); render(); } });
      break;
    }
    case "delEntry": {
      const old = Store.items[id]; Store.del(id); render();
      toast("Entry deleted", { label: "Undo", fn: () => { Store.items[id] = old; Store.save(); render(); } });
      break;
    }
    case "clearReading": {
      const spot = curSpot(), r = { ...(spot.reading || {}), water: null };
      if (spot.example) EXAMPLE_SPOT.reading = r; else Store.put(spot.id, { ...spot, reading: r });
      closeSheet(); render(); break;
    }
  }
});

document.addEventListener("change", e => {
  const t = e.target;
  if (t.name === "fWater") fillEnvBoxes(checked("fSpecies"), checked("fStruct"));
  else if (t.id === "fCoords") coordFeedback(t.value);
  else if (t.name === "lLure") { const o = $("#lLureOther"); o.hidden = t.value !== "__other"; if (!o.hidden) o.focus(); }
  else if (t.id === "importFile" && t.files[0]) { importBackup(t.files[0]); t.value = ""; }
});

document.addEventListener("input", e => { if (e.target.id === "fCoords") coordFeedback(e.target.value); });

document.addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target, spot = curSpot();
  if (f.id === "spotForm") {
    const raw = $("#fCoords").value, c = parseCoords(raw) || parseCoords($("#fSearch").value), name = $("#fName").value.trim(), err = $("#formErr");
    const problem = !c ? (raw.trim() ? "Those coordinates couldn't be read. Paste them like 35.2501, -91.7365, or use Pick on map." : "Set the location: tap I'm here now, Pick on map, search, or paste coordinates.") : !name ? "Give the spot a name." : "";
    if (problem) { err.textContent = problem; err.hidden = false; err.scrollIntoView({ block: "nearest" }); return; }
    const sid = f.dataset.id || uid("spot"), prev = Store.items[sid] || {};
    const moved = prev.lat !== c.lat || prev.lon !== c.lon;
    Store.put(sid, { ...prev, kind: "spot", name, lat: c.lat, lon: c.lon, water: $('input[name="fWater"]:checked')?.value || "lake",
      clarity: $('input[name="fClarity"]:checked')?.value || "stained", species: checked("fSpecies"), structures: checked("fStruct"), notes: $("#fNotes").value.trim() });
    if (moved) { LS.del("fishcast.cond." + sid); delete S.conds[sid]; delete S.tried[sid]; }
    selectSpot(sid); closeSheet(); buzz(); go("today"); toast("Spot saved");
  } else if (f.id === "logForm") {
    if (spot.example) { closeSheet(); toast("Add your own spot first. Example entries aren't saved.", { label: "Add spot", fn: () => spotSheet(null) }); return; }
    const cond = cachedCond(spot.id), cctx = cond ? buildCtx(spot, cond, curSpecies(spot)) : null;
    const snap = cctx ? { ...snapFromCtx(cctx), score: cctx.now.score, species: cctx.spId } : null;
    const pick = $('input[name="lLure"]:checked')?.value, lure = (!pick || pick === "__other" ? $("#lLureOther").value : pick).trim();
    const entry = { kind: "catch", spotId: spot.id, t: Date.now(), snap, lure }, trip = activeTrip();
    if (trip && trip.spotId === spot.id) entry.tripId = trip.id;
    if (f.dataset.kind === "blank") Object.assign(entry, { count: 0, hours: Number($("#lHours").value) || 0, notes: "" });
    else Object.assign(entry, { species: $('input[name="lSpecies"]:checked')?.value || curSpecies(spot), length: $("#lLen").value, depth: $("#lDepth").value, notes: $("#lNotes").value.trim(), count: Math.max(1, Math.round(Number($("#lCount").value) || 1)) });
    const eid = uid("catch"); Store.put(eid, entry); closeSheet(); buzz(); render();
    toast(entry.count ? "Catch saved" : "Trip saved", { label: "Undo", fn: () => { Store.del(eid); render(); } });
  } else if (f.id === "endTripForm") {
    const t = activeTrip(); if (!t) { closeSheet(); return; }
    const tspot = spots().find(s => s.id === t.spotId) || spot, hrs = Math.max(0.25, Number($("#tHours").value) || 0.25);
    const end = Math.min(Date.now(), t.start + hrs * 36e5);
    closeSheet();
    (async () => {
      const cond = cachedCond(tspot.id) || await ensureCond(tspot);
      Store.put(t.id, { ...t, end, hours: cond ? scoreTrip(tspot, cond, t.species, t.start, end) : [] });
      buzz(); render(); toast(`Trip saved: ${fmtDur(end - t.start)}, ${fishIn(tripCatches(t))} fish`);
    })();
  } else if (f.id === "pastTripForm") {
    if (spot.example) { closeSheet(); toast("Add your own spot first. Example entries aren't saved.", { label: "Add spot", fn: () => spotSheet(null) }); return; }
    const start = new Date($("#pStart").value).getTime(), hrs = Math.max(0.5, Number($("#pHours").value) || 0.5), err = $("#pErr");
    if (!isFinite(start) || start > Date.now()) { err.textContent = "Set when the trip started. It can't be in the future."; err.hidden = false; return; }
    const end = Math.min(Date.now(), start + hrs * 36e5), fish = Math.max(0, Math.round(Number($("#pFish").value) || 0));
    const cond = cachedCond(spot.id), sp = curSpecies(spot), hours = cond ? scoreTrip(spot, cond, sp, start, end) : [];
    const tid = uid("trip");
    Store.put(tid, { kind: "trip", spotId: spot.id, species: sp, start, end, hours, fish, past: true, tried: $("#pTried").value.trim() });
    closeSheet(); buzz(); render();
    toast(hours.length ? `Trip saved: ${fmtDur(end - start)}, ${fish} fish` : "Trip saved. It's too long ago to grade against the forecast.", { label: "Undo", fn: () => { Store.del(tid); render(); } });
  } else if (f.id === "readingForm") {
    const r = { ...(spot.reading || {}), at: Date.now(), clarity: $('input[name="rdClarity"]:checked')?.value || spot.clarity }, inp = $("#rdWater");
    // Only a changed number counts as a thermometer reading; otherwise keep the gauge or estimate.
    if (Number(inp.value) !== Number(inp.defaultValue)) { r.water = Number(inp.value); r.waterAt = Date.now(); }
    if ($('input[name="rdTide"]')) { r.tide = $('input[name="rdTide"]:checked')?.value || ""; r.tideAt = Date.now(); }
    const gauge = $('input[name="rdGauge"]:checked')?.value || spot.gauge;
    if (spot.example) Object.assign(EXAMPLE_SPOT, { reading: r, gauge }); else Store.put(spot.id, { ...spot, reading: r, gauge });
    closeSheet(); buzz(); render(); toast("Tips updated");
  } else if (f.id === "manualForm") {
    S.manual = { air: Number($("#mAir").value), water: Number($("#mWater").value), wind: Number($("#mWind").value), windDir: $('input[name="mDir"]:checked')?.value || "SW", sky: $('input[name="mSky"]:checked')?.value || "partly", trend: $('input[name="mTrend"]:checked')?.value || "steady" };
    LS.set("fishcast.manual", S.manual); S.conds[spot.id] = manualCond(S.manual); closeSheet(); render(); toast("Forecast updated");
  }
});

document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (!$("#mapView").hidden) closeMapPicker(); else if (!$("#sheet").hidden) closeSheet();
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.tab !== "spots") refreshCurrent(false); });
window.addEventListener("online", () => { S.tried = {}; refreshCurrent(false); });

/* ---------------------------------------------------------------- boot */
render();
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  // A home-screen app can stay open for days; tell the user when a new version has taken over.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) toast("Fishcast was updated", { label: "Reload", fn: () => location.reload() });
  });
  navigator.serviceWorker.register("sw.js").then(reg => {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {});
}
