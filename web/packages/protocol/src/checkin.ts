import { bytesEqual, fromBase64Url } from "./encoding.js";
import { canonicalize, type JsonValue } from "./jcs.js";
import { computeChallenge } from "./challenge.js";
import { assertCheckInEvent, type CheckInEvent } from "./event.js";
import { toE7 } from "./geo.js";

/** Body of POST /v1/devices/{device_id}/checkins (worker app → server). */
export interface CheckInRequest {
  type: string;
  site_id: string;
  location: { latitude: number; longitude: number; accuracy_m: number };
  attributes?: { [key: string]: JsonValue };
}

/** Response of POST /v1/devices/{device_id}/checkins. */
export interface IssuedCheckIn {
  checkin_id: string;
  event: CheckInEvent;
  /** base64url SHA-256 challenge for the passkey (see computeChallenge). */
  challenge: string;
  expires_at: string;
  rp_id: string;
  /** Credential ids (base64url) of the worker's passkeys. */
  allow_credentials: string[];
}

/** WebAuthn assertion in the standard JSON form (AuthenticationResponseJSON). */
export interface AssertionJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
  clientExtensionResults?: Record<string, unknown>;
  authenticatorAttachment?: string | null;
}

/** Body of POST /v1/devices/{device_id}/checkins/{checkin_id}/complete. */
export interface CompleteCheckInRequest {
  assertion: AssertionJSON;
}

/** The signed evidence kept for each check-in. Anyone with the passkey's public key can re-verify it. */
export interface CheckInRecord {
  event: CheckInEvent;
  assertion: AssertionJSON;
}

export class IssuedCheckInMismatch extends Error {
  override name = "IssuedCheckInMismatch";
}

/**
 * Worker app side, before showing the passkey prompt: checks that the event the
 * server wants signed is what the app asked for, and that the challenge is
 * really derived from it. Returns the challenge bytes to hand to the passkey.
 */
export async function checkIssuedCheckIn(deviceId: string, requested: CheckInRequest, issued: IssuedCheckIn): Promise<Uint8Array> {
  const e = issued.event;
  assertCheckInEvent(e);
  const mismatch = (what: string) => new IssuedCheckInMismatch(`issued event does not match the request: ${what}`);
  if (e.checkin_id !== issued.checkin_id) throw mismatch("checkin_id");
  if (e.device_id !== deviceId) throw mismatch("device_id");
  if (e.type !== requested.type) throw mismatch("type");
  if (e.site_id !== requested.site_id) throw mismatch("site_id");
  if (Math.abs(e.location.lat_e7 - toE7(requested.location.latitude)) > 1) throw mismatch("location.lat_e7");
  if (Math.abs(e.location.lng_e7 - toE7(requested.location.longitude)) > 1) throw mismatch("location.lng_e7");
  if (e.location.accuracy_m !== Math.ceil(requested.location.accuracy_m)) throw mismatch("location.accuracy_m");
  if (canonicalize(e.attributes) !== canonicalize(requested.attributes ?? {})) throw mismatch("attributes");
  const challenge = await computeChallenge(e);
  if (!bytesEqual(challenge, fromBase64Url(issued.challenge))) throw mismatch("challenge");
  return challenge;
}
