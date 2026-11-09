// Generated from the Intentgate SDK sources. Runs only with a test key (igk_test_...).

var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder("utf-8", { fatal: true });
function utf8(text) {
  return textEncoder.encode(text);
}
function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
var BASE64URL = /^[A-Za-z0-9_-]*$/;
function fromBase64Url(text) {
  if (!BASE64URL.test(text) || text.length % 4 === 1) {
    throw new TypeError("invalid base64url");
  }
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

var CanonicalizationError = class extends Error {
  name = "CanonicalizationError";
};
function canonicalize(value) {
  return write(value, "$");
}
function write(value, path) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalizationError(`${path}: only safe integers are allowed (got ${value})`);
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((v, i) => write(v, `${path}[${i}]`)).join(",") + "]";
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError(`${path}: only plain objects are allowed`);
      }
      const record = value;
      const keys = Object.keys(record).sort();
      const members = [];
      for (const key of keys) {
        const v = record[key];
        if (v === void 0) throw new CanonicalizationError(`${path}.${key}: undefined is not allowed`);
        members.push(JSON.stringify(key) + ":" + write(v, `${path}.${key}`));
      }
      return "{" + members.join(",") + "}";
    }
    default:
      throw new CanonicalizationError(`${path}: unsupported type ${typeof value}`);
  }
}

var PROTOCOL_VERSION = 2;
var EventValidationError = class extends Error {
  name = "EventValidationError";
};
var EVENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
var ID = /^[A-Za-z0-9_-]{1,128}$/;
var RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
var EVENT_KEYS = ["attributes", "checkin_id", "device_id", "issued_at", "location", "nonce", "site_id", "type", "v"];
var LOCATION_KEYS = ["accuracy_m", "lat_e7", "lng_e7"];
var MAX_ACCURACY_M = 1e5;
function isInt(v, min, max) {
  return Number.isSafeInteger(v) && v >= min && v <= max;
}
function assertCheckInEvent(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EventValidationError("event must be an object");
  }
  const e = value;
  if (Object.keys(e).sort().join(",") !== EVENT_KEYS.join(",")) {
    throw new EventValidationError(`event keys must be exactly: ${EVENT_KEYS.join(", ")}`);
  }
  if (e.v !== PROTOCOL_VERSION) throw new EventValidationError("unsupported protocol version");
  if (typeof e.type !== "string" || !EVENT_TYPE.test(e.type)) throw new EventValidationError("invalid type");
  for (const k of ["checkin_id", "device_id", "site_id"]) {
    if (typeof e[k] !== "string" || !ID.test(e[k])) throw new EventValidationError(`invalid ${k}`);
  }
  let nonce = null;
  try {
    if (typeof e.nonce === "string") nonce = fromBase64Url(e.nonce);
  } catch {
    nonce = null;
  }
  if (!nonce || nonce.length !== 32) throw new EventValidationError("nonce must be 32 bytes base64url");
  if (typeof e.issued_at !== "string" || !RFC3339_UTC.test(e.issued_at) || Number.isNaN(Date.parse(e.issued_at))) {
    throw new EventValidationError("issued_at must be RFC 3339 UTC (\u2026Z)");
  }
  const loc = e.location;
  if (typeof loc !== "object" || loc === null || Array.isArray(loc) || Object.keys(loc).sort().join(",") !== LOCATION_KEYS.join(",")) {
    throw new EventValidationError(`location keys must be exactly: ${LOCATION_KEYS.join(", ")}`);
  }
  if (!isInt(loc.lat_e7, -9e8, 9e8)) throw new EventValidationError("invalid location.lat_e7");
  if (!isInt(loc.lng_e7, -18e8, 18e8)) throw new EventValidationError("invalid location.lng_e7");
  if (!isInt(loc.accuracy_m, 0, MAX_ACCURACY_M)) throw new EventValidationError("invalid location.accuracy_m");
  if (typeof e.attributes !== "object" || e.attributes === null || Array.isArray(e.attributes)) {
    throw new EventValidationError("attributes must be an object");
  }
  canonicalize(e.attributes);
}

var CHALLENGE_DOMAIN = "intentgate-basic-auth/v2";
async function computeChallenge(event) {
  assertCheckInEvent(event);
  return sha256(concatBytes(utf8(CHALLENGE_DOMAIN), new Uint8Array([0]), utf8(canonicalize(event))));
}

function toE7(degrees) {
  return Math.round(degrees * 1e7);
}

var IssuedCheckInMismatch = class extends Error {
  name = "IssuedCheckInMismatch";
};
async function checkIssuedCheckIn(deviceId, requested, issued) {
  const e = issued.event;
  assertCheckInEvent(e);
  const mismatch = (what) => new IssuedCheckInMismatch(`issued event does not match the request: ${what}`);
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

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
var FakePasskey = class {
  constructor(rpId, origin) {
    this.rpId = rpId;
    this.origin = origin;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    const x = fromBase64Url(jwk.x);
    const y = fromBase64Url(jwk.y);
    this.cosePublicKey = Uint8Array.from([
      165,
      1,
      2,
      3,
      38,
      32,
      1,
      33,
      88,
      32,
      ...x,
      34,
      88,
      32,
      ...y
    ]);
  }
  credentialId = toBase64Url(randomBytes(16));
  cosePublicKey;
  privateKey;
  counter = 0;
  /** A registration response with attestation "none" (RegistrationResponseJSON). */
  register(challenge, opts = {}) {
    const rpIdHash = createHash("sha256").update(this.rpId).digest();
    const credId = fromBase64Url(this.credentialId);
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(credId.length);
    const authData = Buffer.concat([
      rpIdHash,
      Buffer.from([69]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      credIdLen,
      credId,
      this.cosePublicKey
    ]);
    const attestationObject = Buffer.concat([
      Buffer.from([163]),
      cborText("fmt"),
      cborText("none"),
      cborText("attStmt"),
      Buffer.from([160]),
      cborText("authData"),
      cborBytes(authData)
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge, origin: opts.origin ?? this.origin, crossOrigin: false })
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        attestationObject: toBase64Url(attestationObject),
        transports: ["internal"]
      },
      clientExtensionResults: {}
    };
  }
  assert(challenge, opts = {}) {
    this.counter += 1;
    const rpIdHash = createHash("sha256").update(this.rpId).digest();
    const flags = 1 | (opts.userVerified === false ? 0 : 4);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([flags]), counter]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge, origin: opts.origin ?? this.origin, crossOrigin: false })
    );
    const signature = sign(
      "sha256",
      Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
      this.privateKey
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        authenticatorData: toBase64Url(authenticatorData),
        signature: toBase64Url(signature),
        userHandle: null
      },
      clientExtensionResults: {}
    };
  }
};
function cborHead(major, len) {
  if (len < 24) return Buffer.from([major << 5 | len]);
  if (len < 256) return Buffer.from([major << 5 | 24, len]);
  return Buffer.from([major << 5 | 25, len >> 8, len & 255]);
}
function cborText(s) {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([cborHead(3, b.length), b]);
}
function cborBytes(b) {
  return Buffer.concat([cborHead(2, b.length), b]);
}

var API = process.env.IG_API?.replace(/\/$/, "");
var KEY = process.env.IG_KEY;
if (!API || !KEY) throw new Error("set IG_API and IG_KEY (a test key, igk_test_...)");
if (!KEY.startsWith("igk_test_")) throw new Error("simulate.ts only runs with a test key (igk_test_...)");
async function call(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...body === void 0 ? {} : { "content-type": "application/json" } },
    body: body === void 0 ? void 0 : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : void 0;
}
var step = (msg) => console.log(`\u2713 ${msg}`);
var account = await call("GET", "/v1/account", KEY);
if (account.mode !== "test") throw new Error("this key is not a test key");
step(`account ${account.name} (test mode), RP ID ${account.rp_id}`);
var centre = { latitude: 35.681236, longitude: 139.767125 };
var { site } = await call("POST", "/v1/sites", KEY, {
  name: `\u30B7\u30DF\u30E5\u30EC\u30FC\u30B7\u30E7\u30F3\u73FE\u5834 ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 16)}`,
  time_zone: "Asia/Tokyo",
  ...centre,
  radius_m: 100
});
step(`site ${site.id}, radius 100 m`);
var { worker } = await call("POST", "/v1/workers", KEY, { display_name: "\u30B7\u30DF\u30E5\u30EC\u30FC\u30B7\u30E7\u30F3 \u4F5C\u696D\u54E1" });
var passkey = new FakePasskey(account.rp_id, account.origins[0]);
var reg = await call("POST", `/v1/workers/${worker.id}/passkeys/options`, KEY);
await call("POST", `/v1/workers/${worker.id}/passkeys`, KEY, { challenge_id: reg.challenge_id, response: passkey.register(reg.options.challenge) });
await call("POST", `/v1/sites/${site.id}/assignments`, KEY, { worker_id: worker.id, starts_on: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10) });
step(`worker ${worker.id} with a passkey, assigned to the site`);
var dev = await call("POST", `/v1/workers/${worker.id}/devices`, KEY);
step(`device ${dev.device.id}`);
async function checkIn(label, latitude, longitude, accuracy_m) {
  const request = { type: "site_entry", site_id: site.id, location: { latitude, longitude, accuracy_m }, attributes: { simulated: true } };
  const issued = await call("POST", `/v1/devices/${dev.device.id}/checkins`, dev.device_token, request);
  const challenge = await checkIssuedCheckIn(dev.device.id, request, issued);
  const assertion = passkey.assert(toBase64Url(challenge));
  const path = `/v1/devices/${dev.device.id}/checkins/${issued.checkin_id}/complete`;
  const result = await call("POST", path, dev.device_token, { assertion });
  if (result.status !== "accepted") throw new Error(`complete: ${JSON.stringify(result)}`);
  step(`${label}: accepted, ${result.distance_m} m from the centre, flags [${result.flags.join(", ")}]`);
  return { path, assertion };
}
var first = await checkIn("check-in 20 m from the centre", centre.latitude + 20 / 111320, centre.longitude, 8);
var again = await call("POST", first.path, dev.device_token, { assertion: first.assertion });
step(`re-sending the same completion is safe: ${again.status}`);
await checkIn("check-in 1 km away (recorded with a flag)", centre.latitude + 1e3 / 111320, centre.longitude, 8);
var today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
var usage = await call("GET", `/v1/usage?from=${today}&to=${today}`, KEY);
step(`usage today: ${usage.billable_units} unit(s) in test mode (not billed)`);
console.log(`
Open the console, switch on \u30C6\u30B9\u30C8\u30E2\u30FC\u30C9, and look at \u5165\u9000\u8A18\u9332.`);
