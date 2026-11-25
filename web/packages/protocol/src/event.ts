import { fromBase64Url } from "./encoding.js";
import { canonicalize, type JsonValue } from "./jcs.js";

export const PROTOCOL_VERSION = 2 as const;

/** Device position when the check-in was requested, as integers (JCS allows no floats). */
export interface EventLocation {
  /** Latitude in degrees × 10^7. */
  lat_e7: number;
  /** Longitude in degrees × 10^7. */
  lng_e7: number;
  /** Horizontal accuracy reported by the device, metres. */
  accuracy_m: number;
}

/**
 * A check-in event. The server builds it when the worker app asks to check in
 * (online), and the worker's passkey signs it. Nothing in it comes from the
 * client without the server having fixed it first.
 */
export interface CheckInEvent {
  v: typeof PROTOCOL_VERSION;
  /** Event type from the catalog, e.g. "site_entry". */
  type: string;
  /** Server-issued id of this check-in. One signature per id. */
  checkin_id: string;
  /** Worker device that asked for the check-in. */
  device_id: string;
  /** Site the worker checks in at. */
  site_id: string;
  /** 32 random bytes from the server, base64url. */
  nonce: string;
  /** Server time when the check-in was issued, RFC 3339 UTC. */
  issued_at: string;
  location: EventLocation;
  /** Type-specific extra fields. Covered by the signature. */
  attributes: { [key: string]: JsonValue };
}

export class EventValidationError extends Error {
  override name = "EventValidationError";
}

const EVENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const EVENT_KEYS = ["attributes", "checkin_id", "device_id", "issued_at", "location", "nonce", "site_id", "type", "v"];
const LOCATION_KEYS = ["accuracy_m", "lat_e7", "lng_e7"];
export const MAX_ACCURACY_M = 100_000;

function isInt(v: unknown, min: number, max: number): v is number {
  return Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
}

/** Throws EventValidationError when the value is not a well-formed v2 event. */
export function assertCheckInEvent(value: unknown): asserts value is CheckInEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EventValidationError("event must be an object");
  }
  const e = value as Record<string, unknown>;
  if (Object.keys(e).sort().join(",") !== EVENT_KEYS.join(",")) {
    throw new EventValidationError(`event keys must be exactly: ${EVENT_KEYS.join(", ")}`);
  }
  if (e.v !== PROTOCOL_VERSION) throw new EventValidationError("unsupported protocol version");
  if (typeof e.type !== "string" || !EVENT_TYPE.test(e.type)) throw new EventValidationError("invalid type");
  for (const k of ["checkin_id", "device_id", "site_id"] as const) {
    if (typeof e[k] !== "string" || !ID.test(e[k] as string)) throw new EventValidationError(`invalid ${k}`);
  }
  let nonce: Uint8Array | null = null;
  try {
    if (typeof e.nonce === "string") nonce = fromBase64Url(e.nonce);
  } catch {
    nonce = null;
  }
  if (!nonce || nonce.length !== 32) throw new EventValidationError("nonce must be 32 bytes base64url");
  if (typeof e.issued_at !== "string" || !RFC3339_UTC.test(e.issued_at) || Number.isNaN(Date.parse(e.issued_at))) {
    throw new EventValidationError("issued_at must be RFC 3339 UTC (…Z)");
  }
  const loc = e.location as Record<string, unknown> | null;
  if (typeof loc !== "object" || loc === null || Array.isArray(loc) || Object.keys(loc).sort().join(",") !== LOCATION_KEYS.join(",")) {
    throw new EventValidationError(`location keys must be exactly: ${LOCATION_KEYS.join(", ")}`);
  }
  if (!isInt(loc.lat_e7, -900_000_000, 900_000_000)) throw new EventValidationError("invalid location.lat_e7");
  if (!isInt(loc.lng_e7, -1_800_000_000, 1_800_000_000)) throw new EventValidationError("invalid location.lng_e7");
  if (!isInt(loc.accuracy_m, 0, MAX_ACCURACY_M)) throw new EventValidationError("invalid location.accuracy_m");
  if (typeof e.attributes !== "object" || e.attributes === null || Array.isArray(e.attributes)) {
    throw new EventValidationError("attributes must be an object");
  }
  // Throws on floats, undefined and other values that cannot be canonicalized.
  canonicalize(e.attributes);
}
