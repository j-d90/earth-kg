// One-off preprocessing: turns the ~13MB Natural Earth 10m countries file
// into a small file the client can fetch cheaply, by dropping every
// property except name/iso, and simplifying each ring's point count with
// Douglas-Peucker so the globe doesn't have to hit-test hundreds of
// thousands of vertices on every pointer move.
//
// Run with: node scripts/build-countries.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "../public/data/ne_10m_admin_0_countries.geojson");
const OUT = path.join(__dirname, "../public/data/countries.json");

// Degrees of tolerance. ~0.03deg is a few km at the equator — plenty for a
// globe rendered at screen size, and cuts point counts by ~90%+.
const TOLERANCE = 0.03;

function sqDistToSegment(p, a, b) {
  let [x, y] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  let dx = bx - ax;
  let dy = by - ay;
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
  // Keep rounding modest (5 decimals ~1.1m) — the real size win is fewer
  // points, not fewer digits.
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

const countries = raw.features.map((f) => {
  const polygons = extractPolygons(f.geometry);
  return {
    name: f.properties.NAME || f.properties.ADMIN || "Unknown",
    iso: f.properties.ISO_A3 || f.properties.ADM0_A3 || "",
    bbox: bbox(polygons),
    polygons,
  };
});

writeFileSync(OUT, JSON.stringify(countries));

const before = readFileSync(SRC).length;
const after = readFileSync(OUT).length;
console.log(
  `${countries.length} countries, ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`,
);
