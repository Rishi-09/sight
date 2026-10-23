import { useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import type { Coords } from './api';

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

export function useLocation() {
  const [coords, setCoords] = useState<Coords>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  // Compass heading in degrees (0 = north). Recorded with each map point for direction-aware guidance.
  const [heading, setHeading] = useState<number | null>(null);
  const subs = useRef<Location.LocationSubscription[]>([]);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      subs.current.push(
        await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 3, timeInterval: 2000 },
          (loc) => {
            setCoords({ lat: loc.coords.latitude, lng: loc.coords.longitude });
            setAccuracy(loc.coords.accuracy ?? null);
          },
        ),
      );
      try {
        subs.current.push(
          await Location.watchHeadingAsync((h) => {
            const value = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
            setHeading(Math.round(value));
          }),
        );
      } catch {
        // No compass (e.g. some emulators): heading stays null.
      }
    })();
    return () => subs.current.forEach((s) => s.remove());
  }, []);

  return { coords, accuracy, heading };
}
