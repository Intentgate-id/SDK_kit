import { canonicalize } from "./jcs.js";
import { concatBytes, sha256, utf8 } from "./encoding.js";
import { assertCheckInEvent, type CheckInEvent } from "./event.js";

export const CHALLENGE_DOMAIN = "intentgate-basic-auth/v2";

/**
 * challenge = SHA-256( "intentgate-basic-auth/v2" || 0x00 || JCS(event) )
 *
 * The passkey signs clientDataJSON, which carries this challenge, so the
 * signature covers the type, site, device, location, time and server nonce.
 */
export async function computeChallenge(event: CheckInEvent): Promise<Uint8Array> {
  assertCheckInEvent(event);
  return sha256(concatBytes(utf8(CHALLENGE_DOMAIN), new Uint8Array([0]), utf8(canonicalize(event))));
}
