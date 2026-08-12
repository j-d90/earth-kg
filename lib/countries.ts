export type Ring = [number, number][]; // [lon, lat] pairs
export type Polygon = Ring[]; // rings[0] = outer, rest = holes
export type Country = {
  name: string;
  iso: string;
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  polygons: Polygon[];
};

let cache: Promise<Country[]> | null = null;

export function loadCountries(): Promise<Country[]> {
  if (!cache) {
    cache = fetch("/data/countries.json").then((res) => {
      if (!res.ok) throw new Error(`Failed to load countries.json: ${res.status}`);
      return res.json();
    });
  }
  return cache;
}

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  // Standard ray-casting point-in-polygon test.
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lon: number, lat: number, polygon: Polygon): boolean {
  if (!pointInRing(lon, lat, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(lon, lat, polygon[i])) return false; // inside a hole
  }
  return true;
}

function inBBox(lon: number, lat: number, bbox: Country["bbox"]) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

export function findCountryAt(
  countries: Country[],
  lon: number,
  lat: number,
): Country | null {
  for (const country of countries) {
    if (!inBBox(lon, lat, country.bbox)) continue;
    for (const polygon of country.polygons) {
      if (pointInPolygon(lon, lat, polygon)) return country;
    }
  }
  return null;
}
