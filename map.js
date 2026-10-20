"use strict";
/* Maps: Leaflet (loaded only when a map is opened), a full-screen pin picker, and the spots map.
   Uses globals from app.js at call time ($, $$, esc, LS, spots, spotScore, toast). */
const LEAFLET_URL = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";
let leafletP = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  // Plain 2D positioning: with 3D transforms, iOS Safari composites the map above fixed elements
  // (the top bar and bottom sheets) no matter their z-index. Must be set before Leaflet loads.
  window.L_DISABLE_3D = true;
  if (!leafletP) leafletP = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = LEAFLET_URL + "leaflet.css"; css.crossOrigin = "anonymous";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = LEAFLET_URL + "leaflet.js"; js.crossOrigin = "anonymous";
    js.onload = () => window.L ? resolve(window.L) : js.onerror();
    js.onerror = () => { leafletP = null; js.remove(); reject(new Error("Map library didn't load")); };
    document.head.appendChild(js);
  });
  return leafletP;
}

// Satellite shows points, grass lines, docks and creek mouths; the street map is easier for finding launches.
const LAYERS = {
  satellite: [
    ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" }],
    ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 }],
  ],
  street: [["https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }]],
};
const layerPref = () => (LS.get("fishcast.layer", "satellite") === "street" ? "street" : "satellite");
function setBase(map, name) {
  (map._fcTiles || []).forEach(l => map.removeLayer(l));
  map._fcTiles = LAYERS[name].map(([url, opts]) => L.tileLayer(url, opts).addTo(map));
  LS.set("fishcast.layer", name);
  $$('[data-act="mapLayer"]').forEach(b => { b.textContent = name === "satellite" ? "Map view" : "Satellite"; });
}
const activeMap = () => (picker && picker.map) || spotsMap;
function toggleLayer() { const m = activeMap(); if (m) setBase(m, layerPref() === "satellite" ? "street" : "satellite"); }
function locate(map, zoom, quiet) {
  if (!navigator.geolocation) { if (!quiet) toast("Location isn't available on this device."); return; }
  navigator.geolocation.getCurrentPosition(
    p => map.setView([p.coords.latitude, p.coords.longitude], Math.max(map.getZoom(), zoom)),
    () => { if (!quiet) toast("Couldn't get your location. Check location permission."); },
    { enableHighAccuracy: true, timeout: 10000 });
}
const mapError = `<p class="small" style="padding:16px">The map needs an internet connection. You can still search or paste coordinates.</p>`;

/* ---------------------------------------------------------------- pin picker */
let picker = null;
async function openMapPicker(start, onDone) {
  const ov = $("#mapView");
  ov.innerHTML = `<div class="mapbar"><button type="button" class="btn sm ghost" data-act="mapCancel">Cancel</button><b>Move the map until the pin is on your spot</b></div>
    <div class="mapwrap"><div id="pickMap" class="mapbox"></div>
      <svg class="crosshair" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 23s-8-7-8-13a8 8 0 0 1 16 0c0 6-8 13-8 13z" fill="var(--accent)" stroke="var(--pin-ring)" stroke-width="1.5"/><circle cx="12" cy="10" r="3" fill="var(--pin-ring)"/></svg>
      <button type="button" class="btn sm maplayer" data-act="mapLayer">Map view</button>
      <button type="button" class="iconbtn maplocate" data-act="mapLocate" aria-label="Go to my location"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></button>
    </div>
    <div class="mapfoot"><span id="mapCoords" class="mono small muted">Loading map…</span><button type="button" class="btn big" data-act="mapUse" disabled>Use this spot</button></div>`;
  ov.hidden = false;
  let Lf;
  try { Lf = await loadLeaflet(); } catch (e) { $("#pickMap").innerHTML = mapError; return; }
  if (ov.hidden) return; // closed while loading
  const has = start && start.lat != null;
  const map = Lf.map("pickMap", { zoomControl: false }).setView(has ? [start.lat, start.lon] : [39.5, -98.35], has ? 15 : 4);
  picker = { map, onDone };
  setBase(map, layerPref());
  const show = () => { const c = map.getCenter(); $("#mapCoords").textContent = c.lat.toFixed(5) + ", " + c.lng.toFixed(5); };
  map.on("move", show); show();
  $('[data-act="mapUse"]').disabled = false;
  if (!has) locate(map, 13, true);
}
function closeMapPicker() {
  if (picker) picker.map.remove();
  picker = null;
  $("#mapView").hidden = true; $("#mapView").innerHTML = "";
}
function usePickedSpot() {
  if (!picker) return;
  const c = picker.map.getCenter(), done = picker.onDone;
  closeMapPicker();
  done({ lat: Number(c.lat.toFixed(5)), lon: Number(c.lng.toFixed(5)) });
}

/* ---------------------------------------------------------------- spots map */
let spotsMap = null;
const markers = new Map();
async function showSpotsMap(el) {
  let Lf;
  try { Lf = await loadLeaflet(); } catch (e) { el.innerHTML = mapError; return; }
  if (!el.isConnected) return;
  dropSpotsMap();
  spotsMap = Lf.map(el, { zoomControl: false });
  setBase(spotsMap, layerPref());
  updateSpotMarkers(true);
}
function updateSpotMarkers(fit) {
  if (!spotsMap) return;
  const list = spots(), ids = new Set(list.map(s => s.id));
  for (const [id, m] of markers) if (!ids.has(id)) { m.remove(); markers.delete(id); }
  for (const s of list) {
    const sc = spotScore(s);
    const icon = L.divIcon({ className: "", iconSize: [40, 40], iconAnchor: [20, 20], popupAnchor: [0, -20],
      html: `<div class="mpin" style="background:${sc == null ? "var(--muted)" : scoreColor(sc)}">${sc == null ? "…" : sc}</div>` });
    const pop = `<div class="mpop"><b>${esc(s.name)}</b><span class="small">${sc == null ? "Loading forecast…" : scoreLabel(sc) + " bite right now · " + sc}</span><button type="button" class="btn sm" data-act="openSpot" data-id="${esc(s.id)}">Open forecast</button></div>`;
    let m = markers.get(s.id);
    if (!m) { m = L.marker([s.lat, s.lon], { icon, title: s.name, keyboard: true }).addTo(spotsMap).bindPopup(pop); markers.set(s.id, m); }
    else { m.setLatLng([s.lat, s.lon]); m.setIcon(icon); m.setPopupContent(pop); }
  }
  if (fit && list.length) {
    if (list.length === 1) spotsMap.setView([list[0].lat, list[0].lon], 12);
    else spotsMap.fitBounds(L.latLngBounds(list.map(s => [s.lat, s.lon])), { padding: [48, 48], maxZoom: 13 });
  }
}
function dropSpotsMap() {
  if (spotsMap) spotsMap.remove();
  spotsMap = null; markers.clear();
}
