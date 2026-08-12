# earth.js

A full-screen, real-time 3D globe built with [Next.js](https://nextjs.org), [three.js](https://threejs.org), [react-three-fiber](https://docs.pmnd.rs/react-three-fiber), and [drei](https://github.com/pmndrs/drei).

## Features

- Fullscreen, pannable/zoomable earth (`OrbitControls`) rendered from 8K day, night, cloud, normal, and specular maps, with a starfield backdrop.
- The day/night terminator tracks the system clock: earth rotation and sun declination are computed live from UTC time and day-of-year, so the lit hemisphere always matches real-world day/night.
- Hovering the globe highlights the country under the cursor with a border outline, using simplified Natural Earth country polygons for hit-testing.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view it.

## Project structure

- `app/page.tsx` — renders the `EarthScene` client component full-screen.
- `components/earth-scene.tsx` — the `Canvas`, lighting/sun-position logic, earth/cloud/starfield meshes, and country hover-border rendering.
- `lib/countries.ts` — loads and caches the simplified country polygon data, plus point-in-polygon hit-testing.
- `public/textures/` — 8K earth texture maps (day, night, clouds, normal, specular) and the stars background.
- `public/data/` — country boundary data (see below).

## Country boundary data

`public/data/ne_10m_admin_0_countries.geojson` is the source [Natural Earth](https://www.naturalearthdata.com/) 10m admin-0 countries dataset (~13MB). It's preprocessed into `public/data/countries.json` (~2MB) by stripping unused properties and simplifying each country's polygons (Ramer–Douglas–Peucker), so the client isn't hit-testing hundreds of thousands of vertices on every pointer move.

If you replace the source geojson, regenerate the simplified file with:

```bash
npm run build:countries
```

## Learn more

- [Next.js Documentation](https://nextjs.org/docs)
- [react-three-fiber Documentation](https://docs.pmnd.rs/react-three-fiber/getting-started/introduction)
- [drei Documentation](https://github.com/pmndrs/drei#readme)
