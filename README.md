# earth.js

A full-screen, real-time 3D globe built with [Next.js](https://nextjs.org), [three.js](https://threejs.org), [react-three-fiber](https://docs.pmnd.rs/react-three-fiber), and [drei](https://github.com/pmndrs/drei).

## Features

- Fullscreen, pannable/zoomable earth (`OrbitControls`) rendered from 8K day, night, cloud, normal, and specular maps, with a starfield backdrop.
- The day/night terminator tracks the system clock: earth rotation and sun declination are computed live from UTC time and day-of-year, so the lit hemisphere always matches real-world day/night.
- Hovering the globe highlights the country under the cursor with a border outline, using simplified Natural Earth country polygons for hit-testing.
- City name labels fade in progressively as you zoom in — only the world's major cities are shown from a full-globe view, with smaller cities appearing as you get closer, capped so the label count never gets out of hand.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view it.

## Project structure

- `app/page.tsx` — renders the `EarthScene` client component full-screen.
- `components/earth-scene.tsx` — the `Canvas`, lighting/sun-position logic, earth/cloud/starfield meshes, country hover-border rendering, and zoom-dependent city labels.
- `lib/countries.ts` — loads and caches the simplified country polygon data, plus point-in-polygon hit-testing.
- `lib/cities.ts` — loads and caches the simplified city data, plus the camera-distance → visible-cities logic.
- `public/textures/` — 8K earth texture maps (day, night, clouds, normal, specular) and the stars background.
- `public/data/` — country boundary and city data (see below).

## Country boundary and city data

`public/data/ne_10m_admin_0_countries.geojson` and `public/data/ne_10m_populated_places_simple.geojson` are the source [Natural Earth](https://www.naturalearthdata.com/) datasets (10m admin-0 countries, ~13MB; populated places, ~5MB). They're preprocessed into `public/data/countries.json` (~2MB) and `public/data/cities.json` (~0.5MB) by stripping unused properties, simplifying each country's polygons (Ramer–Douglas–Peucker), and pre-sorting cities by population — so the client isn't hit-testing hundreds of thousands of polygon vertices or sorting thousands of cities at runtime.

If you replace either source file, regenerate the simplified ones with:

```bash
npm run build:countries
npm run build:cities
```

## Learn more

- [Next.js Documentation](https://nextjs.org/docs)
- [react-three-fiber Documentation](https://docs.pmnd.rs/react-three-fiber/getting-started/introduction)
- [drei Documentation](https://github.com/pmndrs/drei#readme)
