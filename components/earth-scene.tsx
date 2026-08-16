"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Canvas,
  useFrame,
  useLoader,
  useThree,
  type ThreeEvent,
} from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import * as THREE from "three";
import type { Group, Mesh } from "three";
import { findCountryAt, loadCountries, type Country } from "@/lib/countries";
import { citiesForZoom, loadCities, type City } from "@/lib/cities";
import { countiesForView, loadCounties, type County } from "@/lib/counties";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_RADIUS = 2;
const EARTH_RADIUS_KM = 6371;
const KM_PER_UNIT = EARTH_RADIUS_KM / EARTH_RADIUS;
const KM_PER_DEG = 111.32;
const CAMERA_FOV = 45;
const STARFIELD_RADIUS = 90;
const HALF_FOV_TAN = Math.tan((CAMERA_FOV / 2) * DEG2RAD);

/** Vertical span of ground visible at a given camera distance, in world units. */
function viewSpanUnits(distance: number) {
  return 2 * Math.max(distance - EARTH_RADIUS, 0) * HALF_FOV_TAN;
}

// How close you're allowed to get: a view ~200m tall top-to-bottom, which
// frames a 10-acre parcel (10 acres is a square about 201m on a side).
const MIN_VIEW_KM = 0.2;
const MIN_DISTANCE =
  EARTH_RADIUS + MIN_VIEW_KM / KM_PER_UNIT / (2 * HALF_FOV_TAN);
const MAX_DISTANCE = 80;

// County outlines start loading a little before they're needed, and are drawn
// once the view is narrower than ~900km — i.e. once you're comfortably inside
// a single state rather than looking at a whole region.
const COUNTY_LOAD_DISTANCE = 3;
const COUNTY_VISIBLE_DISTANCE = 2.35;
const COUNTY_LABEL_LIMIT = 60;

/**
 * Computes where the sun currently is relative to the earth, based on the
 * system clock, as a unit direction vector in the earth's local (unrotated)
 * frame: X = the prime-meridian axis, Y = the polar axis.
 *
 * - Longitude of the subsolar point comes from UTC time of day (ignores the
 *   equation of time, which is at most ~±4 minutes).
 * - Latitude of the subsolar point (solar declination) comes from the day of
 *   year, giving the light a seasonal tilt toward whichever hemisphere is
 *   currently in summer.
 */
function sunDirection(date: Date) {
  const utcHours =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600;

  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / 86400000);

  const subsolarLongitudeDeg = 180 - 15 * utcHours;
  const declinationDeg =
    -23.44 * Math.cos(((360 / 365) * (dayOfYear + 10) * Math.PI) / 180);

  const lon = subsolarLongitudeDeg * DEG2RAD;
  const dec = declinationDeg * DEG2RAD;

  return {
    // Direction toward the sun, fixed at longitude 0 / equator; the earth
    // group is rotated to bring the correct longitude under it instead of
    // moving the light itself.
    lightDir: new THREE.Vector3(Math.cos(dec), Math.sin(dec), 0),
    // Rotation to apply to the earth group so the subsolar longitude faces
    // that fixed light direction.
    earthRotationY: -lon,
  };
}

// Maps (lon, lat) in degrees to a point on the sphere, matching the UV
// convention of the day/night/cloud textures (equirectangular, prime
// meridian centered, north pole at +Y). Must stay consistent with
// sunDirection's rotation math above.
function lonLatToVector3(lon: number, lat: number, radius: number) {
  const lonR = lon * DEG2RAD;
  const latR = lat * DEG2RAD;
  return new THREE.Vector3(
    radius * Math.cos(latR) * Math.cos(lonR),
    radius * Math.sin(latR),
    -radius * Math.cos(latR) * Math.sin(lonR),
  );
}

function useCountries() {
  const [countries, setCountries] = useState<Country[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadCountries().then((data) => {
      if (!cancelled) setCountries(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return countries;
}

function useCities() {
  const [cities, setCities] = useState<City[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadCities().then((data) => {
      if (!cancelled) setCities(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return cities;
}

const tmpParentQuat = new THREE.Quaternion();
const tmpCamQuat = new THREE.Quaternion();
const tmpCamLocalDir = new THREE.Vector3();
// Hide labels once their point on the globe tilts more than ~72° away from
// facing the camera — otherwise labels near the horizon bunch up and get
// visually crushed together by the sphere's curvature.
const HORIZON_COS = Math.cos(72 * DEG2RAD);

/**
 * Lifts its children just off the globe's surface so borders and labels
 * don't z-fight with (or sink into) the sphere.
 *
 * The lift has to track zoom: a fixed offset that looks like a hairline at
 * a whole-earth view is kilometres of parallax error once you're close
 * enough to see a field, which would visibly slide borders away from the
 * ground under them. So children are authored at exactly EARTH_RADIUS and
 * scaled outward here by a fraction of the camera's current altitude.
 */
function SurfaceOverlay({
  lift = 1,
  children,
}: {
  lift?: number;
  children: React.ReactNode;
}) {
  const ref = useRef<Group>(null);
  useFrame(({ camera }) => {
    if (!ref.current) return;
    const altitude = Math.max(camera.position.length() - EARTH_RADIUS, 0);
    const offset = THREE.MathUtils.clamp(
      altitude * 0.004 * lift,
      2e-8 * lift,
      0.006 * lift,
    );
    ref.current.scale.setScalar((EARTH_RADIUS + offset) / EARTH_RADIUS);
  });
  return <group ref={ref}>{children}</group>;
}

type SurfaceLabel = { key: string; text: string; lon: number; lat: number };

/**
 * Renders place-name labels on the globe that face the camera and stay a
 * consistent screen size regardless of zoom. Labels near the horizon are
 * hidden to avoid the clutter/distortion that comes with the sphere's
 * curvature there. Callers decide which labels to pass in for the current
 * zoom; this only handles drawing them.
 */
function SurfaceLabels({
  labels,
  color,
  sizeFactor = 0.0035,
}: {
  labels: SurfaceLabel[];
  color: string;
  sizeFactor?: number;
}) {
  const anchorRef = useRef<Group>(null);
  const labelRefs = useRef<(Group | null)[]>([]);

  // Unit-sphere direction for each label, parallel to `labels` — used for
  // the horizon cull below.
  const dirs = useMemo(
    () => labels.map((label) => lonLatToVector3(label.lon, label.lat, 1)),
    [labels],
  );

  useFrame(({ camera }) => {
    if (!anchorRef.current) return;
    const distance = camera.position.length();
    const parentWorldQuat = anchorRef.current.getWorldQuaternion(tmpParentQuat);
    const labelQuat = camera
      .getWorldQuaternion(tmpCamQuat)
      .premultiply(parentWorldQuat.invert());
    // fontSize is set to 1 below; the actual on-screen size is entirely
    // driven by this scale, chosen so labels stay a roughly constant
    // pixel size on screen regardless of zoom (world size must grow
    // linearly with distance to counteract perspective shrinkage).
    //
    // Close in, what matters is the camera's height above the surface, not
    // its distance from the earth's centre — the two are interchangeable
    // from orbit but not when you're a few hundred metres up, where scaling
    // by distance would blow a single label up to kilometres wide. The
    // altitude term is weighted so the two agree at the old minimum zoom.
    const scale =
      Math.min(distance, (distance - EARTH_RADIUS) * 5) * sizeFactor;
    const camLocalDir = anchorRef.current
      .worldToLocal(tmpCamLocalDir.copy(camera.position))
      .normalize();

    for (let i = 0; i < labelRefs.current.length; i++) {
      const label = labelRefs.current[i];
      if (!label) continue;
      label.quaternion.copy(labelQuat);
      label.scale.setScalar(scale);
      const dir = dirs[i];
      label.visible = !dir || dir.dot(camLocalDir) > HORIZON_COS;
    }
  });

  return (
    <SurfaceOverlay lift={1.6}>
      <group ref={anchorRef}>
        {labels.map((label, i) => (
          <group
            key={label.key}
            position={lonLatToVector3(label.lon, label.lat, EARTH_RADIUS)}
            ref={(el) => {
              labelRefs.current[i] = el;
            }}
            raycast={() => null}
          >
            <Text
              fontSize={1}
              color={color}
              outlineWidth="8%"
              outlineColor="#000000"
              outlineOpacity={0.85}
              anchorX="center"
              anchorY="bottom"
              raycast={() => null}
            >
              {label.text}
            </Text>
          </group>
        ))}
      </group>
    </SurfaceOverlay>
  );
}

/**
 * Which cities are labeled is driven by camera distance (see citiesForZoom)
 * so the globe isn't cluttered with thousands of small-town names at a
 * whole-earth view, but reveals more detail as you zoom in.
 */
function CityLabels({ cities }: { cities: City[] | null }) {
  const [visible, setVisible] = useState<City[]>([]);
  const lastDistanceBucket = useRef<number | null>(null);

  useFrame(({ camera }) => {
    if (!cities) return;
    // Quantize so we only recompute (and re-lay-out text meshes) when the
    // zoom has changed meaningfully, not on every frame.
    const bucket = Math.round(camera.position.length() * 4) / 4;
    if (lastDistanceBucket.current !== bucket) {
      lastDistanceBucket.current = bucket;
      setVisible(citiesForZoom(cities, camera.position.length()));
    }
  });

  const labels = useMemo(
    () =>
      visible.map((city) => ({
        key: `${city.name}-${city.lat}-${city.lon}`,
        text: city.name,
        lon: city.lon,
        lat: city.lat,
      })),
    [visible],
  );

  return <SurfaceLabels labels={labels} color="#ffffff" />;
}

/** Builds a line-segment geometry for every ring of every given polygon. */
function ringGeometry(polygonSets: Country["polygons"][]) {
  const positions: number[] = [];
  for (const polygons of polygonSets) {
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (let i = 0; i < ring.length; i++) {
          const [lon1, lat1] = ring[i];
          const [lon2, lat2] = ring[(i + 1) % ring.length];
          const a = lonLatToVector3(lon1, lat1, EARTH_RADIUS);
          const b = lonLatToVector3(lon2, lat2, EARTH_RADIUS);
          positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
      }
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geom;
}

function CountryBorder({ country }: { country: Country | null }) {
  const geometry = useMemo(
    () => (country ? ringGeometry([country.polygons]) : null),
    [country],
  );

  useEffect(() => () => geometry?.dispose(), [geometry]);

  if (!geometry) return null;
  return (
    <SurfaceOverlay>
      <lineSegments geometry={geometry} renderOrder={2} raycast={() => null}>
        <lineBasicMaterial
          color="#ffd54a"
          toneMapped={false}
          depthWrite={false}
        />
      </lineSegments>
    </SurfaceOverlay>
  );
}

const tmpCamLocal = new THREE.Vector3();

/**
 * Draws US county outlines and names once the camera is close enough to be
 * looking inside a single state.
 *
 * The county file is ~2.6MB, so it isn't fetched at all until you approach
 * that zoom level, and only the counties whose bounding boxes fall in the
 * current view get turned into geometry — at a low enough zoom that's still
 * hundreds of counties, so the selection is recomputed only when the view
 * has actually moved or zoomed, not every frame.
 */
function CountyLayer() {
  const anchorRef = useRef<Group>(null);
  const [counties, setCounties] = useState<County[] | null>(null);
  const requested = useRef(false);
  const [visible, setVisible] = useState<County[]>([]);
  const lastViewKey = useRef<string | null>(null);

  useFrame(({ camera }) => {
    const distance = camera.position.length();

    if (distance < COUNTY_LOAD_DISTANCE && !requested.current) {
      requested.current = true;
      loadCounties().then(setCounties);
    }
    if (!counties || !anchorRef.current) return;

    if (distance > COUNTY_VISIBLE_DISTANCE) {
      if (visible.length > 0) {
        lastViewKey.current = null;
        setVisible([]);
      }
      return;
    }

    // The point on the globe the camera is over, in the earth group's
    // rotating frame (the same frame the county coordinates live in).
    const local = anchorRef.current
      .worldToLocal(tmpCamLocal.copy(camera.position))
      .normalize();
    const lat = Math.asin(THREE.MathUtils.clamp(local.y, -1, 1)) * RAD2DEG;
    const lon = Math.atan2(-local.z, local.x) * RAD2DEG;

    // Half the visible ground span, in degrees, plus half again as margin so
    // counties are ready before a pan brings them on screen.
    const radiusDeg =
      ((viewSpanUnits(distance) * KM_PER_UNIT) / KM_PER_DEG) * 0.75;

    const cell = radiusDeg * 0.25;
    const key = `${Math.round(lon / cell)}:${Math.round(lat / cell)}:${Math.round(
      Math.log(distance - EARTH_RADIUS) * 4,
    )}`;
    if (key !== lastViewKey.current) {
      lastViewKey.current = key;
      setVisible(countiesForView(counties, lon, lat, radiusDeg));
    }
  });

  const geometry = useMemo(
    () =>
      visible.length > 0
        ? ringGeometry(visible.map((county) => county.polygons))
        : null,
    [visible],
  );

  useEffect(() => () => geometry?.dispose(), [geometry]);

  // countiesForView returns nearest-first, so the label cap trims the
  // counties furthest from the middle of the view.
  const labels = useMemo(
    () =>
      visible.slice(0, COUNTY_LABEL_LIMIT).map((county) => ({
        key: `${county.region}-${county.name}-${county.lat}`,
        text: county.name,
        lon: county.lon,
        lat: county.lat,
      })),
    [visible],
  );

  return (
    <group ref={anchorRef}>
      {geometry && (
        <SurfaceOverlay>
          <lineSegments geometry={geometry} renderOrder={1} raycast={() => null}>
            <lineBasicMaterial
              color="#7fd4ff"
              toneMapped={false}
              transparent
              opacity={0.55}
              depthWrite={false}
            />
          </lineSegments>
        </SurfaceOverlay>
      )}
      <SurfaceLabels labels={labels} color="#cfe9ff" sizeFactor={0.0026} />
    </group>
  );
}

const CLOUD_OPACITY = 0.4;
// The cloud shell sits 48km above the ground. That reads as a thin haze from
// orbit, but once the camera is low it's a blurry sheet directly overhead
// with wildly wrong parallax, so fade it out on the way down.
const CLOUD_FADE_START = 2.6;
const CLOUD_FADE_END = 2.15;

function Earth() {
  const groupRef = useRef<Group>(null);
  const cloudsRef = useRef<Mesh>(null);
  const cloudMaterialRef = useRef<THREE.MeshStandardMaterial>(null);
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const cloudDrift = useRef(0);

  const countries = useCountries();
  const [hovered, setHovered] = useState<Country | null>(null);
  const lastHitTest = useRef(0);
  const cities = useCities();

  const [dayMap, cloudsMap, nightMap, normalMap, specularMap] = useLoader(
    THREE.TextureLoader,
    [
      "/textures/8k_earth_daymap.jpg",
      "/textures/8k_earth_clouds.jpg",
      "/textures/8k_earth_nightmap.jpg",
      "/textures/8k_earth_normal_map.jpg",
      "/textures/8k_earth_specular_map.jpg",
    ],
  );

  const normalScale = useMemo(() => new THREE.Vector2(0.85, 0.85), []);

  const handlePointerMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!countries) return;
      const now = performance.now();
      if (now - lastHitTest.current < 50) return;
      lastHitTest.current = now;

      e.stopPropagation();
      const local = e.object.worldToLocal(e.point.clone());
      const r = local.length();
      const lat = Math.asin(THREE.MathUtils.clamp(local.y / r, -1, 1)) * RAD2DEG;
      const lon = Math.atan2(-local.z, local.x) * RAD2DEG;

      const found = findCountryAt(countries, lon, lat);
      setHovered((prev) => (prev?.iso === found?.iso ? prev : found));
    },
    [countries],
  );

  const handlePointerOut = useCallback(() => setHovered(null), []);

  useFrame(({ camera }, delta) => {
    const { lightDir, earthRotationY } = sunDirection(new Date());

    if (cloudMaterialRef.current && cloudsRef.current) {
      const t = THREE.MathUtils.clamp(
        (camera.position.length() - CLOUD_FADE_END) /
          (CLOUD_FADE_START - CLOUD_FADE_END),
        0,
        1,
      );
      cloudMaterialRef.current.opacity = CLOUD_OPACITY * t;
      cloudsRef.current.visible = t > 0;
    }

    if (lightRef.current) {
      lightRef.current.position.copy(lightDir).multiplyScalar(10);
    }
    if (groupRef.current) {
      groupRef.current.rotation.y = earthRotationY;
    }
    // Clouds drift independently of the earth's surface, slowly.
    cloudDrift.current += delta * 0.006;
    if (cloudsRef.current) {
      cloudsRef.current.rotation.y = earthRotationY + cloudDrift.current;
    }
  });

  return (
    <>
      <directionalLight ref={lightRef} intensity={2.4} />
      <group ref={groupRef}>
        <mesh onPointerMove={handlePointerMove} onPointerOut={handlePointerOut}>
          {/*
            Densely tessellated because overlays (borders, labels) are placed
            on the ideal sphere: at 128 segments the faceted mesh sags up to
            ~2km below that, which is invisible from orbit but slides borders
            visibly off the ground once you're low. 512x256 brings the sag
            down to ~120m.
          */}
          <sphereGeometry args={[EARTH_RADIUS, 512, 256]} />
          <meshPhongMaterial
            map={dayMap}
            normalMap={normalMap}
            normalScale={normalScale}
            specularMap={specularMap}
            specular={new THREE.Color(0x333333)}
            shininess={12}
            emissiveMap={nightMap}
            emissive={new THREE.Color(0xffffff)}
            emissiveIntensity={1.4}
          />
        </mesh>
        <CountryBorder country={hovered} />
        <CountyLayer />
        <CityLabels cities={cities} />
      </group>
      <mesh ref={cloudsRef} raycast={() => null}>
        <sphereGeometry args={[2.015, 128, 128]} />
        <meshStandardMaterial
          ref={cloudMaterialRef}
          map={cloudsMap}
          transparent
          opacity={CLOUD_OPACITY}
          depthWrite={false}
        />
      </mesh>
    </>
  );
}

// Each wheel notch multiplies the camera's *altitude* by this.
const ZOOM_STEP = 1.18;

/**
 * Replaces OrbitControls' dolly with one that steps by altitude above the
 * surface rather than by distance from the earth's centre.
 *
 * OrbitControls scales its orbit radius by a fixed ratio per notch. Over
 * this zoom range that's useless at the bottom: one 5% notch from a radius
 * of 2.1 (≈320km up) overshoots straight through the ground to the minimum,
 * so every zoom level below "continent" would be two notches wide. Scaling
 * altitude instead makes each notch cover the same *proportion* of the
 * remaining descent, so the whole range from orbit to a field is reachable.
 */
function AltitudeZoom() {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls);

  useEffect(() => {
    const element = gl.domElement;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();

      const distance = camera.position.length();
      const altitude = Math.max(distance - EARTH_RADIUS, MIN_DISTANCE - EARTH_RADIUS);
      const stepped = altitude * Math.pow(ZOOM_STEP, Math.sign(event.deltaY));
      const next = THREE.MathUtils.clamp(
        EARTH_RADIUS + stepped,
        MIN_DISTANCE,
        MAX_DISTANCE,
      );

      // Dolly along the line to the orbit target, so panning still works.
      const target = (controls as { target?: THREE.Vector3 } | null)?.target;
      const scale = next / distance;
      if (target) {
        camera.position.sub(target).multiplyScalar(scale).add(target);
      } else {
        camera.position.multiplyScalar(scale);
      }
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [gl, camera, controls]);

  return null;
}

/**
 * Keeps the camera's clip planes matched to how close it is to the ground.
 *
 * A fixed near plane can't span this zoom range: the default 0.1 would clip
 * away the entire globe long before the camera got within a few hundred
 * metres of it. So near tracks altitude, far only has to reach past the
 * starfield, and the resulting ~1e8 depth range is handled by the
 * logarithmic depth buffer enabled on the Canvas.
 *
 * This also re-clamps the camera against the earth's centre. OrbitControls'
 * minDistance is measured from its target, which panning can drag away from
 * the origin — without this you could pan your way underground.
 */
function CameraLimits() {
  useFrame(({ camera, controls }) => {
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.position.length() < MIN_DISTANCE) {
      cam.position.setLength(MIN_DISTANCE);
    }

    const distance = cam.position.length();

    // OrbitControls scales a pan drag by the distance to its target, which
    // is the earth's centre — so a full-screen drag would move you ~5000km
    // no matter how low you are. Rescale it to the camera's altitude, which
    // is what a drag should actually cover; at orbital distances the two are
    // nearly the same and this is a no-op.
    const orbit = controls as { panSpeed?: number } | null;
    if (orbit && typeof orbit.panSpeed === "number") {
      orbit.panSpeed = Math.max((distance - EARTH_RADIUS) / distance, 1e-6);
    }
    const near = Math.max((distance - EARTH_RADIUS) * 0.05, 1e-6);
    const far = distance + STARFIELD_RADIUS * 2;
    if (cam.near !== near || cam.far !== far) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
  });
  return null;
}

function Starfield() {
  const starsMap = useLoader(THREE.TextureLoader, "/textures/8k_stars.jpg");
  return (
    <mesh raycast={() => null}>
      <sphereGeometry args={[STARFIELD_RADIUS, 64, 64]} />
      <meshBasicMaterial map={starsMap} side={THREE.BackSide} />
    </mesh>
  );
}

export default function EarthScene() {
  return (
    <div className="h-screen w-screen">
      <Canvas
        camera={{ position: [0, 0, 6], fov: CAMERA_FOV }}
        gl={{ logarithmicDepthBuffer: true }}
      >
        <ambientLight intensity={0.12} />
        <CameraLimits />
        <Suspense fallback={null}>
          <Starfield />
          <Earth />
        </Suspense>
        <AltitudeZoom />
        <OrbitControls
          makeDefault
          enablePan
          enableZoom={false}
          enableRotate
          minDistance={MIN_DISTANCE}
          maxDistance={MAX_DISTANCE}
        />
      </Canvas>
    </div>
  );
}
