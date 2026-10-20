# Fishcast

A fishing forecast that gives tips for each spot, species and set of conditions, and learns from your own catch log.

**Use it:** https://noswad160.github.io/fishcast-/. On your phone, add it to your home screen (Safari: Share button, then *Add to Home Screen*; Chrome: ⋮ menu, then *Add to Home screen*). It then opens full screen like an app and keeps working without signal.

## What it does
- **Spots**: add one in a few taps. Use where you're standing, search a lake, or **pick it on a map**: satellite or street view, drag until the pin sits on your point, dock or creek mouth. Then choose the water type, the species and, optionally, the structure there (points, docks, grass, rock, ledges…).
- **Spots tab**: your spots ranked by how good the bite is right now, as a list or as pins on a map. Tap a pin for its forecast, or long-press the map to add a spot there.
- **Live conditions**, with no API keys needed:
  - water temperature and its 3-day trend from the nearest USGS gauge, where there is one
  - air temperature, wind, gusts, pressure and its trend, cloud cover, rain and cold-front detection, from [Open-Meteo](https://open-meteo.com)
  - sun, moon and solunar times, calculated on the phone
- **Today**:
  - a 0–100 bite score with a plain-English summary: how good, when to go, and what to start with
  - the factors behind the score, the best 2-hour windows, and a 48-hour chart
  - a game plan: the seasonal pattern for your species at today's water temperature, tips for today's conditions, and tips for each kind of structure at the spot
- **Catch log**: tap **＋ Catch**, pick the species and lure, and save. Conditions are saved automatically. Log trips with no bites too. Fishcast shows what worked at each spot in conditions like today's, and your patterns by lure, time of day, pressure, sky and water temperature.
- **Backup**: spots and catches are stored on your phone. Save a backup file from the Spots tab, and restore it on a new phone.

## Accuracy notes
- Water temperature comes from, in order:
  1. your own thermometer reading, used for 3 days;
  2. the nearest [USGS](https://waterdata.usgs.gov) gauge within 20 miles that has reported in the last day. You can turn this off for a spot, since a river gauge can read a few degrees off from a lake;
  3. otherwise an estimate from the last 4–7 days of air temperature, which can be off by 5 °F or more.
- The bite score is a set of rules of thumb, not a calibrated model. Your catch log is what makes it specific to your water.
- Saltwater spots are supported too, but tide state is entered by hand.

## Files
- `index.html`, `styles.css`: the app shell.
- `engine.js`: forecast logic (astronomy, species data, gauges, scoring, tips). Doesn't touch the page, so it's tested in Node.
- `app.js`: screens, bottom sheets, storage and the per-spot forecast cache.
- `map.js`: map picker and spots map ([Leaflet](https://leafletjs.com), loaded only when a map opens; satellite imagery from Esri, street map from OpenStreetMap).
- `sw.js`, `manifest.webmanifest`, icons: installable app and offline support. Bump `VERSION` in `sw.js` when app files change.
- `test/`: engine tests. Run `node --test test/*.test.js`; they also run before every deploy.

Run locally with `python -m http.server` and open http://localhost:8000. Pushing to `main` tests and deploys to GitHub Pages.
