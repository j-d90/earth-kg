"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas, useFrame, useLoader, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { Group, Mesh } from "three";
import { findCountryAt, loadCountries, type Country } from "@/lib/countries";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_RADIUS = 2;
const BORDER_RADIUS = EARTH_RADIUS + 0.006;

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

function CountryBorder({ country }: { country: Country | null }) {
  const geometry = useMemo(() => {
    if (!country) return null;
    const positions: number[] = [];
    for (const polygon of country.polygons) {
      for (const ring of polygon) {
        for (let i = 0; i < ring.length; i++) {
          const [lon1, lat1] = ring[i];
          const [lon2, lat2] = ring[(i + 1) % ring.length];
          const a = lonLatToVector3(lon1, lat1, BORDER_RADIUS);
          const b = lonLatToVector3(lon2, lat2, BORDER_RADIUS);
          positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geom;
  }, [country]);

  useEffect(() => () => geometry?.dispose(), [geometry]);

  if (!geometry) return null;
  return (
    <lineSegments geometry={geometry} renderOrder={2}>
      <lineBasicMaterial color="#ffd54a" toneMapped={false} depthWrite={false} />
    </lineSegments>
  );
}

function Earth() {
  const groupRef = useRef<Group>(null);
  const cloudsRef = useRef<Mesh>(null);
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const cloudDrift = useRef(0);

  const countries = useCountries();
  const [hovered, setHovered] = useState<Country | null>(null);
  const lastHitTest = useRef(0);

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

  useFrame((_, delta) => {
    const { lightDir, earthRotationY } = sunDirection(new Date());

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
          <sphereGeometry args={[2, 128, 128]} />
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
      </group>
      <mesh ref={cloudsRef} raycast={() => null}>
        <sphereGeometry args={[2.015, 128, 128]} />
        <meshStandardMaterial
          map={cloudsMap}
          transparent
          opacity={0.4}
          depthWrite={false}
        />
      </mesh>
    </>
  );
}

function Starfield() {
  const starsMap = useLoader(THREE.TextureLoader, "/textures/8k_stars.jpg");
  return (
    <mesh raycast={() => null}>
      <sphereGeometry args={[90, 64, 64]} />
      <meshBasicMaterial map={starsMap} side={THREE.BackSide} />
    </mesh>
  );
}

export default function EarthScene() {
  return (
    <div className="h-screen w-screen">
      <Canvas camera={{ position: [0, 0, 6], fov: 45 }}>
        <ambientLight intensity={0.12} />
        <Suspense fallback={null}>
          <Starfield />
          <Earth />
        </Suspense>
        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={2.5}
          maxDistance={80}
        />
      </Canvas>
    </div>
  );
}
