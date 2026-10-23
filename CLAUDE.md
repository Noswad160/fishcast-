# Fishcast: notes for Claude

Fishing forecast web app for one user, who fishes freshwater (bass, crappie, catfish) around Searcy, Arkansas, on an iPhone.
They use it as a home-screen web app. Live at https://noswad160.github.io/fishcast-/. They aren't a developer: explain
changes in plain language, and say what to do on the phone (usually "reopen the app or tap Reload").

## Layout
- `index.html`, `styles.css`: the app shell. Plain HTML/CSS/JS, no build step, no framework, no npm dependencies.
- `engine.js`: all forecast logic (astronomy, species data, weather and USGS loading, scoring, tips, trips, report card,
  sky scene). No DOM access. Exports for Node at the bottom (`module.exports`); add new functions there for tests.
- `app.js`: screens (Today, Spots, Catches), bottom sheets, storage, the per-spot forecast cache.
- `map.js`: Leaflet maps (pin picker, spots map). Leaflet loads from cdnjs only when a map opens.
- `widget/fishcast-widget.js`: iPhone widget for the Scriptable app. Downloads `engine.js` from the live site and runs it.
- `sw.js`: offline cache. **Bump `VERSION` whenever any app file changes**, or phones keep the old files.
- `test/`: `node --test test/*.test.js`. They also run in the deploy workflow; a failing test blocks the deploy.

## Deploying
Push to `main` → `.github/workflows/pages.yml` runs the tests and publishes the repo root to GitHub Pages
(about 30 seconds). Everything in the repo root is public, so don't commit scratch files or screenshots.

## Data (all on the phone, in localStorage)
- `fishcast.v1`: `{ id: item }` where items have `kind`: `"spot"`, `"catch"` or `"trip"`.
  - spot: `name, lat, lon, water (lake|reservoir|pond|river), clarity, species[], structures[], notes, reading, gauge ("on"|"off"|unset)`
    and `cal [{t, water, est: {lagDays: estimate}}]`, the thermometer readings that calibrate the water estimate (last 30)
  - catch: `spotId, t, species, lure, length, depth, count (0 = old "no bites" entry), snap (conditions + score), tripId`
  - trip: `spotId, species, start, end (null while running), hours [{t, frac, score}], fish (past trips), past`
- `fishcast.cond.<spotId>`: cached forecast. UI preferences under other `fishcast.*` keys.
- Backups are JSON exports of `fishcast.v1`; keep the item format backward compatible.

## Decisions to keep (each was asked for or measured)
- **Freshwater only** in the spot form. Saltwater species and tips still exist in `engine.js`, just not offered.
- **Score stability**: factors ramp in and out (`ramp()`), never hard thresholds, and each hour is blended with its
  neighbours (`blendedScores`). Best times are parts of the day bounded by sunrise/sunset (`dayParts`), shown in time
  order with the best highlighted (earliest within 2 points of the top). A test fails if small forecast updates move
  any hour more than 10 points. Use blended scores everywhere scores appear (Today, chart, trips, widget).
- **Water temperature**, in priority order: the user's reading (3 days), then the nearest USGS gauge within 20 miles,
  then an air-temperature estimate. **Ponds don't use gauges by default** (`usesGauge`).
- **USGS**: the forecast never waits for the gauge; the gauge loads in the background, at most every 30 minutes.
  Gauges come from api.waterdata.usgs.gov (new) and waterservices.usgs.gov (legacy) in parallel. The legacy one
  shuts down on 2027-02-22; remove `loadGaugeLegacy` after that.
- **Report card** needs 3 trips, 6 hours and 5 fish before giving a verdict, and labels it an "early read" until
  10 trips and 15 fish. Don't let it overclaim.
- **iPhone Safari quirks** already handled: Leaflet runs with `L_DISABLE_3D` (3D layers painted over sheets); the
  background page is locked with touchmove handling (Safari ignores `overflow: hidden`); clipboard writes must happen
  inside the tap; long-press on the spots map was removed at the user's request.
- **Look**: the water band (sky gradient from `sceneOf` + `skyStops`, wave edge), the bobber score, Barlow
  Condensed / Source Sans 3. White text on the band must stay ≥ 4.5:1 contrast.

## Working with this user
- Answer questions directly; don't build things they didn't ask for. Offer next steps in one line.
- They care about token use: keep checks proportionate. Run `node --test` for every change. For UI changes, one
  browser look at phone width (390 px, dark mode) is enough unless something is subtle.
- Commit with a clear message and push to `main` when a change is done and tested; that is how they get it.
