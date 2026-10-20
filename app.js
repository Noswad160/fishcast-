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
const chip = (type, name, value, label, checked) => `<label class="chip"><input type="${type}" name="${name}" value="${esc(value)}"${checked ? " checked" : ""}>${esc(label)}</label>`;
const stepper = (id, value, step, min) => `<span class="stepper"><button type="button" data-act="step" data-for="${id}" data-d="-${step}" aria-label="Less">−</button><input type="number" id="${id}" value="${esc(value)}" step="${step}" min="${min}" inputmode="decimal"><button type="button" data-act="step" data-for="${id}" data-d="${step}" aria-label="More">+</button></span>`;
const ICON_PIN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`;
const ICON_MAP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>`;
const ICON_EDIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>`;
const bars = rows => `<div class="bars">${rows.slice(0, 5).map(([k, n]) => `<div class="bar"><span>${esc(k)}</span><span class="track"><span class="fill" style="width:${Math.round(n / rows[0][1] * 100)}%"></span></span><span class="n">${n}</span></div>`).join("")}</div>`;
function tally(list, key) {
  const m = new Map();
  for (const e of list) { const k = typeof key === "function" ? key(e) : e[key]; if (!k) continue; m.set(k, (m.get(k) || 0) + (e.count || 1)); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
const titleCase = s => String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/, (\w\w)\.?$/, (m, st) => ", " + st.toUpperCase());
const ago = ms => { const m = Math.round((Date.now() - ms) / 60e3); return m < 2 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago"; };

/* ---------------------------------------------------------------- render */
const view = $("#view");
function render() {
  const spot = curSpot();
  $("#spotName").textContent = spot.name;
  $$(".navbtn").forEach(b => b.dataset.tab === S.tab ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  $("#fab").hidden = S.tab === "spots";
  $("#refreshBtn").classList.toggle("spin", !!S.loading[spot.id]);
  if (!(S.tab === "spots" && S.spotsMode === "map")) { dropSpotsMap(); delete view.dataset.screen; }
  if (S.tab === "spots") renderSpots(); else if (S.tab === "log") renderLog(); else renderToday();
}

function dialSvg(score) {
  const r = 44, c = 2 * Math.PI * r, off = c * (1 - score / 100);
  return `<svg viewBox="0 0 104 104" aria-hidden="true"><circle cx="52" cy="52" r="${r}" fill="none" stroke="var(--line)" stroke-width="9"/><circle class="arc" cx="52" cy="52" r="${r}" fill="none" stroke="${scoreColor(score)}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>`;
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
    if (hr === 0 || i === 0) s += `<text x="${x}" y="${base + 26}" font-size="9" fill="var(--ink)" font-family="Barlow Condensed, sans-serif" font-weight="600">${i === 0 ? "NOW" : fmtDay(d.t, ctx.tz).toUpperCase()}</text>`;
    if (hr === 0 && i) s += `<line x1="${x - 1}" x2="${x - 1}" y1="${top - 12}" y2="${base + 16}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 2"/>`;
  });
  s += `<rect x="29" y="${top - 1}" width="${W + 2}" height="${H + 2}" fill="none" stroke="var(--ink)" stroke-width="1.2" rx="2"/>`;
  return s + "</svg>";
}

function renderToday() {
  const spot = curSpot(), cond = cachedCond(spot.id);
  refreshCurrent(false);
  const list = speciesFor(spot), spId = curSpecies(spot);
  let html = "";
  if (!ownSpots().length) html += `<section class="banner welcome"><div><span class="label">Welcome to Fishcast</span><b>Set up your own spot in about 30 seconds.</b><span class="small">Until then you're looking at an example lake and example catches.</span><div class="row"><button class="btn" data-act="newSpot">Add my spot</button></div></div></section>`;
  if (list.length > 1) html += `<div class="chipbar" role="group" aria-label="Target species">${list.map(k => `<button class="chip" data-act="species" data-id="${k}" aria-pressed="${k === spId}">${esc(SPECIES[k].name)}</button>`).join("")}</div>`;
  if (!cond) { view.innerHTML = html + `<div class="skeleton" aria-label="Loading conditions"></div><div class="skeleton" style="height:90px"></div>`; return; }

  const ctx = buildCtx(spot, cond, spId), { h, sp, tz, astro, water } = ctx, now = ctx.now, err = S.errors[spot.id];
  if (cond.mode === "manual") html += `<section class="banner warn"><div><b>${esc(err || "Live weather isn't loaded.")} Showing conditions you entered.</b><div class="row"><button class="btn sm" data-act="manual">Edit conditions</button><button class="btn sm ghost" data-act="refresh">Try again</button></div></div></section>`;
  else if (!isFresh(cond) && !S.loading[spot.id]) html += `<section class="banner info"><div><span class="small">${err ? esc(err) + " " : ""}Forecast from ${ago(cond.fetchedAt)}.</span></div></section>`;

  const wins = bestWindows(ctx.future);
  const ups = now.factors.filter(f => f.v > 0).sort((a, b) => b.v - a.v), downs = now.factors.filter(f => f.v < 0).sort((a, b) => a.v - b.v);
  html += `<section class="card" aria-label="Bite outlook">
    <div class="hero">
      <div class="dial">${dialSvg(now.score)}<div class="num"><b>${now.score}</b><span style="color:${scoreColor(now.score)}">${scoreLabel(now.score)}</span></div></div>
      <div style="display:flex;flex-direction:column;gap:6px;min-width:0">
        <span class="label">${esc(ctx.phase.name)} pattern · ${water.v}°F water</span>
        <p class="headline">${esc(headline(ctx))}</p>
      </div>
    </div>
    <div class="factors">${ups.map(f => `<span class="factor up">+${f.v} ${esc(f.label)}</span>`).join("")}${downs.map(f => `<span class="factor down">${f.v} ${esc(f.label)}</span>`).join("")}</div>
    <span class="label">Best times, next 48 hours</span>
    <div class="hscroll">${wins.map(w => { const on = w.start <= Date.now() && w.end > Date.now(); return `<div class="win${on ? " now" : ""}"><span class="small muted">${on ? "Now" : fmtDay(w.start, tz)}</span><b>${fmtTime(w.start, tz)}–${fmtTime(w.end, tz)}</b><span class="small" style="color:${scoreColor(w.avg)}">${scoreLabel(w.avg)} · ${w.avg}</span></div>`; }).join("")}</div>
  </section>`;

  const sunrise = astro.sunrise.find(t => t > Date.now() - 12 * hourMs), sunset = astro.sunset.find(t => t > Date.now() - 2 * hourMs), moon = moonIllum(Date.now());
  const est = water.src === "estimate", salt = ctx.env === "salt", tide = tideOf(spot);
  const trendArrow = h.trend3 <= -0.03 ? "↓" : h.trend3 >= 0.03 ? "↑" : "→";
  html += `<section class="tiles" aria-label="Conditions">
    <button class="tile${est ? " flag" : ""}" data-act="reading"><span class="label">Water</span><span class="v">${water.v}°F</span><span class="s">${est ? "est. · tap to set" : esc(water.src)}</span></button>
    <div class="tile"><span class="label">Air</span><span class="v">${Math.round(h.air)}°F</span><span class="s">${skyCat(h)}</span></div>
    <div class="tile"><span class="label">Wind</span><span class="v">${Math.round(h.wind)} ${compass(h.dir)}</span><span class="s">mph · gusts ${Math.round(h.gust)}</span></div>
    <div class="tile"><span class="label">Pressure</span><span class="v">${cond.mode === "manual" ? "" : h.pres.toFixed(2) + " "}${trendArrow}</span><span class="s">${trendCat(h)}</span></div>
    <div class="tile"><span class="label">Sun</span><span class="v">${sunrise ? fmtTime(sunrise, tz) : "—"}</span><span class="s">sets ${sunset ? fmtTime(sunset, tz) : "—"}</span></div>
    <div class="tile"><span class="label">Moon</span><span class="v">${Math.round(moon.fraction * 100)}%</span><span class="s">${moonPhaseName(moon.phase)}</span></div>
    ${salt ? `<button class="tile${tide ? "" : " flag"}" data-act="reading"><span class="label">Tide</span><span class="v">${tide ? { rising: "Incoming", falling: "Outgoing", slack: "Slack" }[tide] : "Not set"}</span><span class="s">tap to ${tide ? "change" : "set"}</span></button>` : ""}
    ${salt && ctx.wave != null ? `<div class="tile"><span class="label">Waves</span><span class="v">${ctx.wave.toFixed(1)} ft</span><span class="s">forecast</span></div>` : ""}
    <button class="tile" data-act="reading"><span class="label">Clarity</span><span class="v">${esc(clarityOf(spot))}</span><span class="s">tap to change</span></button>
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
  return `<section class="card" aria-label="Your history here"><h3>What's worked here ${spot.example ? '<span class="example">Example</span>' : ""}</h3>${body}</section>`;
}

function spotScore(spot) {
  const c = cachedCond(spot.id);
  if (!c) return null;
  try { return buildCtx(spot, c, curSpecies(spot)).now.score; } catch (e) { return null; }
}
function renderSpots() {
  const own = ownSpots(), list = spots().map(s => ({ s, score: spotScore(s) }));
  list.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const best = list.length > 1 && list[0].score != null ? list[0].s.id : null;
  // The map keeps its own state; later renders (forecasts arriving) only refresh its pins.
  if (S.spotsMode === "map" && view.dataset.screen === "spotsmap" && spotsMap && $("#spotsMap")) { updateSpotMarkers(false); warmSpots(); return; }
  let html = `<div class="row" style="justify-content:space-between"><h2>Your spots</h2><button class="btn" data-act="newSpot">${ICON_PIN}Add spot</button></div>
    <div class="chips" role="group" aria-label="Show spots as">${[["list", "List"], ["map", "Map"]].map(([k, l]) => `<button class="chip" data-act="spotsMode" data-id="${k}" aria-pressed="${S.spotsMode === k}">${l}</button>`).join("")}</div>`;
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
  let html = `<div class="row" style="justify-content:space-between"><h2>Catches</h2>${spot.example ? '<span class="example">Example</span>' : ""}</div>`;
  if (!here.length) html += `<section class="card"><p>Nothing logged at ${esc(spot.name)} yet.</p><p class="small muted">Tap <b>＋ Catch</b> when you land a fish. It saves the time and conditions automatically, so in a few trips you'll see what actually works here.</p></section>`;
  if (catches.length) {
    const total = catches.reduce((a, e) => a + (e.count || 1), 0), hrs = blanks.reduce((a, e) => a + (e.hours || 0), 0);
    const band = e => e.snap?.water == null ? "" : (Math.floor(e.snap.water / 5) * 5) + "–" + (Math.floor(e.snap.water / 5) * 5 + 4) + "°F";
    const sec = (title, rows) => rows.length ? `<div class="field"><span class="label">${title}</span>${bars(rows)}</div>` : "";
    html += `<section class="card" aria-label="Patterns"><h3>Patterns</h3>
      <p class="small">${total} fish${blanks.length ? ` · ${blanks.length} trip${blanks.length > 1 ? "s" : ""} (${hrs} h) with no bites` : ""}</p>
      <div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
        ${sec("Lures", tally(catches, "lure"))}${sec("Time of day", tally(catches, e => e.snap?.light))}${sec("Pressure", tally(catches, e => e.snap?.trend))}
        ${sec("Sky", tally(catches, e => e.snap?.sky))}${sec("Water temp", tally(catches, band))}
        ${envOf(spot) === "salt" ? sec("Tide", tally(catches, e => e.snap?.tide)) : sec("Solunar", tally(catches, e => e.snap?.solunar || "outside window"))}
      </div></section>`;
  }
  if (here.length) html += `<section class="list" aria-label="History">${here.map(e => `<div class="item">
    <div class="head"><b>${e.count > 0 ? `${e.count > 1 ? e.count + " × " : ""}${esc(SPECIES[e.species]?.name || e.species)}${e.length ? ` · ${esc(e.length)} in` : ""}` : `No bites · ${esc(e.hours)} h`}</b><span class="small muted">${fmtDate(e.t, tz)} · ${fmtTime(e.t, tz)}</span></div>
    ${e.lure || e.depth || e.notes ? `<span class="small">${[e.lure, e.depth ? e.depth + " ft" : "", e.notes].filter(Boolean).map(esc).join(" · ")}</span>` : ""}
    ${e.snap ? `<span class="small muted">${e.snap.water}°F · ${esc(e.snap.trend)} · ${esc(e.snap.sky)} · ${esc(e.snap.light)}${e.snap.wind != null ? ` · wind ${e.snap.wind} ${esc(e.snap.windDir || "")}` : ""}${e.snap.tide ? ` · ${esc(e.snap.tide)} tide` : ""}</span>` : ""}
    ${e.example ? "" : `<div><button class="linkbtn small" data-act="delEntry" data-id="${esc(e.id)}" style="color:var(--bad)">Delete</button></div>`}
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
    openSheet(`<form id="logForm" data-kind="blank" novalidate><div class="sheethead"><h3 id="sheetTitle">No bites this trip</h3><span class="small muted">${esc(spot.name)}</span></div>
      <p class="small muted">Logging slow trips matters. It tells Fishcast which conditions didn't work here.</p>
      <div class="field"><span class="label">Hours fished</span>${stepper("lHours", 2, 0.5, 0.5)}</div>
      <label class="field"><span class="label">What you tried</span><input type="text" id="lLureOther" placeholder="Jerkbait, jig, docks and points"></label>
      <button class="btn big" type="submit">Save trip</button>
      <button type="button" class="linkbtn" data-act="logCatch">Caught one after all? Log a catch</button></form>`);
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
    <button type="button" class="linkbtn" data-act="logBlank">Fished but caught nothing? Log a no-bite trip</button>
  </form>`);
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
      <span class="small muted" id="coordNote">In Google Maps, long-press a spot to copy its coordinates.</span>
    </div>
    <label class="field"><span class="label">Name</span><input type="text" id="fName" value="${esc(s.name)}" placeholder="North point, Lake Murray"></label>
    <div class="field"><span class="label">Type of water</span><div class="chips">${Object.entries(WATER_TYPES).map(([k, v]) => chip("radio", "fWater", k, v.name, k === s.water)).join("")}</div></div>
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
function parseCoords(str) {
  const m = String(str).match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
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
    case "reading": readingSheet(); break;
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
      Store.list("catch").filter(c => c.spotId === sid).forEach(c => delete Store.items[c.id]);
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
  else if (t.name === "lLure") { const o = $("#lLureOther"); o.hidden = t.value !== "__other"; if (!o.hidden) o.focus(); }
  else if (t.id === "importFile" && t.files[0]) { importBackup(t.files[0]); t.value = ""; }
});

document.addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target, spot = curSpot();
  if (f.id === "spotForm") {
    const c = parseCoords($("#fCoords").value), name = $("#fName").value.trim(), err = $("#formErr");
    const problem = !c ? "Set the location: use your location, search, or paste coordinates." : !name ? "Give the spot a name." : "";
    if (problem) { err.textContent = problem; err.hidden = false; err.scrollIntoView({ block: "nearest" }); return; }
    const sid = f.dataset.id || uid("spot"), prev = Store.items[sid] || {};
    const moved = prev.lat !== c.lat || prev.lon !== c.lon;
    Store.put(sid, { ...prev, kind: "spot", name, lat: c.lat, lon: c.lon, water: $('input[name="fWater"]:checked')?.value || "lake",
      clarity: $('input[name="fClarity"]:checked')?.value || "stained", species: checked("fSpecies"), structures: checked("fStruct"), notes: $("#fNotes").value.trim() });
    if (moved) { LS.del("fishcast.cond." + sid); delete S.conds[sid]; delete S.tried[sid]; }
    selectSpot(sid); closeSheet(); buzz(); go("today"); toast("Spot saved");
  } else if (f.id === "logForm") {
    if (spot.example) { closeSheet(); toast("Add your own spot first. Example entries aren't saved.", { label: "Add spot", fn: () => spotSheet(null) }); return; }
    const cond = cachedCond(spot.id), snap = cond ? snapFromCtx(buildCtx(spot, cond, curSpecies(spot))) : null;
    const pick = $('input[name="lLure"]:checked')?.value, lure = (!pick || pick === "__other" ? $("#lLureOther").value : pick).trim();
    const entry = { kind: "catch", spotId: spot.id, t: Date.now(), snap, lure };
    if (f.dataset.kind === "blank") Object.assign(entry, { count: 0, hours: Number($("#lHours").value) || 0, notes: "" });
    else Object.assign(entry, { species: $('input[name="lSpecies"]:checked')?.value || curSpecies(spot), length: $("#lLen").value, depth: $("#lDepth").value, notes: $("#lNotes").value.trim(), count: Math.max(1, Math.round(Number($("#lCount").value) || 1)) });
    const eid = uid("catch"); Store.put(eid, entry); closeSheet(); buzz(); render();
    toast(entry.count ? "Catch saved" : "Trip saved", { label: "Undo", fn: () => { Store.del(eid); render(); } });
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
