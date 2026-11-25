export type LocationErrorCode =
  /** The worker (or the browser settings) refused location access. */
  | "denied"
  /** No position could be determined (indoors, no GPS, OS location off). */
  | "unavailable"
  | "timeout"
  /** No Geolocation API, or the page is not a secure context. */
  | "unsupported";

export class LocationError extends Error {
  override name = "LocationError";
  constructor(readonly code: LocationErrorCode, message: string) {
    super(message);
  }
}

/** The fields CheckInRequest needs, from one position fix. */
export interface CheckInPosition {
  latitude: number;
  longitude: number;
  /** Horizontal accuracy, metres. */
  accuracyM: number;
}

export interface PositionOptions {
  /** Default 20 s. */
  timeoutMs?: number;
  /** Accept a cached fix this old. Default 0 (always measure now). */
  maximumAgeMs?: number;
  /** Replace for tests. Defaults to navigator.geolocation. */
  geolocation?: Pick<Geolocation, "getCurrentPosition">;
}

/**
 * Measures the device position once, with high accuracy. The browser asks the worker for
 * permission the first time. Spread the result into CheckInRequest:
 *
 *     const request = { type: "site_entry", siteId, ...(await currentPosition()) };
 */
export function currentPosition(opts: PositionOptions = {}): Promise<CheckInPosition> {
  const geolocation = opts.geolocation ?? globalThis.navigator?.geolocation;
  if (!geolocation || globalThis.isSecureContext === false) {
    return Promise.reject(new LocationError("unsupported", "location is not available (needs https and the Geolocation API)"));
  }
  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: p.coords.accuracy }),
      (e) => {
        const code: LocationErrorCode = e.code === 1 ? "denied" : e.code === 3 ? "timeout" : "unavailable";
        reject(new LocationError(code, e.message || code));
      },
      { enableHighAccuracy: true, timeout: opts.timeoutMs ?? 20_000, maximumAge: opts.maximumAgeMs ?? 0 },
    );
  });
}
