// One-off preprocessing: turns the ~8MB Natural Earth admin-2 (US county)
// file into a small file the client can fetch cheaply, keeping only the
// county name, its state, a label anchor, and simplified outlines.
//
// The tolerance here is much tighter than build-countries.mjs uses: county
// borders are only ever drawn when the camera is already zoomed inside a
// state, so their point-to-point spacing has to survive a much closer look.
//
// Run with: node scripts/build-counties.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "../public/data/us_counties.geojson");
const OUT = path.join(__dirname, "../public/data/counties.json");

// Degrees of tolerance. ~0.003deg is ~300m — below the point where the
// simplification is visible at the zoom levels counties appear at, and
// still cuts the point count by well over half.
const TOLERANCE = 0.003;

function sqDistToSegment(p, a, b) {
  let [x, y] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx !== 0 || dy !== 0) {
    const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x -= bx;
      y -= by;
    } else if (t > 0) {
      x -= ax + dx * t;
      y -= ay + dy * t;
    } else {
      x -= ax;
      y -= ay;
    }
  } else {
    x -= ax;
    y -= ay;
  }
  return x * x + y * y;
}

// Ramer-Douglas-Peucker
function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  const sqTolerance = tolerance * tolerance;

  function simplifyRec(pts) {
    let maxDist = 0;
    let index = 0;
    const first = pts[0];
    const last = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) {
      const dist = sqDistToSegment(pts[i], first, last);
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }
    if (maxDist > sqTolerance) {
      const left = simplifyRec(pts.slice(0, index + 1));
      const right = simplifyRec(pts.slice(index));
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  }

  return simplifyRec(points);
}

function simplifyRing(ring) {
  const simplified = simplify(ring, TOLERANCE);
  // 5 decimals is ~1.1m, well under the tolerance above.
  return simplified.map(([lon, lat]) => [
    Math.round(lon * 1e5) / 1e5,
    Math.round(lat * 1e5) / 1e5,
  ]);
}

function extractPolygons(geometry) {
  if (geometry.type === "Polygon") {
    return [geometry.coordinates.map(simplifyRing)];
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.map((poly) => poly.map(simplifyRing));
  }
  return [];
}

function bbox(polygons) {
  let minLon = 180,
    maxLon = -180,
    minLat = 90,
    maxLat = -90;
  for (const poly of polygons) {
    for (const ring of poly) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}

const raw = JSON.parse(readFileSync(SRC, "utf8"));

const counties = raw.features.map((f) => {
  const p = f.properties;
  const polygons = extractPolygons(f.geometry);
  const [minLon, minLat, maxLon, maxLat] = bbox(polygons);
  // Natural Earth ships a hand-placed label point; fall back to the bbox
  // center for the few features that don't have one.
  const lon = typeof p.longitude === "number" ? p.longitude : (minLon + maxLon) / 2;
  const lat = typeof p.latitude === "number" ? p.latitude : (minLat + maxLat) / 2;
  return {
    name: p.NAME || p.NAME_EN || "Unknown",
    region: p.REGION || "",
    lat: Math.round(lat * 1e5) / 1e5,
    lon: Math.round(lon * 1e5) / 1e5,
    bbox: [minLon, minLat, maxLon, maxLat],
    polygons,
  };
});

writeFileSync(OUT, JSON.stringify(counties));

const before = readFileSync(SRC).length;
const after = readFileSync(OUT).length;
console.log(
  `${counties.length} counties, ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`,
);
