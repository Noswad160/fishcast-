# Fishcast

A fishing forecast that gives tips for each spot, species and set of conditions, and learns from your own catch log.

**Use it:** https://noswad160.github.io/fishcast-/. On your phone, add it to your home screen (Safari: Share button, then *Add to Home Screen*; Chrome: ⋮ menu, then *Add to Home screen*). It then opens full screen like an app and keeps working without signal.

## What it does
- **Spots**: add one in a few taps. Use where you're standing, search a lake, or **pick it on a map**: satellite or street view, drag until the pin sits on your point, dock or creek mouth. Then choose the water type, the species and, optionally, the structure there (points, docks, grass, rock, ledges…).
- **Spots tab**: your spots ranked by how good the bite is right now, as a list or as pins on a map. Tap a pin for its forecast.
- **Live conditions**, with no API keys needed:
  - water temperature and its 3-day trend from the nearest USGS gauge, where there is one
  - air temperature, wind, gusts, pressure and its trend, cloud cover, rain and cold-front detection, from [Open-Meteo](https://open-meteo.com)
  - sun, moon and solunar times, calculated on the phone
- **Today**:
  - a 0–100 bite score with a plain-English summary: how good, the best time, and what to start with
  - the factors behind the score, a "coming up" outlook by part of the day (morning, midday, evening, night, bounded by the sun at the spot) with the best one highlighted, and a 48-hour chart
  - a game plan: the seasonal pattern for your species at today's water temperature, tips for today's conditions, and tips for each kind of structure at the spot
  - Scores are built to be steady: every factor eases in and out instead of switching at a threshold, each hour is blended with its neighbours, and the best time only moves when another part of the day pulls clearly ahead. A test checks that small forecast updates move any hour by at most 10 points.
- **Trips**: tap **Start trip** when you get to the water and **End trip** when you leave (forgot? set the length when you end it, or log a past trip). Catches logged in between belong to the trip, and every hour fished is scored with the same bite score you saw on Today, using the weather that actually happened.
- **Forecast report card**: fish per hour by what the score said (Hot, Good, Fair, Slow) at each spot, with a plain verdict: the forecast is working here, there's no clear difference, or it's backwards here. It waits for at least 3 trips, 6 hours and 5 fish, and calls it an early read until 10 trips and 15 fish. No other fishing app shows whether its forecast actually works.
- **Catch log**: tap **＋ Catch**, pick the species and lure, and save. Conditions and the bite score are saved automatically. Fishcast shows what worked at each spot in conditions like today's, and your patterns by lure, time of day, pressure, sky and water temperature.
- **Home screen and lock screen widget**: iPhone widgets have to come from an App Store app, so the widget runs in [Scriptable](https://apps.apple.com/app/scriptable/id1405459188) (free). `widget/fishcast-widget.js` downloads `engine.js` from the site, so the score, best time, advice and sky colors match the app, and it keeps working offline from its last forecast. Set it up from Spots > Set up a widget: copy the script into Scriptable once, add a Scriptable widget, and paste the spot code as its parameter (`lat,lon | name | water | species`). Small, medium and the three lock-screen sizes are supported.
- **Backup**: spots and catches are stored on your phone. Save a backup file from the Spots tab, and restore it on a new phone.

## Accuracy notes
- Water temperature comes from, in order:
  1. your own thermometer reading, used for 3 days;
  2. the nearest [USGS](https://waterdata.usgs.gov) gauge within 20 miles that has reported in the last day, from the USGS Water Data API (with the legacy WaterServices as a fallback until it shuts down on February 22, 2027). The gauge loads in the background after the forecast, so a slow USGS reply never holds up the app. Rivers and lakes use it by default; ponds don't (a small pond follows the air much faster than flowing water). Either can be switched per spot from the Water tile;
  3. otherwise an estimate from the last 4–7 days of air temperature, which can be off by 5 °F or more.
- The bite score is a set of rules of thumb, not a calibrated model. Your catch log is what makes it specific to your water.
- The spot form offers freshwater types only. The saltwater species and tips are still in `engine.js` (with tide state entered by hand); show them again by removing the freshwater filter on the water-type chips in `spotSheet` (`app.js`).

## Files
- `index.html`, `styles.css`: the app shell.
- `engine.js`: forecast logic (astronomy, species data, gauges, scoring, tips). Doesn't touch the page, so it's tested in Node.
- `app.js`: screens, bottom sheets, storage and the per-spot forecast cache.
- `map.js`: map picker and spots map ([Leaflet](https://leafletjs.com), loaded only when a map opens; satellite imagery from Esri, street map from OpenStreetMap).
- `sw.js`, `manifest.webmanifest`, icons: installable app and offline support. Bump `VERSION` in `sw.js` when app files change.
- `test/`: engine tests. Run `node --test test/*.test.js`; they also run before every deploy.

Run locally with `python -m http.server` and open http://localhost:8000. Pushing to `main` tests and deploys to GitHub Pages.
