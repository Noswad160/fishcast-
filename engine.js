"use strict";
/* Fishcast engine: astronomy, species data, conditions, scoring and tips. No DOM access. */
/* ---------------------------------------------------------------- astro
   Sun and moon positions (after Agafonkin's SunCalc). Times are epoch ms. */
const RAD = Math.PI / 180, DAY_MS = 864e5, J1970 = 2440588, J2000 = 2451545, OBL = RAD * 23.4397;
const toDays = ms => ms / DAY_MS - 0.5 + J1970 - J2000;
const rightAsc = (l, b) => Math.atan2(Math.sin(l) * Math.cos(OBL) - Math.tan(b) * Math.sin(OBL), Math.cos(l));
const decl = (l, b) => Math.asin(Math.sin(b) * Math.cos(OBL) + Math.cos(b) * Math.sin(OBL) * Math.sin(l));
const altitude = (H, phi, dec) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
const sidereal = (d, lw) => RAD * (280.16 + 360.9856235 * d) - lw;
function sunCoords(d) {
  const M = RAD * (357.5291 + 0.98560028 * d);
  const L = M + RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + RAD * 102.9372 + Math.PI;
  return { dec: decl(L, 0), ra: rightAsc(L, 0) };
}
function moonCoords(d) {
  const L = RAD * (218.316 + 13.176396 * d), M = RAD * (134.963 + 13.064993 * d), F = RAD * (93.272 + 13.229350 * d);
  const l = L + RAD * 6.289 * Math.sin(M), b = RAD * 5.128 * Math.sin(F);
  return { ra: rightAsc(l, b), dec: decl(l, b), dist: 385001 - 20905 * Math.cos(M) };
}
function bodyAlt(ms, lat, lon, coordsFn) {
  const d = toDays(ms), c = coordsFn(d);
  return altitude(sidereal(d, RAD * -lon) - c.ra, RAD * lat, c.dec) / RAD;
}
function moonIllum(ms) {
  const d = toDays(ms), s = sunCoords(d), m = moonCoords(d), sd = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sd * Math.sin(phi), m.dist - sd * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / Math.PI };
}
function moonPhaseName(p) {
  if (p < 0.03 || p > 0.97) return "New moon";
  if (p < 0.22) return "Waxing crescent";
  if (p < 0.28) return "First quarter";
  if (p < 0.47) return "Waxing gibbous";
  if (p < 0.53) return "Full moon";
  if (p < 0.72) return "Waning gibbous";
  if (p < 0.78) return "Last quarter";
  return "Waning crescent";
}
// Scan a time range in 10-minute steps for sunrise/sunset, moonrise/moonset and moon transits.
function astroEvents(t0, t1, lat, lon) {
  const step = 6e5, out = { sunrise: [], sunset: [], solunar: [] };
  let pS = bodyAlt(t0, lat, lon, sunCoords), pM = bodyAlt(t0, lat, lon, moonCoords), ppM = bodyAlt(t0 - step, lat, lon, moonCoords);
  for (let t = t0 + step; t <= t1; t += step) {
    const s = bodyAlt(t, lat, lon, sunCoords), m = bodyAlt(t, lat, lon, moonCoords);
    if (pS < -0.833 && s >= -0.833) out.sunrise.push(t);
    if (pS >= -0.833 && s < -0.833) out.sunset.push(t);
    if (pM < 0.133 && m >= 0.133) out.solunar.push({ type: "minor", center: t, why: "Moonrise" });
    if (pM >= 0.133 && m < 0.133) out.solunar.push({ type: "minor", center: t, why: "Moonset" });
    if (pM > ppM && pM >= m) out.solunar.push({ type: "major", center: t - step, why: "Moon overhead" });
    if (pM < ppM && pM <= m) out.solunar.push({ type: "major", center: t - step, why: "Moon underfoot" });
    ppM = pM; pM = m; pS = s;
  }
  out.solunar.forEach(w => { const half = w.type === "major" ? 3.6e6 : 1.8e6; w.start = w.center - half; w.end = w.center + half; });
  out.solunar.sort((a, b) => a.center - b.center);
  return out;
}

/* ---------------------------------------------------------------- reference data */
const WATER_TYPES = {
  lake: { name: "Lake", env: "fresh" }, reservoir: { name: "Reservoir", env: "fresh" }, pond: { name: "Pond", env: "fresh" },
  river: { name: "River / stream", env: "fresh" },
  inshore: { name: "Inshore bay / marsh", env: "salt" }, surf: { name: "Surf / beach", env: "salt" }, pier: { name: "Pier / jetty", env: "salt" },
};
const STRUCTURES = {
  points: { name: "Points", env: "fresh" }, grass: { name: "Weeds / grass", env: "fresh" }, docks: { name: "Docks", env: "both" },
  rock: { name: "Rock / riprap", env: "fresh" }, dropoff: { name: "Drop-offs / ledges", env: "fresh" }, wood: { name: "Laydowns / wood", env: "fresh" },
  brush: { name: "Brush piles", env: "fresh" }, inflow: { name: "Creek mouths / inflows", env: "fresh" }, bridge: { name: "Bridges", env: "both" },
  seam: { name: "Current seams / eddies", env: "fresh" }, flats: { name: "Shallow flats", env: "fresh" }, humps: { name: "Offshore humps", env: "fresh" },
  grassflat: { name: "Grass flats", env: "salt" }, oyster: { name: "Oyster bars", env: "salt" }, mangrove: { name: "Mangroves / marsh edge", env: "salt" },
  jetty: { name: "Jetty / rocks", env: "salt" }, inlet: { name: "Inlet / pass", env: "salt" }, drain: { name: "Marsh drains / creek mouths", env: "salt" },
  channel: { name: "Channel edges", env: "salt" }, trough: { name: "Surf troughs / cuts", env: "salt" },
};

// Phases: first entry whose temp range (°F, min inclusive / max exclusive) and season match wins.
const SPECIES = {
  lmb: { name: "Largemouth bass", env: "fresh", opt: [65, 80], live: [40, 90], lowLight: .8, night: .4, phases: [
    { max: 45, name: "Winter", where: "Steep banks, bluff walls and channel swings close to the deepest water. Fish stack up and move very little.", baits: ["Football jig, slow drag", "Blade bait, lift and fall", "Suspending jerkbait with 10–20 s pauses", "Drop shot"], how: "Slow everything down. On sunny afternoons, shallow rock near deep water warms a few degrees and pulls fish up." },
    { max: 55, season: "warming", name: "Early prespawn", where: "Secondary points and channel swings leading into spawning pockets. The {sunShore}, which gets the most sun, warms first.", baits: ["Suspending jerkbait", "Lipless crankbait ripped through grass", "Chatterbait", "Jig on rock"], how: "Fish the warmest water you can find. A 2–3° difference matters a lot right now." },
    { max: 62, season: "warming", name: "Prespawn", where: "The first break outside spawning flats and pockets, rock-to-clay transition banks, and docks near spawning areas.", baits: ["Medium-diving crankbait", "Spinnerbait", "Chatterbait", "Texas-rigged creature bait"], how: "The biggest females of the year are feeding up. Cover water along staging areas, then slow down where you get bit." },
    { max: 73, season: "warming", name: "Spawn & postspawn", where: "Shallow, wind-protected pockets with hard bottom. Bedding fish are visible in clear water; males guard fry balls afterwards.", baits: ["Wacky-rigged stick worm", "Texas-rigged creature bait", "Weightless fluke", "Walking topwater at dawn"], how: "Watch for the shad spawn on riprap and seawalls at first light. Release bedding fish quickly, right where you caught them." },
    { min: 80, name: "Summer", where: "Offshore ledges, humps and deep grass lines through midday. Shade under docks and matted grass. Shallow only at low light.", baits: ["10–12 in. Texas-rig worm or Carolina rig on ledges", "Deep-diving crankbait", "Hollow-body frog on mats", "Buzzbait or walking topwater at dawn"], how: "On reservoirs, the bite turns on when the dam is generating and current moves. Night fishing with dark spinnerbaits and big worms is strong." },
    { min: 55, max: 76, season: "cooling", name: "Fall transition", where: "Baitfish move to the backs of creeks and pockets and bass follow, roaming shallow flats.", baits: ["Lipless crankbait", "Squarebill crankbait", "Spinnerbait", "Walking topwater"], how: "Find the bait first. Watch for surface activity and birds, cover water fast, and don't sit on one spot." },
    { max: 55, season: "cooling", name: "Late fall", where: "Fish group up on main-lake points and channel bends as the water cools.", baits: ["Jerkbait", "Jig", "Blade bait", "Flat-sided crankbait"], how: "When you catch one, slow down and work the area thoroughly. They're grouped up." },
    { name: "Early summer", where: "Postspawn fish moving to the first deep breaks, main-lake points and grass edges.", baits: ["Topwater popper or walker early", "Swimbait", "Shaky head", "Carolina rig"], how: "Fish shallow early, then follow them out to the first drop as the sun gets up." },
  ]},
  smb: { name: "Smallmouth bass", env: "fresh", opt: [60, 73], live: [38, 85], lowLight: .5, night: .2, phases: [
    { max: 50, name: "Cold water", where: "Deep rock, bluff ends and wintering holes in 20–40 ft. In rivers, slow deep pools out of the current.", baits: ["Suspending jerkbait (clear water in the 40s °F is prime)", "Hair jig", "Ned rig", "Blade bait"], how: "Long pauses. Most bites come while the bait sits still." },
    { max: 60, season: "warming", name: "Prespawn", where: "Rocky points and gravel flats next to deep water. Fish move up on warm, sunny days.", baits: ["Jerkbait", "Tube jig", "Ned rig", "Small swimbait"], how: "Look for the warmest rock in the system after a few sunny days." },
    { max: 68, season: "warming", name: "Spawn", where: "Gravel and chunk rock in 3–10 ft, often beside a boulder or log, in protected bays.", baits: ["Tube", "Ned rig", "Drop shot", "Wacky worm"], how: "Polarized glasses help you spot beds. Release fish quickly so they can guard the nest." },
    { min: 74, name: "Summer", where: "Offshore humps, rock piles and deep points. River fish sit in current seams below riffles.", baits: ["Drop shot", "Tube", "Topwater walker or popper early", "Crayfish crankbait"], how: "Wind and current turn them on. Fish the windy side of rock humps." },
    { min: 50, max: 68, season: "cooling", name: "Fall", where: "Fish feed hard on main-lake points and flats with baitfish. River fish slide to wintering pools as it cools.", baits: ["Swimbait", "Jerkbait", "Spinnerbait", "Hair jig"], how: "Big fish of the year time. Cover water until you find the bait." },
    { name: "Early summer", where: "Postspawn fish moving to rocky points and the first deep break.", baits: ["Drop shot", "Ned rig", "Topwater", "Tube"], how: "Follow the rock out from the spawning areas." },
  ]},
  crappie: { name: "Crappie", env: "fresh", opt: [60, 75], live: [38, 88], lowLight: .7, night: .6, phases: [
    { max: 50, name: "Winter", where: "Suspended over channel bends and deep brush in 15–30 ft, in tight schools.", baits: ["1/32–1/16 oz jig, vertical", "Live minnow under a slip float", "Small blade bait"], how: "Use electronics. Hold the bait just above the school; bites are very light." },
    { max: 58, season: "warming", name: "Prespawn", where: "Channel edges and brush leading into creeks and shallow flats.", baits: ["Jig tipped with a minnow", "Small swimbait jig", "Minnow under slip float"], how: "They move up and back with every warm or cold day. Follow the temperature." },
    { max: 68, season: "warming", name: "Spawn", where: "Shallow brush, reeds, docks and laydowns in 1–6 ft in protected coves. Males turn dark.", baits: ["1/32 oz jig under a cork", "Live minnow", "Small tube"], how: "Dip a jig into every piece of shallow cover and keep moving." },
    { min: 75, name: "Summer", where: "Suspended over deep brush piles and under bridges and docks with shade. Best at night under lights.", baits: ["Jig vertical over brush", "Minnow under lights at night", "Trolled small crankbaits"], how: "Set your bait at the depth the fish are showing, usually the top of the brush." },
    { season: "cooling", name: "Fall", where: "Following shad toward the backs of creeks. Scattered at first, grouping on brush as it cools.", baits: ["Spider-rig trolled jigs", "Small crankbait", "Jig over brush"], how: "Trolling multiple depths finds scattered fish fast." },
    { name: "Postspawn", where: "Moving back to the first deep brush and to docks.", baits: ["Jig over brush", "Minnow", "Shooting a jig under docks"], how: "Shade is key once the sun is up." },
  ]},
  walleye: { name: "Walleye", env: "fresh", opt: [55, 70], live: [33, 80], lowLight: 1, night: .8, phases: [
    { max: 45, name: "Cold water", where: "Deep holes and breaks. In rivers, slow eddies below dams.", baits: ["Jig & minnow, slow lift-drop", "Blade bait", "Hair jig"], how: "Stay on the bottom. Light bites feel like extra weight." },
    { max: 50, season: "warming", name: "Spawn run", where: "Rivers, below dams and rocky shorelines or reefs with current or wind.", baits: ["Jig & minnow", "Stickbait at night", "Jig & plastic"], how: "Night shallow bite on rocky shorelines can be excellent. Check seasonal regulations." },
    { max: 60, season: "warming", name: "Postspawn", where: "Shallow flats and early weed growth near spawning areas, then main-lake points.", baits: ["Jig & plastic", "Slip bobber & leech", "Trolled crankbait"], how: "Fish are recovering and roam. Troll to find them." },
    { min: 68, name: "Summer", where: "Deep structure (humps, reefs and edges in 15–35 ft) by day; up shallow on wind-blown points and at night.", baits: ["Crawler harness on a bottom bouncer", "Trolled crankbaits", "Slip bobber & leech at dusk"], how: "\"Walleye chop\" matters: a windy, overcast day pushes them shallow." },
    { max: 55, season: "cooling", name: "Fall", where: "Rock and gravel points and reefs. Fish feed heavily before winter.", baits: ["Jig & minnow", "Stickbait trolled at night", "Blade bait"], how: "Evening and night bites on shallow rock are strong." },
    { name: "Early summer", where: "Mid-depth structure and weed lines.", baits: ["Live-bait rig", "Crawler harness", "Jig & plastic"], how: "Fish weed edges in low light, deeper structure midday." },
  ]},
  trout: { name: "Trout", env: "fresh", opt: [50, 64], live: [34, 70], lowLight: .7, night: .1, phases: [
    { max: 42, name: "Cold water", where: "Slow, deep pools and soft water. Fish feed most in the warmest part of the day.", baits: ["Nymph (zebra midge, pheasant tail) dead-drifted deep", "Small jig", "Egg pattern"], how: "Get deep and drift slow. Midday is usually best in winter." },
    { max: 65, name: "Prime", where: "Riffle heads, current seams, undercut banks and pool tailouts. Lake fish cruise shorelines and inflows.", baits: ["Inline spinner", "Nymph rig or dry-dropper", "Small minnow plug", "Spoon (lakes)"], how: "Watch for rising fish and match the hatch. Cast upstream and let the bait drift back naturally." },
    { max: 69, name: "Warm water", where: "Oxygen-rich riffles, spring-fed tributaries and deep shaded pools. Lake fish go deep, below the thermocline.", baits: ["Nymph in fast water", "Trolled spoon deep (lakes)", "Terrestrials (hoppers, ants) along banks"], how: "Fish dawn hours. Land and release fish quickly." },
    { name: "Too warm", where: "Above about 68°F trout are stressed and catch-and-release mortality rises. Try a cold tailwater or higher-elevation stream, or fish only at first light.", baits: ["Fish a colder stream", "Keep fish in the water when releasing"], how: "Use a stream thermometer. Stop when the water passes 68–70°F." },
  ]},
  catfish: { name: "Catfish", env: "fresh", opt: [70, 85], live: [40, 95], lowLight: .6, night: 1, phases: [
    { max: 50, name: "Winter", where: "Deep holes and channel bends. Blues stay active; channel cats slow down.", baits: ["Fresh cut shad or skipjack on bottom", "Cut bait drifted slowly over deep flats"], how: "Fresh bait matters most. Re-bait often." },
    { max: 70, season: "warming", name: "Prespawn feed", where: "Shallow flats and creek mouths, especially after warm rains.", baits: ["Cut bait", "Nightcrawlers", "Chicken liver (channel cats)"], how: "Rising, muddy water after rain is the best trigger of the year." },
    { max: 80, season: "warming", name: "Spawn", where: "Cavities in rock, riprap and undercut banks. Males guarding nests feed less.", baits: ["Cut bait near riprap", "Dip or punch bait"], how: "Work riprap banks and rocky areas at night." },
    { min: 80, name: "Summer", where: "Deep holes by day; shallow flats, riprap and current breaks at night.", baits: ["Cut bait", "Live bluegill or shad (flatheads, where legal)", "Stink or dip bait"], how: "Night is the best bite. Fish current below dams when water is being released." },
    { season: "cooling", name: "Fall feed", where: "Following shad schools; scour holes below dams and channel edges.", baits: ["Fresh cut shad", "Live shad"], how: "Find the shad on electronics and fish below them." },
    { name: "Postspawn", where: "Rocky banks and channel edges.", baits: ["Cut bait", "Nightcrawlers"], how: "Evenings into the night." },
  ]},
  bluegill: { name: "Bluegill / sunfish", env: "fresh", opt: [68, 80], live: [40, 92], lowLight: .3, night: 0, phases: [
    { max: 55, name: "Cold water", where: "Deeper weed edges and brush, schooled tight.", baits: ["Tiny jig tipped with a waxworm", "Small ice-style jig"], how: "Tiny baits, light line, and patience." },
    { max: 67, season: "warming", name: "Prespawn", where: "Warming shallow bays and weed edges.", baits: ["Red worm under a bobber", "Small jig", "Crickets"], how: "The north side of a pond or lake (in the northern hemisphere) warms first." },
    { max: 81, season: "warming", name: "Spawn (beds)", where: "Colonies of saucer-shaped beds on hard sand or gravel in 1–4 ft. Spawning repeats around full moons into summer.", baits: ["Cricket or worm under a small float", "Small popper (fly rod)", "1/32 oz jig"], how: "Find one bed and you've found the colony. Keep the bigger males' beds in mind; they come back." },
    { min: 80, name: "Summer", where: "Shade of docks, weed edges and deeper brush. Shallow early and late.", baits: ["Worm on a small hook near bottom", "Small jig", "Popper at dusk"], how: "Bigger fish sit deeper than the small ones you see." },
    { name: "Fall", where: "Weed edges and docks; bigger fish move a little deeper.", baits: ["Worm", "Small jig", "Small spinner"], how: "Fish the remaining green weeds." },
  ]},
  pike: { name: "Northern pike", env: "fresh", opt: [55, 70], live: [33, 82], lowLight: .4, night: 0, phases: [
    { max: 45, name: "Cold water", where: "Shallow dark-bottom back bays warm first at ice-out. In winter, deep weed edges and drop-offs.", baits: ["Dead bait (smelt, herring) on a quick-strike rig", "Suspending jerkbait", "Large swimbait, slow"], how: "Slow presentations. Big fish are caught on dead bait in cold water." },
    { max: 55, season: "warming", name: "Postspawn shallow", where: "Shallow dark-bottom bays and emerging weeds.", baits: ["Small spoon", "Suspending jerkbait", "Swimbait"], how: "Fish the warmest bays on sunny afternoons." },
    { min: 72, name: "Summer", where: "Big fish go deep to cooler water: deep weed edges and rock humps.", baits: ["Large spinnerbait slow-rolled deep", "Deep crankbait", "Big swimbait"], how: "Small pike stay shallow; go deeper for size." },
    { season: "cooling", name: "Fall", where: "Weed edges and points. Prime time for the biggest fish.", baits: ["Bucktail inline spinner", "Glide bait", "Jerkbait"], how: "Big baits, figure-8 at the boat. Use a wire or heavy fluoro leader." },
    { name: "Late spring", where: "Developing weed beds and edges in 5–15 ft.", baits: ["Inline spinner", "Spinnerbait", "Spoon", "Topwater"], how: "Cover water along the weed line. Use a wire or heavy fluoro leader." },
  ]},
  redfish: { name: "Redfish", env: "salt", opt: [65, 82], live: [45, 95], lowLight: .6, night: .3, phases: [
    { max: 58, name: "Winter", where: "Deeper creeks, holes and dark mud bottoms that soak up sun. Big schools on clear, low-tide flats.", baits: ["Soft plastic on a light jighead, slow", "Cut mullet on bottom", "Shrimp"], how: "Fish the warmest part of the afternoon. Sight-cast to schools on low tide." },
    { min: 86, name: "Hot water", where: "Deeper edges, passes and shade. On flats only at dawn or on high tides.", baits: ["Live shrimp or pinfish", "Cut bait in passes", "Topwater at dawn"], how: "Go early. Moving water keeps oxygen up." },
    { max: 78, season: "cooling", name: "Fall", where: "Bull reds school at inlets and passes; slot fish push into the marsh on high tides.", baits: ["Cut mullet or blue crab at inlets", "Gold spoon", "Paddle tail"], how: "Fall is the bull red run. Heavy tackle at the passes; light tackle in the marsh." },
    { name: "Prime", where: "Grass edges and oyster bars on the rising tide; drains and creek mouths on the falling tide; flooded grass on big high tides (tailing fish).", baits: ["Gold weedless spoon", "Paddle tail on 1/8 oz jighead", "Live shrimp under a popping cork", "Cut mullet or crab"], how: "Moving water and visible bait (mullet) are the two things to look for." },
  ]},
  seatrout: { name: "Speckled trout", env: "salt", opt: [68, 80], live: [48, 90], lowLight: .8, night: .5, phases: [
    { max: 58, name: "Winter", where: "Deep holes in rivers, bayous and residential canals; mud bottoms on sunny afternoons.", baits: ["Suspending twitchbait", "Soft plastic slow on bottom", "Live shrimp"], how: "Slow down a lot. Cold-stunned fish need protecting; follow closures." },
    { min: 85, name: "Summer", where: "Deeper grass edges, channel drop-offs and dock lights at night.", baits: ["Live shrimp", "Topwater at first light", "Soft plastic under lights at night"], how: "Fish the first hour of light, then go deeper." },
    { name: "Prime", where: "Grass flats in 3–6 ft with sand potholes, points with moving water, and birds working over bait.", baits: ["Walking topwater at dawn", "Soft plastic jerkbait or paddle tail", "Live shrimp under a popping cork"], how: "Drift the flats and fan-cast. Where you catch one there are usually more." },
  ]},
  flounder: { name: "Flounder", env: "salt", opt: [60, 78], live: [45, 85], lowLight: .3, night: .2, phases: [
    { max: 68, season: "cooling", name: "Fall run", where: "Migrating toward inlets and passes; stacked at jetty ends and channel edges.", baits: ["Bucktail tipped with a scented soft bait", "Live mud minnow on a Carolina rig", "Paddle tail dragged slowly"], how: "Fish the edges of the main current at the inlet on the outgoing tide." },
    { max: 55, name: "Winter", where: "Most fish have moved offshore; a few remain in deep channels.", baits: ["Slow-dragged jig in deep holes"], how: "Consider another target species." },
    { name: "Prime", where: "Ambush points: drain mouths, dock pilings, creek mouths and sand-mud transitions, especially on the falling tide.", baits: ["Live mud minnow or finger mullet", "Bucktail + scented soft bait", "Paddle tail bounced on bottom"], how: "Drag baits slowly on the bottom. On a bite, wait a moment before setting the hook." },
  ]},
  snook: { name: "Snook", env: "salt", opt: [72, 86], live: [60, 95], lowLight: .8, night: .8, phases: [
    { max: 64, name: "Cold water", where: "Snook seek warm water in deep canals, rivers and spring runs, and suffer cold stress below about 60°F. Check for seasonal closures.", baits: ["Slow soft plastic in warm deep water", "Target another species"], how: "Leave cold-stressed fish alone." },
    { name: "Prime", where: "Mangrove shorelines, lighted docks at night, passes and inlets on the outgoing tide, and beach troughs in summer.", baits: ["Live pilchard (whitebait)", "Live shrimp", "Soft jerkbait or paddle tail", "Walking topwater at dawn"], how: "Moving water is key. Pitch tight to mangroves and to dock shadow lines." },
  ]},
  striper: { name: "Striped bass", env: "salt", opt: [52, 68], live: [40, 78], lowLight: .9, night: .8, phases: [
    { min: 72, name: "Warm water", where: "Fish move to deeper, cooler water and inlets. Night tides are best.", baits: ["Live eels at night", "Bucktail fished deep", "Diamond jig"], how: "Fish at night and at first light." },
    { name: "Prime", where: "Rips, points, jetties and inlets with moving water; bait schools under working birds.", baits: ["Bucktail jig", "Paddle tail swimbait", "Pencil popper at dawn or dusk", "Live eels or bunker"], how: "Fish the tide change and the first hours of moving water." },
  ]},
  sheepshead: { name: "Sheepshead", env: "salt", opt: [55, 72], live: [45, 85], lowLight: .1, night: 0, phases: [
    { name: "Prime", where: "Barnacle-covered pilings, jetties, bridges and oyster bars. Best in late winter and spring when they gather to spawn.", baits: ["Fiddler crab", "Barnacles or sand fleas", "Shrimp on a small, strong hook"], how: "Fish straight down, tight to the structure, and set the hook on the faintest tap. Slower tides make bottom easier to hold." },
  ]},
};

/* ---------------------------------------------------------------- helpers */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const COMPASS_LONG = { N: "north", NE: "northeast", E: "east", SE: "southeast", S: "south", SW: "southwest", W: "west", NW: "northwest" };
const compass = deg => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
const compass8 = deg => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
const DIR_DEG = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
function shifted(ms, tz) { return new Date(ms + tz * 1000); }
function fmtTime(ms, tz) {
  const d = shifted(ms, tz); let h = d.getUTCHours(); const m = d.getUTCMinutes();
  const ap = h < 12 ? "AM" : "PM"; h = h % 12 || 12;
  return h + ":" + String(m).padStart(2, "0") + " " + ap;
}
function fmtHour(ms, tz) { const h = shifted(ms, tz).getUTCHours(); return (h % 12 || 12) + (h < 12 ? "a" : "p"); }
function fmtDay(ms, tz) { return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][shifted(ms, tz).getUTCDay()]; }
// "today", "tomorrow", or the weekday, in the spot's own time zone.
function dayWord(ms, tz) {
  const day = t => Math.floor((t + tz * 1000) / 864e5), diff = day(ms) - day(Date.now());
  return diff === 0 ? "today" : diff === 1 ? "tomorrow" : fmtDay(ms, tz);
}
// Compact hour range: "7–9 AM", "11 AM–1 PM".
function fmtRange(a, b, tz) {
  const part = ms => { const d = shifted(ms, tz), h = d.getUTCHours(), m = d.getUTCMinutes(); return { n: (h % 12 || 12) + (m ? ":" + String(m).padStart(2, "0") : ""), ap: h < 12 ? "AM" : "PM" }; };
  const x = part(a), y = part(b);
  return x.ap === y.ap ? `${x.n}–${y.n} ${y.ap}` : `${x.n} ${x.ap}–${y.n} ${y.ap}`;
}
function fmtDate(ms, tz) { const d = shifted(ms, tz); return fmtDay(ms, tz) + " " + ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()] + " " + d.getUTCDate(); }
const deviceTz = () => -new Date().getTimezoneOffset() * 60;
async function getJSON(url, ms = 9000) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
  finally { clearTimeout(timer); }
}
function envOf(spot) { return (WATER_TYPES[spot.water] || WATER_TYPES.lake).env; }
function seasonOf(ms, tz, lat) {
  let m = shifted(ms, tz).getUTCMonth(); if (lat < 0) m = (m + 6) % 12;
  if (m >= 1 && m <= 5) return "warming";
  if (m === 6 || m === 7) return "summer";
  return "cooling";
}

/* ---------------------------------------------------------------- conditions */
const hourMs = 36e5;
function nowHour() { return Math.floor(Date.now() / hourMs) * hourMs; }
function deriveHours(hours) {
  for (let i = 0; i < hours.length; i++) {
    const h = hours[i];
    h.trend3 = i >= 3 ? h.pres - hours[i - 3].pres : 0;
    let p24 = 0; for (let k = Math.max(0, i - 23); k <= i; k++) p24 += hours[k].precip || 0;
    h.precip24 = p24;
    // Post-front: pressure has climbed ≥0.10 inHg from a low within the last 36 h.
    let lo = h.pres, loAt = i;
    for (let k = Math.max(0, i - 36); k <= i; k++) if (hours[k].pres < lo) { lo = hours[k].pres; loAt = k; }
    h.rise = h.pres - lo; h.sinceLow = i - loAt;
    h.front = (h.rise >= 0.10 && h.sinceLow >= 3) ? "post" : (h.trend3 <= -0.03 ? "pre" : "stable");
  }
  return hours;
}
// Open-Meteo takes several comma-separated coordinates in one request and then replies with a list.
async function meteo(spots, params) {
  const q = new URLSearchParams({ latitude: spots.map(s => s.lat).join(","), longitude: spots.map(s => s.lon).join(","),
    temperature_unit: "fahrenheit", timeformat: "unixtime", ...params });
  const j = await getJSON("https://api.open-meteo.com/v1/forecast?" + q, 8000), list = Array.isArray(j) ? j : [j];
  if (list.length !== spots.length) throw new Error("Unexpected forecast reply");
  return list;
}
// A month of air temperatures for the water estimate. It barely changes, so it's fetched at most twice a day.
const HIST_MS = 12 * hourMs;
const packHist = j => ({ at: Date.now(), t0: j.hourly.time[0] * 1000, air: j.hourly.temperature_2m.map(v => v == null ? null : Math.round(v * 10) / 10) });
const histHours = h => h ? h.air.map((air, i) => ({ t: h.t0 + i * hourMs, air })).filter(x => x.air != null) : [];
// Forecasts for several spots in one request (plus one for the spots whose air history is due).
async function loadLiveMany(spots, prevs = []) {
  const due = spots.map((s, i) => !(prevs[i] && prevs[i].airHist && Date.now() - prevs[i].airHist.at < HIST_MS));
  const [list, hist] = await Promise.all([
    meteo(spots, { hourly: "temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation,weather_code",
      wind_speed_unit: "mph", precipitation_unit: "inch", timezone: "auto", past_days: 7, forecast_days: 3 }),
    due.some(Boolean) ? meteo(spots.filter((s, i) => due[i]), { hourly: "temperature_2m", past_days: 30, forecast_days: 1 }).catch(() => null) : null,
  ]);
  let k = 0;
  return Promise.all(spots.map((spot, i) => {
    let airHist = prevs[i] && prevs[i].airHist || null;
    if (due[i]) { const h = hist && hist[k++]; if (h && h.hourly) airHist = packHist(h); }
    return condFrom(spot, list[i], prevs[i], airHist);
  }));
}
async function loadLive(spot, prev) { return (await loadLiveMany([spot], [prev]))[0]; }
async function condFrom(spot, j, prev, airHist) {
  const H = j.hourly, last = {};
  const pick = (k, i) => { const v = H[k][i]; if (v != null) last[k] = v; return last[k] ?? 0; };
  const all = H.time.map((t, i) => ({
    t: t * 1000, air: pick("temperature_2m", i), pres: pick("pressure_msl", i) * 0.02953,
    wind: pick("wind_speed_10m", i), dir: pick("wind_direction_10m", i), gust: pick("wind_gusts_10m", i),
    cloud: pick("cloud_cover", i), precip: pick("precipitation", i), code: H.weather_code ? pick("weather_code", i) : null,
  }));
  const hours = deriveHours(all);
  // The gauge loads separately (see loadGauge) so a slow USGS reply never holds up the forecast; keep the last reading meanwhile.
  const keep = prev && prev.gauge && Date.now() - prev.gauge.at < GAUGE_MAX_AGE;
  const cond = { mode: "live", hours, tz: j.utc_offset_seconds || 0, fetchedAt: Date.now(), sst: null, wave: null, airHist,
    gauge: keep ? prev.gauge : null, gaugeCheckedAt: keep ? prev.gaugeCheckedAt || 0 : 0 };
  if (envOf(spot) === "salt") {
    try {
      const mq = new URLSearchParams({ latitude: spot.lat, longitude: spot.lon, hourly: "sea_surface_temperature,wave_height", temperature_unit: "fahrenheit", timeformat: "unixtime", timezone: "auto", forecast_days: 2 });
      const m = await getJSON("https://marine-api.open-meteo.com/v1/marine?" + mq);
      const i = m.hourly.time.findIndex(t => t * 1000 >= nowHour());
      const at = k => { const arr = m.hourly[k] || []; for (let x = Math.max(0, i); x < arr.length; x++) if (arr[x] != null) return arr[x]; return null; };
      cond.sst = at("sea_surface_temperature");
      const wv = at("wave_height"); cond.wave = wv == null ? null : wv * 3.281;
    } catch (e) { /* marine data is optional */ }
  }
  // The month of history, then the forecast's own past week (more up to date) for the water estimate.
  const air = histHours(airHist).filter(h => h.t < hours[0].t).concat(hours);
  cond.waterEsts = waterEstimates(air, nowHour());
  cond.waterEst = waterEstimate(air, nowHour(), spot.water);
  return cond;
}
// Surface-temperature estimate from past air temps. Water lags the air: each hour counts less the older it is,
// fading over a few days for a pond and a couple of weeks for a big reservoir, so in fall a lake stays warmer
// than the past week's air and in spring cooler. Sunny summer water runs a little above the air average.
// This is the simplest form of the air2water lake model (Piccolroaz et al. 2013); your readings calibrate it.
const WATER_LAG_DAYS = { pond: 2.5, river: 3, lake: 7, reservoir: 10 }, LAGS = [1.5, 2.5, 4, 7, 10, 14];
const lagFor = water => WATER_LAG_DAYS[water] || 7;
function laggedAir(hours, now, lagDays) {
  const tau = lagDays * 24 * hourMs;
  let sum = 0, wsum = 0;
  for (const h of hours) {
    if (h.t > now || now - h.t > 4 * tau) continue;
    const w = Math.exp(-(now - h.t) / tau); sum += w * h.air; wsum += w;
  }
  if (!wsum) return null;
  const avg = sum / wsum;
  return clamp(avg + 2 * ramp(avg, 50, 65), 33, 95);
}
function waterEstimate(hours, now, water, lagDays = lagFor(water)) {
  const v = laggedAir(hours, now, lagDays);
  return v == null ? null : Math.round(v);
}
// The estimate for every lag the calibration can choose from, so a reading can be compared against each.
function waterEstimates(hours, now) {
  const out = {};
  for (const lag of LAGS) { const v = laggedAir(hours, now, lag); if (v != null) out[lag] = Math.round(v * 10) / 10; }
  return out;
}
// Fit the estimate to your thermometer readings at a spot (spot.cal: [{ t, water, est: { lag: estimate } }]).
// One reading sets a correction (how far off the estimate was); four or more over 10+ days also pick how fast
// this water follows the air. Recent readings count most, and the correction fades if you stop taking them.
// sd is how far the fitted estimate typically sits from your readings (needs 3).
function waterCalibration(spot) {
  const now = Date.now(), pts = (spot.cal || []).filter(p => p && p.est && p.water != null && now - p.t < 365 * 864e5);
  const r = spot.reading; // a reading saved before the calibration list existed
  if (!pts.length && r && r.water != null && r.estAt != null) pts.push({ t: r.waterAt ?? r.at, water: r.water, est: { [lagFor(spot.water)]: r.estAt } });
  if (!pts.length) return null;
  const newest = Math.max(...pts.map(p => p.t)), oldest = Math.min(...pts.map(p => p.t));
  const w = p => Math.exp(-(newest - p.t) / (60 * 864e5));
  const fit = lag => {
    const use = pts.filter(p => p.est[lag] != null);
    if (!use.length) return null;
    let W = 0, S = 0, V = 0;
    for (const p of use) { W += w(p); S += w(p) * (p.water - p.est[lag]); }
    const off = S / W;
    for (const p of use) V += w(p) * (p.water - p.est[lag] - off) ** 2;
    const n = use.length;
    return { lag, off, n, sd: n >= 3 ? Math.sqrt(V / W * n / (n - 1)) : null };
  };
  let best = fit(lagFor(spot.water));
  if (pts.length >= 4 && newest - oldest >= 10 * 864e5) {
    for (const lag of LAGS) { const f = fit(lag); if (f && f.n === pts.length && (!best || best.sd == null || f.sd < best.sd)) best = f; }
  }
  if (!best) return null;
  best.off = clamp(best.off, -12, 12) * (1 - ramp(now - newest, 14 * 864e5, 60 * 864e5));
  return best;
}
/* Coordinates as people paste them: "35.2501, -91.7365" (Google Maps), "35.25010° N, 91.73650° W" (Apple Maps),
   35°15'00.4"N 91°44'11.4"W, Unicode minus signs, or a map link containing @lat,lon / ll= / q=.
   Returns { lat, lon } or null. */
function parseCoords(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  s = s.replace(/[\u2212\u2012\u2013\u2014\uFE63\uFF0D]/g, "-").replace(/[\u2032\u2019\u00B4]/g, "'").replace(/[\u2033\u201D]|''/g, '"')
       .replace(/\u00BA/g, "°").replace(/\u00A0/g, " ").toUpperCase();
  // Map links: prefer the explicit location in the URL.
  const link = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || s.match(/[?&](?:LL|Q|QUERY|SLL|CENTER|DESTINATION)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/);
  if (link) return checkCoords(Number(link[1]), Number(link[2]));
  if (/^HTTPS?:\/\//.test(s)) return null; // a short link (maps.app.goo.gl/...) has no coordinates in it
  const part = /([NSEW])?\s*(-?\d+(?:\.\d+)?)(?:\s*°\s*(?:(\d+(?:\.\d+)?)\s*'\s*)?(?:(\d+(?:\.\d+)?)\s*"\s*)?)?\s*([NSEW](?![A-Z]))?/g;
  const found = [];
  for (const m of s.matchAll(part)) {
    if (m[2] === undefined) continue;
    const hemi = m[1] || m[5] || "";
    let v = Math.abs(Number(m[2])) + (m[3] ? Number(m[3]) / 60 : 0) + (m[4] ? Number(m[4]) / 3600 : 0);
    if (m[2].startsWith("-") || hemi === "S" || hemi === "W") v = -v;
    found.push({ v, hemi });
    if (found.length === 2) break;
  }
  if (found.length < 2) return null;
  let [a, b] = found;
  if ("EW".includes(a.hemi) && a.hemi && "NS".includes(b.hemi) && b.hemi) [a, b] = [b, a]; // longitude written first
  return checkCoords(a.v, b.v);
}
function checkCoords(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
}

/* USGS stream and lake gauges (legacy NWIS instantaneous-values service), parameter 00010 = water temperature. */
const GAUGE_MAX_MI = 20, GAUGE_MAX_AGE = 24 * hourMs;
function milesBetween(a, b) {
  const p1 = a.lat * RAD, p2 = b.lat * RAD, dp = p2 - p1, dl = (b.lon - a.lon) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}
// Nearest gauge with a reading in the last day, with its 3-day change. Returns null if there isn't one.
function parseGauges(json, spot, now = Date.now()) {
  const seen = new Set(), found = [];
  for (const ts of (json && json.value && json.value.timeSeries) || []) {
    const si = ts.sourceInfo || {}, g = si.geoLocation && si.geoLocation.geogLocation, id = si.siteCode && si.siteCode[0] && si.siteCode[0].value;
    if (!g || !id || seen.has(id)) continue;
    const noData = ts.variable && ts.variable.noDataValue, unit = (ts.variable && ts.variable.unit && ts.variable.unit.unitCode) || "deg C";
    const toF = v => /F/i.test(unit) ? v : v * 9 / 5 + 32;
    const vals = ((ts.values && ts.values[0] && ts.values[0].value) || [])
      .map(v => ({ t: Date.parse(v.dateTime), f: toF(Number(v.value)), raw: Number(v.value) }))
      .filter(v => isFinite(v.t) && isFinite(v.f) && v.raw !== noData && v.f > 28 && v.f < 105);
    if (!vals.length) continue;
    const last = vals[vals.length - 1];
    if (now - last.t > GAUGE_MAX_AGE) continue;
    seen.add(id);
    const first = vals.find(v => v.t >= last.t - 72 * hourMs) || vals[0];
    found.push({ id, name: si.siteName || "USGS gauge", lat: g.latitude, lon: g.longitude, dist: milesBetween(spot, { lat: g.latitude, lon: g.longitude }),
      at: last.t, f: Math.round(last.f * 10) / 10, change: Math.round((last.f - first.f) * 10) / 10, spanH: Math.round((last.t - first.t) / hourMs) });
  }
  found.sort((a, b) => a.dist - b.dist);
  return found[0] && found[0].dist <= GAUGE_MAX_MI ? found[0] : null;
}
/* USGS Water Data API (api.waterdata.usgs.gov), which replaces WaterServices: the legacy service degrades from
   November 2026 and shuts down on February 22, 2027. Responses are GeoJSON features whose properties carry
   monitoring_location_id, parameter_code, time, value and unit_of_measure. */
const OGC = "https://api.waterdata.usgs.gov/ogcapi/v0/collections/";
const toF = (v, unit) => /F/i.test(unit || "") ? v : v * 9 / 5 + 32;
// Nearest gauge with a reading in the last day, from a latest-continuous response.
function parseLatestOgc(json, spot, now = Date.now()) {
  const seen = new Set(), found = [];
  for (const ft of (json && json.features) || []) {
    const p = ft.properties || {}, c = ft.geometry && ft.geometry.coordinates, id = p.monitoring_location_id;
    if (!c || !id || seen.has(id) || (p.parameter_code && p.parameter_code !== "00010")) continue;
    const t = Date.parse(p.time), v = Number(p.value), f = toF(v, p.unit_of_measure);
    if (!isFinite(t) || !isFinite(v) || now - t > GAUGE_MAX_AGE || f < 28 || f > 105) continue;
    seen.add(id);
    found.push({ id, name: p.monitoring_location_name || String(id).replace(/^USGS-/, "USGS gauge "), lat: c[1], lon: c[0],
      dist: milesBetween(spot, { lat: c[1], lon: c[0] }), at: t, f: Math.round(f * 10) / 10, change: 0, spanH: 0 });
  }
  found.sort((a, b) => a.dist - b.dist);
  return found[0] && found[0].dist <= GAUGE_MAX_MI ? found[0] : null;
}
// 3-day change from a continuous response for one gauge.
function trendFromOgc(json, g) {
  const vals = ((json && json.features) || []).map(ft => ft.properties || {})
    .map(p => ({ t: Date.parse(p.time), f: toF(Number(p.value), p.unit_of_measure) })).filter(v => isFinite(v.t) && isFinite(v.f) && v.f > 28 && v.f < 105)
    .sort((a, b) => a.t - b.t);
  if (vals.length < 2) return g;
  const last = vals[vals.length - 1], first = vals.find(v => v.t >= last.t - 72 * hourMs) || vals[0];
  return { ...g, change: Math.round((last.f - first.f) * 10) / 10, spanH: Math.round((last.t - first.t) / hourMs) };
}
async function loadGaugeOgc(spot, box) {
  const g = parseLatestOgc(await getJSON(`${OGC}latest-continuous/items?f=json&bbox=${box}&parameter_code=00010&limit=200`, 20000), spot);
  if (!g) return null;
  const id = encodeURIComponent(g.id);
  const [hist, loc] = await Promise.all([
    getJSON(`${OGC}continuous/items?f=json&monitoring_location_id=${id}&parameter_code=00010&time=P3D&limit=1000`, 8000).catch(() => null),
    getJSON(`${OGC}monitoring-locations/items/${id}?f=json`, 6000).catch(() => null),
  ]);
  const name = loc && loc.properties && loc.properties.monitoring_location_name;
  return trendFromOgc(hist, name ? { ...g, name } : g);
}
async function loadGaugeLegacy(spot, box) {
  const j = await getJSON(`https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=${box}&parameterCd=00010&siteStatus=active&period=P3D`, 20000);
  return parseGauges(j, spot);
}
// Ask both services at once and take the first that finds a gauge; null if neither does. This runs in the
// background, after the forecast is on screen, so a slow USGS reply gets plenty of time.
function loadGauge(spot) {
  const dLat = GAUGE_MAX_MI / 69, dLon = dLat / Math.max(0.2, Math.cos(spot.lat * RAD));
  const box = [spot.lon - dLon, spot.lat - dLat, spot.lon + dLon, spot.lat + dLat].map(v => v.toFixed(4)).join(",");
  const tries = [loadGaugeOgc(spot, box), loadGaugeLegacy(spot, box)];
  return new Promise(resolve => {
    let left = tries.length;
    for (const p of tries) p.then(g => { if (g) resolve(g); else if (--left === 0) resolve(null); }, () => { if (--left === 0) resolve(null); });
  });
}
// USGS temperature gauges are on rivers and streams. Use one by default for rivers and lakes, but not for ponds:
// a small pond warms and cools with the air far faster than flowing water. A spot can turn it on ("on") or off ("off").
const usesGauge = spot => spot.gauge === "on" || (spot.gauge !== "off" && spot.water !== "pond");
function gaugeFor(spot, cond) {
  const g = cond && cond.gauge;
  return g && usesGauge(spot) && Date.now() - g.at < GAUGE_MAX_AGE ? g : null;
}
function waterOf(spot, cond) {
  const r = spot.reading;
  if (r && r.water != null && Date.now() - (r.waterAt ?? r.at) < 3 * 864e5) return { v: r.water, src: "your reading" };
  if (cond.mode === "manual") return { v: cond.waterEst, src: "entered" };
  const g = gaugeFor(spot, cond);
  if (g) return { v: Math.round(g.f), src: `USGS · ${Math.round(g.dist)} mi`, gauge: g };
  if (cond.sst != null) return { v: Math.round(cond.sst), src: "sea surface" };
  const cal = waterCalibration(spot), base = cal && cond.waterEsts && cond.waterEsts[cal.lag] != null ? cond.waterEsts[cal.lag] : cond.waterEst;
  if (base == null) return { v: 60, src: "estimate" };
  const v = Math.round(clamp(base + (cal ? cal.off : 0), 33, 95));
  return cal && (v !== cond.waterEst || cal.n > 1) ? { v, src: "estimate, tuned to your readings", tuned: true, cal } : { v, src: "estimate", cal };
}
function clarityOf(spot) { const r = spot.reading; return (r && r.clarity && Date.now() - r.at < 3 * 864e5) ? r.clarity : (spot.clarity || "stained"); }
function tideOf(spot) { const r = spot.reading; return (r && r.tide && Date.now() - r.tideAt < 3 * hourMs) ? r.tide : ""; }

/* ---------------------------------------------------------------- engine */
function tempFit(sp, t) {
  const [o1, o2] = sp.opt, [l1, l2] = sp.live;
  if (t >= o1 && t <= o2) return 1;
  if (t < o1) return t <= l1 ? 0.15 : 0.35 + 0.65 * (t - l1) / (o1 - l1);
  return t >= l2 ? 0.15 : 0.35 + 0.65 * (l2 - t) / (l2 - o2);
}
function lightAt(ms, spot) {
  const mid = ms + hourMs / 2, a = bodyAlt(mid, spot.lat, spot.lon, sunCoords);
  if (a < -6) return { p: "night", alt: a };
  if (a < 10) return { p: bodyAlt(mid + 9e5, spot.lat, spot.lon, sunCoords) > a ? "dawn" : "dusk", alt: a };
  return { p: "day", alt: a };
}
function solunarAt(ms, astro) {
  let best = "";
  for (const w of astro.solunar) if (w.start < ms + hourMs && w.end > ms) { if (w.type === "major") return "major"; best = "minor"; }
  return best;
}
const trendCat = h => h.front === "post" ? "post-front" : h.trend3 <= -0.03 ? "falling" : h.trend3 >= 0.03 ? "rising" : "steady";
const skyCat = h => h.precip >= 0.02 ? "rain" : h.cloud >= 70 ? "overcast" : h.cloud >= 30 ? "partly" : "sunny";
const windCat = h => h.wind < 4 ? "calm" : h.wind <= 15 ? "breezy" : "windy";
// 0 at a, 1 at b, linear between (a > b ramps downward).
const ramp = (x, a, b) => clamp((x - a) / (b - a), 0, 1);
// Every factor eases in and out instead of switching on at a threshold, so a small forecast update
// (a few hundredths of an inch of pressure, a mile an hour of wind) moves the score a little, not a lot.
function scoreHour(sp, h, ctx) {
  const f = [], add = (v, label) => { if (Math.abs(v) >= 0.5) f.push({ v: Math.round(v), label }); };
  const L = lightAt(h.t, ctx.spot), alt = L.alt, water = ctx.water.v, fresh = ctx.env === "fresh";
  const coldness = fresh ? ramp(water, 54, 46) : 0, dayness = ramp(alt, 0, 10), sunny = ramp(h.cloud, 45, 20);
  // Light: low-light peak around sunrise and sunset, night, high sun, and the warmest hours in cold water.
  const lowLight = ramp(alt, -9, -4) * ramp(alt, 13, 6);
  add((4 + 14 * sp.lowLight) * lowLight, L.p === "dusk" || (L.p !== "dawn" && shifted(h.t, ctx.tz).getUTCHours() >= 12) ? "dusk" : "dawn");
  add((sp.night * 14 - 8) * ramp(alt, -4, -12), "night");
  add(-8 * sp.lowLight * ramp(alt, 25, 45) * sunny * (1 - coldness), "high sun");
  const d = shifted(h.t, ctx.tz), hr = d.getUTCHours() + d.getUTCMinutes() / 60 + 0.5;
  add(6 * clamp(1 - Math.abs(hr - 14.5) / 3.5, 0, 1) * coldness, "warmest hours");
  // Pressure: falling before a front helps (less so when it's crashing), rising fast hurts, the day after a front hurts most.
  const post = h.rise != null ? ramp(h.rise, 0.06, 0.14) * ramp(h.sinceLow, 2, 4) : (h.front === "post" ? 1 : 0);
  const fall = 12 * ramp(-h.trend3, 0.01, 0.04) - 7 * ramp(-h.trend3, 0.07, 0.11), rise = -6 * ramp(h.trend3, 0.03, 0.08);
  if (post >= 0.5) add(-10 * post + (1 - post) * (fall + rise), "post-front");
  else { add((1 - post) * fall - 10 * post, ramp(-h.trend3, 0.07, 0.11) > 0.5 ? "pressure crashing" : "falling pressure"); add((1 - post) * rise, "rising fast"); }
  // Wind, cloud and rain.
  add(5 * ramp(h.wind, 3, 7) * ramp(h.wind, 20, 15), "wind chop");
  add(-8 * ramp(h.wind, 18, 26), "strong wind");
  add(-4 * ramp(h.wind, 4, 1.5) * ramp(h.cloud, 50, 30) * dayness, "calm & bright");
  if (sp.lowLight >= 0.5) add(5 * ramp(h.cloud, 55, 80) * dayness * (1 - coldness), "overcast");
  add(4 * ramp(h.precip, 0.003, 0.02) * ramp(h.precip, 0.25, 0.12), "light rain");
  add(-6 * ramp(h.precip, 0.2, 0.4), "heavy rain");
  // Solunar periods peak at their center and taper off past their edges.
  const mid = h.t + hourMs / 2;
  let solV = 0, sol = "";
  for (const w of ctx.astro.solunar) {
    const half = (w.end - w.start) / 2, wgt = ramp(Math.abs(mid - w.center), half * 1.5, half * 0.5), v = (w.type === "major" ? 10 : 6) * wgt;
    if (v > solV) { solV = v; sol = wgt >= 0.5 ? w.type : ""; }
  }
  add(solV, sol === "minor" || (!sol && solV <= 6) ? "solunar minor" : "solunar major");
  const mp = moonIllum(h.t).phase, days = Math.min(mp, Math.abs(mp - 0.5), 1 - mp) * 29.53;
  add(3 * ramp(days, 3, 1.5), mp > 0.25 && mp < 0.75 ? "full moon" : "new moon");
  const fit = tempFit(sp, water);
  const raw = 50 + f.reduce((a, x) => a + x.v, 0);
  const score = Math.round(clamp(clamp(raw, 5, 100) * (0.45 + 0.55 * fit), 1, 99));
  if (fit < 0.7) f.push({ v: -Math.round((1 - fit) * 30), label: water < sp.opt[0] ? "cold water" : "warm water" });
  return { t: h.t, score, factors: f, light: L.p, sol };
}
// Each hour's score blended with its neighbours (¼, ½, ¼). A good bite lasts a couple of hours, and a one-hour
// spike in the inputs (a solunar period, a wobble between forecast runs) shouldn't flip the rating.
function blendedScores(sp, ctx, hours) {
  const raw = new Map(), byT = new Map(ctx.cond.hours.map(h => [h.t, h]));
  const get = h => { if (!raw.has(h.t)) raw.set(h.t, scoreHour(sp, h, ctx)); return raw.get(h.t); };
  return hours.map(h => {
    const c = get(h), p = byT.get(h.t - hourMs), n = byT.get(h.t + hourMs);
    return { ...c, score: Math.round(0.25 * (p ? get(p).score : c.score) + 0.5 * c.score + 0.25 * (n ? get(n).score : c.score)) };
  });
}
const scoreLabel = s => s >= 75 ? "Hot" : s >= 60 ? "Good" : s >= 45 ? "Fair" : "Slow";
const scoreColor = s => s >= 75 ? "var(--s4)" : s >= 60 ? "var(--s3)" : s >= 45 ? "var(--s2)" : "var(--s1)";
// Best times are parts of the day, fixed by the sun at the spot (morning: an hour before sunrise to 3 hours after;
// evening: 3 hours before sunset to an hour after; midday and night in between), ranked by average score.
// Their edges don't wander when the forecast wobbles, unlike picking the single best two-hour slot.
function dayParts(astro) {
  const blocks = [];
  for (const rise of astro.sunrise) {
    const set = astro.sunset.find(s => s > rise), next = set && astro.sunrise.find(r => r > set);
    if (!set) continue;
    blocks.push({ part: "morning", start: rise - hourMs, end: rise + 3 * hourMs }, { part: "midday", start: rise + 3 * hourMs, end: set - 3 * hourMs },
      { part: "evening", start: set - 3 * hourMs, end: set + hourMs });
    if (next) blocks.push({ part: "night", start: set + hourMs, end: next - hourMs });
  }
  const firstRise = astro.sunrise[0], prevSet = firstRise && [...astro.sunset].reverse().find(s => s < firstRise);
  if (prevSet) blocks.push({ part: "night", start: prevSet + hourMs, end: firstRise - hourMs });
  return blocks.filter(b => b.end > b.start);
}
function bestWindows(scored, astro) {
  if (!scored.length) return [];
  const from = scored[0].t, to = scored[scored.length - 1].t + hourMs, round = ms => Math.round(ms / 3e5) * 3e5;
  const wins = dayParts(astro).map(b => ({ ...b, start: Math.max(b.start, from), end: Math.min(b.end, to) }))
    .filter(b => b.end - b.start >= hourMs && b.end > Date.now())
    .map(b => {
      let sum = 0, w = 0;
      for (const s of scored) { const o = Math.min(b.end, s.t + hourMs) - Math.max(b.start, s.t); if (o > 0) { sum += s.score * o; w += o; } }
      return { part: b.part, start: round(b.start), end: round(b.end), avg: Math.round(sum / w) };
    });
  // The next parts of the day in time order. The best is the earliest one within 2 points of the top, so near-ties
  // (a middling bite all day) don't make the highlight jump around between forecast updates.
  const list = wins.sort((a, b) => a.start - b.start).slice(0, 6), top = Math.max(...list.map(w => w.avg));
  const best = list.find(w => w.avg >= top - 2);
  list.forEach(w => { w.best = w === best; });
  return list;
}
// "this evening", "tonight", "tomorrow morning", "Wed midday"
function whenWord(w, tz) {
  const d = dayWord(w.start, tz);
  if (d === "today") return { morning: "this morning", midday: "midday today", evening: "this evening", night: "tonight" }[w.part];
  return `${d} ${w.part}`;
}
function phaseOf(sp, water, season) {
  for (const p of sp.phases) {
    if (p.min != null && water < p.min) continue;
    if (p.max != null && water >= p.max) continue;
    if (p.season && p.season !== season) continue;
    return p;
  }
  return sp.phases[sp.phases.length - 1];
}

function conditionTips(ctx) {
  const { h, sp, env, spot } = ctx, water = ctx.water.v, tips = [];
  const T = (w, title, body) => tips.push({ w, title, body });
  const dir8 = compass8(h.dir), down = COMPASS_LONG[compass8(h.dir + 180)];
  const tc = trendCat(h), sky = skyCat(h);
  if (h.front === "post") T(9, "Post-front: expect a tougher bite", env === "salt"
    ? "Pressure has jumped since a front came through. Fish slide to deeper channels and holes. Slow down, fish the warmest part of the day, and use natural baits."
    : "Pressure has jumped since a front came through. Fish tighten to cover and drop to the deeper edge. Downsize, slow down, and pitch into the thickest cover. Afternoons are usually better than mornings.");
  else if (h.trend3 <= -0.08) T(9, "Pressure is dropping fast", "A storm or strong front is close. The bite can be excellent right before it hits, but get off the water at the first thunder or lightning.");
  else if (h.trend3 <= -0.03) T(10, "Falling pressure: feeding window", "Fish usually feed harder ahead of a front. Use moving baits (spinnerbait, crankbait, chatterbait, swimbait) and cover water rather than picking apart one spot.");
  else if (h.pres > 30.15 && sky === "sunny") T(7, "High pressure, bluebird sky", "Fish hold tight to cover and shade. Precise casts and finesse baits beat covering water.");
  else if (tc === "steady") T(4, "Stable weather", "Fish should be on their normal seasonal spots. Trust the seasonal pattern below.");
  if (h.wind > 18 || h.gust > 28) T(8, `Strong wind: ${Math.round(h.wind)} mph, gusts ${Math.round(h.gust)}`, "Fish wind-protected pockets and the lee side of points. Use heavier baits to keep contact. Be careful crossing open water.");
  else if (h.wind >= 5) T(env === "salt" ? 5 : 8, `Wind from the ${COMPASS_LONG[dir8] || dir8}: fish the ${down} shore`, `Wind at ${Math.round(h.wind)} mph pushes plankton and baitfish onto the ${down}-facing banks and points it's blowing into, and the chop hides your line. Start on the windblown side.`);
  else if (h.wind < 4) T(5, "Calm water", "Fish are spookier on slick water. Make long casts with lighter line and natural colors. Topwater is strong at low light.");
  if (sky === "rain") T(6, "Rain on the water", "Light rain breaks up the surface and often turns on a moving-bait or topwater bite. Keep an eye out for lightning.");
  else if (sky === "overcast") T(6, "Overcast", "Clouds let fish roam away from cover and chase. Topwater and moving baits keep working later into the day.");
  else if (sky === "sunny") T(6, "Bright sun", water < 55 && env === "fresh"
    ? "Sun warms shallow dark bottom and rock through the afternoon. Fish 1–4 pm on the sunny side of the lake."
    : "Fish hold in shade, under cover or deeper. Target the shady side of docks, grass and wood, and fish slower.");
  if (h.precip24 > 0.5) T(8, `Heavy rain in the last day (${h.precip24.toFixed(1)} in)`, env === "salt"
    ? "Runoff pushes fresh, dirty water into the bays. Look for cleaner, saltier water near the passes and deeper channels."
    : "Inflows will be muddy. Fish the mud line where dirty water meets clear. In rivers, rising water pulls catfish to the banks and pushes bass to slack water behind cover.");
  const clarity = clarityOf(spot);
  T(5, `Water clarity: ${clarity}`, {
    clear: "Use natural colors (green pumpkin, shad, ghost), fluorocarbon, and long casts. Fish deeper or in shade when the sun is high.",
    stained: "Chartreuse, white, red and other bright colors. Baits with vibration and flash work well: chatterbait, spinnerbait, rattling crankbait.",
    muddy: "Dark colors (black, black/blue) with a big profile, lots of vibration and rattles. Fish shallow and close to cover, and slow down.",
  }[clarity]);
  if (ctx.light === "dawn" || ctx.light === "dusk") T(9, "Low light: prime time", "Fish move shallow to feed. Throw topwater and fish the shallow end of your spot first.");
  if (ctx.light === "night" && sp.night >= 0.6) T(7, `Night bite for ${sp.name.toLowerCase()}`, "These fish feed well after dark. Fish lighted docks, shallow flats and current breaks.");
  const nextSol = ctx.astro.solunar.find(w => w.end > Date.now() && w.start < Date.now() + 8 * hourMs);
  if (nextSol) {
    const nowIn = nextSol.start <= Date.now();
    T(nextSol.type === "major" ? 6 : 4, `Solunar ${nextSol.type} ${nowIn ? "now" : "at " + fmtTime(nextSol.center, ctx.tz)}`,
      `${nextSol.why} (${fmtTime(nextSol.start, ctx.tz)}–${fmtTime(nextSol.end, ctx.tz)}). Fish often feed more around these times, especially when they line up with dawn or dusk. Be on your best spot.`);
  }
  const mp = moonIllum(Date.now()).phase, days = Math.min(mp, Math.abs(mp - 0.5), 1 - mp) * 29.53;
  if (days <= 2) T(4, mp > 0.25 && mp < 0.75 ? "Full moon" : "New moon", env === "salt" ? "Spring tides: bigger tidal swings and stronger current. Flats flood higher and drain harder, which concentrates fish at drains and passes." : "Stronger solunar effect. In spring, full moons often trigger spawning waves; in summer, fish may feed more at night.");
  if (env === "salt") {
    const tide = tideOf(spot);
    if (tide === "rising") T(10, "Incoming tide", "Fish push onto flats, grass edges and into the marsh. Fish the leading edge of the rising water.");
    else if (tide === "falling") T(10, "Outgoing tide", "Fish drains, creek mouths and points where bait gets flushed out. The last part of the outgoing tide is often the best.");
    else if (tide === "slack") T(8, "Slack tide", "The bite usually slows. Move to inlets or deeper channels where water still moves, or rig up and wait for the turn.");
    else T(9, "Check the tide", "Moving water is the biggest factor inshore. Look up your nearest tide station and set the tide above for tips based on it.");
    if (ctx.wave != null && ctx.wave > 4) T(6, `Rough surf: about ${ctx.wave.toFixed(0)} ft`, "Use heavier sinkers (pyramid or sputnik) and fish the closer trough.");
  }
  const g = ctx.water.gauge;
  if (g && g.spanH >= 36 && Math.abs(g.change) >= 1.5) {
    const days = Math.round(g.spanH / 24), deg = Math.abs(g.change).toFixed(1);
    if (g.change > 0) T(8, `Water warmed ${deg}°F in ${days} days`, water < 70
      ? "Warming water wakes fish up. Expect them shallower and more willing to chase. Sunny banks and shallow flats should get better through the day."
      : "Water is getting warmer. Fish the early and late hours and look for shade, current and deeper edges midday.");
    else T(8, `Water cooled ${deg}°F in ${days} days`, ctx.season === "cooling" && g.change > -5
      ? "A steady fall cool-down gets fish feeding on baitfish. Cover water and follow the bait."
      : "Falling water temperature usually slows the bite. Fish a little deeper and slower, and give them time to adjust.");
  }
  if (water < sp.live[0] + 5) T(8, `Very cold water for ${sp.name.toLowerCase()}`, "Fish are sluggish and deep. Use the slowest presentation you have and expect light bites.");
  else if (water > sp.opt[1] + 5) T(8, "Hot water", "Oxygen is lower in hot water. Fish early and late, deeper, or wherever there's current or shade.");
  return tips.sort((a, b) => b.w - a.w);
}

function structureTip(id, ctx) {
  const { env, phase, h } = ctx, water = ctx.water.v, sunny = skyCat(h) === "sunny", windy = h.wind >= 8, salt = env === "salt";
  const warmSpring = ctx.season === "warming" && water < 62;
  switch (id) {
    case "points": return windy ? "Start on points the wind is hitting. Work from the shallow side out to the first drop at the tip." : "Fish the tip where it drops toward the channel. Fan-cast both sides, then work the break.";
    case "grass": return water >= 75 ? "Frog or punch the matted grass, and work the outside edge with a swim jig. Points and holes in the grass line hold the best fish."
      : water < 60 ? "Rip a lipless crankbait or chatterbait over the tops of submerged grass. Healthy green patches hold fish; dead grass doesn't."
      : "Swim a chatterbait or swim jig along the edge. Topwater over submerged grass at low light.";
    case "docks": return salt ? "Pilings and dock lights at night gather shrimp and baitfish. Fish the shadow line on the up-current side."
      : sunny ? "High sun pushes fish into dock shade. Skip a jig or wacky worm far back under walkways and floats." : "With cloud cover, fish roam to the outer posts and corners. Run a spinnerbait or squarebill past them.";
    case "rock": return warmSpring ? "Riprap and rock warm fastest in spring. Check them in the afternoon with a crawfish crankbait or jig." : "Rock holds crawfish. Bump a squarebill or crawfish crankbait off it, or drag a jig or tube when the water is cold.";
    case "dropoff": return "Fish relate to the edge. Sit shallow and drag baits down the break, or sit deep and crank up it. Spots on the ledge with rock or a turn hold the most fish.";
    case "wood": return "Pitch a Texas rig or jig to the shady side and the deepest part of each laydown. A squarebill deflecting off the branches gets reaction bites.";
    case "brush": return "Find the brush on electronics and fish it vertically, or drag a bait over the top. Expect to lose some tackle.";
    case "inflow": return h.precip24 > 0.25 ? "Rain is pushing fresh water and food in. Fish the mud line where stained inflow water meets clearer lake water." : "Inflows bring oxygen and different-temperature water. Fish the current seam where it enters.";
    case "bridge": return salt ? "Fish the up-current side of the pilings and the shadow line at night, when bait gathers under the lights." : "Pilings break current and throw shade. Fish the eddy on the down-current side and the shadow line.";
    case "seam": return "Fish face upstream in slack water next to fast water. Drift baits along the seam and behind boulders and logs.";
    case "flats": return phase.name.match(/Summer/) ? "Flats are best at dawn, dusk and at night now. Midday, fish the nearest deep water next to them." : "Fish move onto flats to feed at low light and as water warms. Cover water with moving baits and slow down around any cover.";
    case "humps": return "Offshore humps hold summer schools. Make long casts with deep crankbaits and Carolina rigs, and fish them when wind or current is moving.";
    case "grassflat": return "Fish sand potholes and grass edges. The rising tide pushes fish onto the flat; the falling tide pulls them to edges and channels.";
    case "oyster": return "Oyster bars come alive on moving tides. Fish the up-current side as water floods over. Use weedless baits and an abrasion-resistant leader.";
    case "mangrove": return "Skip baits deep under the overhang on higher tides. On low tide, fish the points and potholes in front of the shoreline.";
    case "jetty": return "Fish the tip and the current side of the rocks during moving water. Keep baits just off the rocks to avoid snags.";
    case "inlet": return "The strongest current concentrates bait. Fish the edges and eddies at the start and end of each tide, with heavy jigs in the main flow.";
    case "drain": return "On the falling tide, drains and creek mouths funnel bait out. Set up down-current and cast up into the mouth.";
    case "channel": return "Channel edges hold fish at low tide and during heat or cold snaps. Drag jigs down the drop-off.";
    case "trough": return "Read the beach at low tide to find troughs and cuts in the sandbar. Fish the cuts, especially on the rising tide.";
  }
  return "";
}

/* ---------------------------------------------------------------- learning from your log */
function snapFromCtx(ctx) {
  const h = ctx.h;
  return { water: ctx.water.v, air: Math.round(h.air), pres: Number(h.pres.toFixed(2)), trend: trendCat(h), sky: skyCat(h), wind: Math.round(h.wind),
    windDir: compass8(h.dir), windCat: windCat(h), light: ctx.light, solunar: solunarAt(Date.now(), ctx.astro), moon: moonPhaseName(moonIllum(Date.now()).phase),
    clarity: clarityOf(ctx.spot), tide: tideOf(ctx.spot), source: ctx.mode };
}
function similarity(a, b, salt) {
  if (!a || !b) return 0;
  let s = 0, max = 0;
  const add = (w, hit) => { max += w; if (hit === true) s += w; else if (typeof hit === "number") s += w * hit; };
  const dt = Math.abs((a.water ?? 0) - (b.water ?? 0));
  add(3, dt <= 4 ? 1 : dt <= 8 ? 0.5 : 0);
  add(2, a.trend === b.trend);
  add(1.5, a.sky === b.sky);
  add(1, a.windCat === b.windCat);
  add(1.5, a.light === b.light);
  add(1, a.clarity === b.clarity);
  if (salt) add(1.5, !!a.tide && a.tide === b.tide);
  return s / max;
}


/* ---------------------------------------------------------------- putting it together */
function speciesFor(spot) {
  return (spot.species && spot.species.length) ? spot.species : Object.keys(SPECIES).filter(k => SPECIES[k].env === envOf(spot));
}
// Synthetic conditions from what the angler reports; what they see is assumed to hold for about half a day.
function manualCond(M) {
  const tz = deviceTz(), start = nowHour() - 48 * hourMs, hours = [];
  const cloud = { sunny: 10, partly: 45, overcast: 90, rain: 100 }[M.sky];
  const trend3 = { falling: -0.05, steady: 0, rising: 0.04, "post-front": 0.06 }[M.trend];
  for (let i = 0; i < 100; i++) {
    const t = start + i * hourMs, ahead = (t - nowHour()) / hourMs, fresh = ahead >= -2 && ahead <= 12;
    hours.push({ t, air: Number(M.air), pres: 30.0, wind: Number(M.wind), dir: DIR_DEG[M.windDir] ?? 225, gust: Number(M.wind) * 1.4,
      cloud, precip: M.sky === "rain" ? 0.05 : 0, precip24: M.sky === "rain" ? 0.3 : 0,
      trend3: fresh ? trend3 : 0, front: fresh ? (M.trend === "post-front" ? "post" : M.trend === "falling" ? "pre" : "stable") : "stable",
      rise: fresh && M.trend === "post-front" ? 0.14 : 0, sinceLow: 6 });
  }
  return { mode: "manual", hours, tz, fetchedAt: Date.now(), waterEst: Number(M.water), sst: null, wave: null };
}
function buildCtx(spot, cond, speciesId) {
  const list = speciesFor(spot), spId = list.includes(speciesId) ? speciesId : list[0];
  const sp = SPECIES[spId], env = envOf(spot), now = nowHour();
  let idx = cond.hours.findIndex(h => h.t >= now); if (idx < 0) idx = cond.hours.length - 1;
  const h = cond.hours[idx];
  const astro = astroEvents(now - 24 * hourMs, now + 72 * hourMs, spot.lat, spot.lon);
  const water = waterOf(spot, cond), season = seasonOf(Date.now(), cond.tz, spot.lat);
  const ctx = { spot, cond, sp, spId, env, h, astro, water, season, tz: cond.tz, mode: cond.mode, wave: cond.wave, light: lightAt(now, spot).p };
  ctx.phase = phaseOf(sp, water.v, season);
  ctx.future = blendedScores(sp, ctx, cond.hours.filter(x => x.t >= now && x.t < now + 48 * hourMs));
  ctx.now = ctx.future[0] || blendedScores(sp, ctx, [h])[0];
  return ctx;
}
// One plain sentence: how good, when to go, what to start with.
function headline(ctx) {
  const s = ctx.now.score, wins = bestWindows(ctx.future, ctx.astro), tz = ctx.tz;
  const lead = { Hot: "The bite should be hot", Good: "A good bite is likely", Fair: "Fair bite", Slow: "Slow bite expected" }[scoreLabel(s)];
  const best = wins.find(w => w.best);
  const when = !best ? "" : best.start <= Date.now() ? ` Now through ${fmtTime(best.end, tz)} is the best stretch.` : ` Best time: ${whenWord(best, tz)}, ${fmtRange(best.start, best.end, tz)}.`;
  const bait = ctx.phase.baits[0].replace(/\s*\(.*\)$/, "");
  return `${lead} for ${ctx.sp.name.toLowerCase()}.${when} Start with a ${bait.charAt(0).toLowerCase() + bait.slice(1)}.`;
}

/* ---------------------------------------------------------------- trips and the forecast report card */
// The bite score for each hour (or part of an hour) of a trip. Past hours use the observed weather in cond.hours.
function scoreTrip(spot, cond, spId, start, end) {
  const ctx = buildCtx(spot, cond, spId);
  ctx.astro = astroEvents(start - 3 * hourMs, end + 3 * hourMs, spot.lat, spot.lon);
  const inTrip = cond.hours.filter(h => Math.min(end, h.t + hourMs) > Math.max(start, h.t));
  return blendedScores(ctx.sp, ctx, inTrip).map((s, i) => {
    const h = inTrip[i], a = Math.max(start, h.t), b = Math.min(end, h.t + hourMs);
    return { t: h.t, frac: Math.round((b - a) / hourMs * 100) / 100, score: s.score };
  });
}
const BANDS = ["Hot", "Good", "Fair", "Slow"];
const MIN_TRIPS = 3, MIN_HOURS = 6, MIN_FISH = 5, SOLID_TRIPS = 10, SOLID_FISH = 15;
// Fish per hour in each score band, from finished trips and the catches logged during them.
function reportCard(trips, catches) {
  const done = trips.filter(t => t.end && t.hours && t.hours.length);
  const bands = Object.fromEntries(BANDS.map(k => [k, { hours: 0, fish: 0 }]));
  for (const tr of done) {
    for (const h of tr.hours) bands[scoreLabel(h.score)].hours += h.frac;
    if (tr.fish) { // a past trip logged with a fish count: credit its average score
      const w = tr.hours.reduce((a, h) => a + h.frac, 0), avg = tr.hours.reduce((a, h) => a + h.score * h.frac, 0) / (w || 1);
      bands[scoreLabel(avg)].fish += tr.fish;
    }
  }
  const byId = new Map(done.map(t => [t.id, t]));
  for (const c of catches) {
    const tr = byId.get(c.tripId);
    if (!tr) continue;
    let s = c.snap && c.snap.score;
    if (s == null) { const h = tr.hours.find(h => c.t >= h.t && c.t < h.t + hourMs); s = h && h.score; }
    if (s != null) bands[scoreLabel(s)].fish += c.count || 1;
  }
  const sum = keys => keys.reduce((a, k) => ({ hours: a.hours + bands[k].hours, fish: a.fish + bands[k].fish }), { hours: 0, fish: 0 });
  const rate = g => ({ ...g, rate: g.hours > 0 ? g.fish / g.hours : 0 });
  const hi = rate(sum(["Hot", "Good"])), lo = rate(sum(["Fair", "Slow"])), all = rate(sum(BANDS));
  for (const k of BANDS) bands[k].rate = bands[k].hours > 0 ? bands[k].fish / bands[k].hours : 0;
  let verdict;
  if (done.length < MIN_TRIPS || all.hours < MIN_HOURS || all.fish < MIN_FISH) verdict = "learning";
  else if (hi.hours < 2 || lo.hours < 2) verdict = "one-sided";
  else if (hi.rate >= 1.5 * lo.rate && hi.rate - lo.rate >= 0.15) verdict = "working";
  else if (lo.rate >= 1.5 * hi.rate && lo.rate - hi.rate >= 0.15) verdict = "backwards";
  else verdict = "unclear";
  // A handful of trips is an early read; say so rather than overclaim.
  const solid = done.length >= SOLID_TRIPS && all.fish >= SOLID_FISH;
  return { trips: done.length, bands, hi, lo, all, verdict, solid, ratio: lo.rate > 0 ? hi.rate / lo.rate : null,
    need: { trips: Math.max(0, MIN_TRIPS - done.length), hours: Math.max(0, MIN_HOURS - all.hours), fish: Math.max(0, MIN_FISH - all.fish) } };
}

/* ---------------------------------------------------------------- scene: what the sky looks like at the spot right now */
// sky from the sun's height at the spot (so it follows the spot's own time zone); wx from the current hour's weather.
// Weather codes are WMO codes as Open-Meteo reports them.
function sceneOf(spot, cond, ms = Date.now()) {
  const alt = bodyAlt(ms, spot.lat, spot.lon, sunCoords);
  const sky = alt < -6 ? "night" : alt < 6 ? (bodyAlt(ms + 9e5, spot.lat, spot.lon, sunCoords) > alt ? "dawn" : "dusk") : "day";
  let wx = "clear";
  const h = cond && cond.hours && (cond.hours.find(x => x.t <= ms && ms < x.t + hourMs) || null);
  if (h) {
    const c = h.code;
    wx = c >= 95 ? "storm"
      : (c >= 71 && c <= 77) || c === 85 || c === 86 ? "snow"
      : c === 45 || c === 48 ? "fog"
      : (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || h.precip >= 0.02 ? "rain"
      : h.cloud >= 70 ? "cloudy" : h.cloud >= 30 ? "partly" : "clear";
  }
  return { sky, wx };
}

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
const mixDark = (hex, amt) => "#" + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amt)).toString(16).padStart(2, "0")).join("");
function skyStops({ sky, wx }) {
  return (SKIES[sky] && SKIES[sky][wx]) || DAY[wx].map(c => sky === "day" ? c : mixDark(c, DIM[sky]));
}

if (typeof module !== "undefined") module.exports = { loadGauge, loadLive, loadLiveMany, waterEstimate, waterEstimates, waterCalibration, parseLatestOgc, trendFromOgc, usesGauge, blendedScores, whenWord, dayParts, skyStops, sceneOf, scoreTrip, reportCard, BANDS, parseCoords, dayWord, fmtRange, parseGauges, milesBetween, waterOf, SPECIES, STRUCTURES, WATER_TYPES, astroEvents, moonIllum, moonPhaseName, bodyAlt, sunCoords, deriveHours, manualCond, buildCtx, headline, conditionTips, structureTip, bestWindows, phaseOf, tempFit, similarity, snapFromCtx, fmtTime, scoreLabel };
