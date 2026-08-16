import type { Polygon } from "./countries";

export type County = {
  name: string;
  region: string; // 2-letter USPS state code, e.g. "WA"
  lat: number; // Natural Earth's hand-placed label anchor
  lon: number;
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  polygons: Polygon[];
};

let cache: Promise<County[]> | null = null;

// Built from public/data/us_counties.geojson by scripts/build-counties.mjs.
// ~2.6MB, so this is only ever called once the camera is close enough for
// counties to actually be drawn (see COUNTY_LOAD_DISTANCE in earth-scene).
export function loadCounties(): Promise<County[]> {
  if (!cache) {
    cache = fetch("/data/counties.json").then((res) => {
      if (!res.ok) throw new Error(`Failed to load counties.json: ${res.status}`);
      return res.json();
    });
  }
  return cache;
}

function bboxIntersects(
  bbox: County["bbox"],
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
) {
  return !(
    bbox[2] < minLon ||
    bbox[0] > maxLon ||
    bbox[3] < minLat ||
    bbox[1] > maxLat
  );
}

/**
 * Picks the counties that could be on screen, given the lon/lat the camera
 * is looking at and how far the view reaches from that point in degrees of
 * latitude.
 *
 * The window is widened in longitude by 1/cos(lat) because a degree of
 * longitude covers less ground the further you are from the equator. Results
 * come back nearest-first, so callers can both rely on the `cap` (which
 * exists to bound geometry rebuild cost, not to hide anything you'd actually
 * be looking at) trimming the outermost counties, and take a prefix when they
 * want fewer still — labels are much more expensive per county than lines.
 */
export function countiesForView(
  counties: County[],
  lon: number,
  lat: number,
  radiusDeg: number,
  cap = 300,
): County[] {
  const lonScale = 1 / Math.max(Math.cos(lat * (Math.PI / 180)), 0.05);
  const lonRadius = Math.min(radiusDeg * lonScale, 180);

  const inView: { county: County; distSq: number }[] = [];
  for (const county of counties) {
    if (
      !bboxIntersects(
        county.bbox,
        lon - lonRadius,
        lat - radiusDeg,
        lon + lonRadius,
        lat + radiusDeg,
      )
    ) {
      continue;
    }
    const dLat = county.lat - lat;
    const dLon = (county.lon - lon) / lonScale;
    inView.push({ county, distSq: dLat * dLat + dLon * dLon });
  }

  inView.sort((a, b) => a.distSq - b.distSq);
  if (inView.length > cap) inView.length = cap;
  return inView.map((entry) => entry.county);
}
