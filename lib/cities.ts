export type City = {
  name: string;
  lat: number;
  lon: number;
  scalerank: number; // 0 = major world city, 10 = smallest town in the dataset
  pop: number;
};

let cache: Promise<City[]> | null = null;

// Pre-sorted by population (descending) by scripts/build-cities.mjs.
export function loadCities(): Promise<City[]> {
  if (!cache) {
    cache = fetch("/data/cities.json").then((res) => {
      if (!res.ok) throw new Error(`Failed to load cities.json: ${res.status}`);
      return res.json();
    });
  }
  return cache;
}

/**
 * Picks which cities should be labeled for a given camera distance: fewer,
 * more-important cities when zoomed out, progressively more (and smaller)
 * cities as the camera gets closer, capped so the label count never grows
 * unbounded.
 */
export function citiesForZoom(
  cities: City[],
  distance: number,
  { minDistance = 2.5, maxDistance = 80 } = {},
): City[] {
  const d = Math.min(Math.max(distance, minDistance), maxDistance);
  // 0 = fully zoomed out, 1 = fully zoomed in. Logarithmic so the transition
  // feels even at both ends of the (large) distance range.
  const t =
    1 -
    (Math.log(d) - Math.log(minDistance)) /
      (Math.log(maxDistance) - Math.log(minDistance));

  // Quartic easing: stays sparse through most of the range and only opens
  // up once you're genuinely zoomed in close. There's no label-collision
  // avoidance here, just population/importance-based filtering, so a
  // whole-earth view needs to stay conservative or dense regions (US East
  // Coast, Europe) turn into overlapping text soup.
  const eased = t * t * t * t;
  const maxScalerank = Math.round(1 + eased * 7); // 1 at far, 8 at near
  const cap = Math.round(10 + eased * 240); // 10 at far, 250 at near

  const picked: City[] = [];
  for (const city of cities) {
    if (city.scalerank <= maxScalerank) {
      picked.push(city);
      if (picked.length >= cap) break;
    }
  }
  return picked;
}
