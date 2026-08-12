// One-off preprocessing: strips the Natural Earth populated-places file down
// to just what the globe needs to draw city labels (name/position/importance),
// and pre-sorts by population so the client can take a prefix of the array
// instead of sorting ~7k cities on every zoom change.
//
// Run with: node scripts/build-cities.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "../public/data/ne_10m_populated_places_simple.geojson");
const OUT = path.join(__dirname, "../public/data/cities.json");

const raw = JSON.parse(readFileSync(SRC, "utf8"));

const cities = raw.features
  .map((f) => {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    return {
      name: p.nameascii || p.name,
      lat: Math.round(lat * 1e4) / 1e4,
      lon: Math.round(lon * 1e4) / 1e4,
      // Lower scalerank = more important (0 = a handful of world-major
      // cities, 10 = smallest towns in the dataset).
      scalerank: p.scalerank,
      pop: p.pop_max || p.pop_min || 0,
    };
  })
  .sort((a, b) => b.pop - a.pop);

writeFileSync(OUT, JSON.stringify(cities));

const before = readFileSync(SRC).length;
const after = readFileSync(OUT).length;
console.log(
  `${cities.length} cities, ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`,
);
