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
    h.front = (h.pres - lo >= 0.10 && i - loAt >= 3) ? "post" : (h.trend3 <= -0.03 ? "pre" : "stable");
  }
  return hours;
}
async function loadLive(spot) {
  const q = new URLSearchParams({
    latitude: spot.lat, longitude: spot.lon,
    hourly: "temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation",
    temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch",
    timeformat: "unixtime", timezone: "auto", past_days: 7, forecast_days: 3,
  });
  const gaugeP = envOf(spot) === "fresh" ? loadGauge(spot).catch(() => null) : Promise.resolve(null);
  const j = await getJSON("https://api.open-meteo.com/v1/forecast?" + q);
  const H = j.hourly, last = {};
  const pick = (k, i) => { const v = H[k][i]; if (v != null) last[k] = v; return last[k] ?? 0; };
  const hours = H.time.map((t, i) => ({
    t: t * 1000, air: pick("temperature_2m", i), pres: pick("pressure_msl", i) * 0.02953,
    wind: pick("wind_speed_10m", i), dir: pick("wind_direction_10m", i), gust: pick("wind_gusts_10m", i),
    cloud: pick("cloud_cover", i), precip: pick("precipitation", i),
  }));
  deriveHours(hours);
  const cond = { mode: "live", hours, tz: j.utc_offset_seconds || 0, fetchedAt: Date.now(), sst: null, wave: null, gauge: await gaugeP };
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
  // Rough surface-temperature estimate from recent air temps; shallow water tracks air faster.
  const now = nowHour(), span = (spot.water === "pond" || spot.water === "river") ? 96 : 168;
  const past = hours.filter(h => h.t <= now && h.t > now - span * hourMs);
  if (past.length) {
    const avg = past.reduce((a, h) => a + h.air, 0) / past.length;
    cond.waterEst = Math.round(clamp(avg + (avg > 60 ? 2 : 0), 33, 95));
  }
  return cond;
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
async function loadGauge(spot) {
  const dLat = GAUGE_MAX_MI / 69, dLon = dLat / Math.max(0.2, Math.cos(spot.lat * RAD));
  const box = [spot.lon - dLon, spot.lat - dLat, spot.lon + dLon, spot.lat + dLat].map(v => v.toFixed(4)).join(",");
  const j = await getJSON(`https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=${box}&parameterCd=00010&siteStatus=active&period=P3D`, 12000);
  return parseGauges(j, spot);
}
function gaugeFor(spot, cond) {
  const g = cond && cond.gauge;
  return g && spot.gauge !== "off" && Date.now() - g.at < GAUGE_MAX_AGE ? g : null;
}
function waterOf(spot, cond) {
  const r = spot.reading;
  if (r && r.water != null && Date.now() - (r.waterAt ?? r.at) < 3 * 864e5) return { v: r.water, src: "your reading" };
  if (cond.mode === "manual") return { v: cond.waterEst, src: "entered" };
  const g = gaugeFor(spot, cond);
  if (g) return { v: Math.round(g.f), src: `USGS gauge · ${Math.round(g.dist)} mi`, gauge: g };
  if (cond.sst != null) return { v: Math.round(cond.sst), src: "sea surface" };
  return { v: cond.waterEst ?? 60, src: "estimate" };
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
function scoreHour(sp, h, ctx) {
  const f = [], add = (v, label) => { if (v) f.push({ v: Math.round(v), label }); };
  const L = lightAt(h.t, ctx.spot), water = ctx.water.v, cold = water < 50;
  if (L.p === "dawn" || L.p === "dusk") add(4 + 14 * sp.lowLight, L.p === "dawn" ? "dawn" : "dusk");
  else if (L.p === "night") add(sp.night * 14 - 8, "night");
  else if (cold && ctx.env === "fresh") { const hr = shifted(h.t, ctx.tz).getUTCHours(); if (hr >= 12 && hr <= 16) add(6, "warmest hours"); }
  else if (L.alt > 40 && h.cloud < 30) add(-8 * sp.lowLight, "high sun");
  if (h.front === "post") add(-10, "post-front");
  else if (h.trend3 <= -0.08) add(5, "pressure crashing");
  else if (h.trend3 <= -0.03) add(12, "falling pressure");
  else if (h.trend3 >= 0.06) add(-6, "rising fast");
  if (h.wind > 20) add(-8, "strong wind");
  else if (h.wind >= 5) add(5, "wind chop");
  else if (h.wind < 3 && h.cloud < 40 && L.p === "day") add(-4, "calm & bright");
  if (h.cloud >= 70 && sp.lowLight >= 0.5 && !cold && L.p === "day") add(5, "overcast");
  if (h.precip > 0.3) add(-6, "heavy rain");
  else if (h.precip >= 0.01) add(4, "light rain");
  const sol = solunarAt(h.t, ctx.astro);
  if (sol === "major") add(10, "solunar major"); else if (sol === "minor") add(6, "solunar minor");
  const mp = moonIllum(h.t).phase, days = Math.min(mp, Math.abs(mp - 0.5), 1 - mp) * 29.53;
  if (days <= 2) add(3, mp > 0.25 && mp < 0.75 ? "full moon" : "new moon");
  const fit = tempFit(sp, water);
  const raw = 50 + f.reduce((a, x) => a + x.v, 0);
  const score = Math.round(clamp(clamp(raw, 5, 100) * (0.45 + 0.55 * fit), 1, 99));
  if (fit < 0.7) f.push({ v: -Math.round((1 - fit) * 30), label: water < sp.opt[0] ? "cold water" : "warm water" });
  return { t: h.t, score, factors: f, light: L.p, sol };
}
const scoreLabel = s => s >= 75 ? "Hot" : s >= 60 ? "Good" : s >= 45 ? "Fair" : "Slow";
const scoreColor = s => s >= 75 ? "var(--s4)" : s >= 60 ? "var(--s3)" : s >= 45 ? "var(--s2)" : "var(--s1)";
function bestWindows(scored) {
  const cands = [];
  for (let i = 0; i < scored.length - 1; i++) cands.push({ i, avg: (scored[i].score + scored[i + 1].score) / 2 });
  cands.sort((a, b) => b.avg - a.avg);
  const pick = [];
  for (const c of cands) { if (pick.length >= 3) break; if (pick.every(p => Math.abs(p.i - c.i) >= 4)) pick.push(c); }
  return pick.sort((a, b) => a.i - b.i).map(p => ({ start: scored[p.i].t, end: scored[p.i].t + 2 * hourMs, avg: Math.round(p.avg) }));
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
      trend3: fresh ? trend3 : 0, front: fresh ? (M.trend === "post-front" ? "post" : M.trend === "falling" ? "pre" : "stable") : "stable" });
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
  ctx.future = cond.hours.filter(x => x.t >= now && x.t < now + 48 * hourMs).map(x => scoreHour(sp, x, ctx));
  ctx.now = ctx.future[0] || scoreHour(sp, h, ctx);
  return ctx;
}
// One plain sentence: how good, when to go, what to start with.
function headline(ctx) {
  const s = ctx.now.score, wins = bestWindows(ctx.future), tz = ctx.tz;
  const next = wins.find(w => w.end > Date.now());
  const lead = { Hot: "The bite should be hot", Good: "A good bite is likely", Fair: "Fair bite", Slow: "Slow bite expected" }[scoreLabel(s)];
  const when = !next ? "" : next.start <= Date.now() ? " Now is one of the best windows." : ` Best window: ${fmtDay(next.start, tz) === fmtDay(Date.now(), tz) ? "today" : fmtDay(next.start, tz)} ${fmtTime(next.start, tz)}.`;
  const bait = ctx.phase.baits[0].replace(/\s*\(.*\)$/, "");
  return `${lead} for ${ctx.sp.name.toLowerCase()}.${when} Start with a ${bait.charAt(0).toLowerCase() + bait.slice(1)}.`;
}

if (typeof module !== "undefined") module.exports = { parseGauges, milesBetween, waterOf, SPECIES, STRUCTURES, WATER_TYPES, astroEvents, moonIllum, moonPhaseName, bodyAlt, sunCoords, deriveHours, manualCond, buildCtx, headline, conditionTips, structureTip, bestWindows, phaseOf, tempFit, similarity, snapFromCtx, fmtTime, scoreLabel };
