/** Degrees → integer degrees × 10^7 (about 1 cm). */
export function toE7(degrees: number): number {
  return Math.round(degrees * 1e7);
}

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in whole metres between two points given in degrees × 10^7. */
export function distanceMeters(latE7a: number, lngE7a: number, latE7b: number, lngE7b: number): number {
  const rad = (e7: number) => (e7 / 1e7) * (Math.PI / 180);
  const dLat = rad(latE7b - latE7a);
  const dLng = rad(lngE7b - lngE7a);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(latE7a)) * Math.cos(rad(latE7b)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}
