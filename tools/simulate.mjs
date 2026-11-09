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
function fromHex(hex) {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new TypeError("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
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

var PROTOCOL_VERSION = 1;
var EventValidationError = class extends Error {
  name = "EventValidationError";
};
var EVENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
var ID = /^[A-Za-z0-9_-]{1,128}$/;
var RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
var EVENT_KEYS = ["attributes", "device_id", "nonce_kid", "occurred_at", "seq", "site_token", "type", "v"];
function assertCheckInEvent(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EventValidationError("event must be an object");
  }
  const e = value;
  const keys = Object.keys(e).sort();
  if (keys.join(",") !== EVENT_KEYS.join(",")) {
    throw new EventValidationError(`event keys must be exactly: ${EVENT_KEYS.join(", ")}`);
  }
  if (e.v !== PROTOCOL_VERSION) throw new EventValidationError("unsupported protocol version");
  if (typeof e.type !== "string" || !EVENT_TYPE.test(e.type)) throw new EventValidationError("invalid type");
  if (typeof e.device_id !== "string" || !ID.test(e.device_id)) throw new EventValidationError("invalid device_id");
  if (typeof e.nonce_kid !== "string" || !ID.test(e.nonce_kid)) throw new EventValidationError("invalid nonce_kid");
  if (!Number.isSafeInteger(e.seq) || e.seq < 0) throw new EventValidationError("invalid seq");
  if (typeof e.site_token !== "string" || e.site_token.length > 1024) throw new EventValidationError("invalid site_token");
  if (typeof e.occurred_at !== "string" || !RFC3339.test(e.occurred_at) || Number.isNaN(Date.parse(e.occurred_at))) {
    throw new EventValidationError("invalid occurred_at");
  }
  if (typeof e.attributes !== "object" || e.attributes === null || Array.isArray(e.attributes)) {
    throw new EventValidationError("attributes must be an object");
  }
  canonicalize(e.attributes);
}

var CHALLENGE_DOMAIN = "intentgate-basic-auth/v1";
var NONCE_LENGTH = 32;
async function computeChallenge(nonce2, event2) {
  if (nonce2.length !== NONCE_LENGTH) throw new RangeError(`nonce must be ${NONCE_LENGTH} bytes`);
  assertCheckInEvent(event2);
  return sha256(concatBytes(utf8(CHALLENGE_DOMAIN), new Uint8Array([0]), nonce2, utf8(canonicalize(event2))));
}

var SITE_TOKEN_PREFIX = "IGS1";
async function createSiteToken(payload, privateKey) {
  const body = toBase64Url(utf8(canonicalize(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", privateKey, utf8(`${SITE_TOKEN_PREFIX}.${body}`))
  );
  return `${SITE_TOKEN_PREFIX}.${body}.${toBase64Url(signature)}`;
}
var PKCS8_ED25519_PREFIX = fromHex("302e020100300506032b657004220420");
async function generateSiteKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKeyRaw };
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
var { site } = await call("POST", "/v1/sites", KEY, { name: `\u30B7\u30DF\u30E5\u30EC\u30FC\u30B7\u30E7\u30F3\u73FE\u5834 ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 16)}`, time_zone: "Asia/Tokyo" });
var tablet = await generateSiteKeyPair();
await call("POST", `/v1/sites/${site.id}/keys`, KEY, { kid: "sim-tablet", public_key: toBase64Url(tablet.publicKeyRaw) });
step(`site ${site.id} with tablet key sim-tablet`);
var { worker } = await call("POST", "/v1/workers", KEY, { display_name: "\u30B7\u30DF\u30E5\u30EC\u30FC\u30B7\u30E7\u30F3 \u4F5C\u696D\u54E1" });
var passkey = new FakePasskey(account.rp_id, account.origins[0]);
var reg = await call("POST", `/v1/workers/${worker.id}/passkeys/options`, KEY);
await call("POST", `/v1/workers/${worker.id}/passkeys`, KEY, { challenge_id: reg.challenge_id, response: passkey.register(reg.options.challenge) });
await call("POST", `/v1/sites/${site.id}/assignments`, KEY, { worker_id: worker.id, starts_on: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10) });
step(`worker ${worker.id} with a passkey, assigned to the site`);
var dev = await call("POST", `/v1/workers/${worker.id}/devices`, KEY);
var bundle = await call("POST", `/v1/devices/${dev.device.id}/bundle`, dev.device_token);
step(`device ${dev.device.id}, ${bundle.nonces.length} nonces until ${bundle.lock_after}`);
var now = Math.floor(Date.now() / 1e3);
var siteToken = await createSiteToken({ v: 1, site_id: site.id, kid: "sim-tablet", t: Math.floor(now / 30) * 30 }, tablet.privateKey);
var nonce = bundle.nonces[0];
var event = {
  v: 1,
  type: "site_entry",
  device_id: dev.device.id,
  seq: nonce.seq,
  nonce_kid: bundle.nonce_kid,
  site_token: siteToken,
  occurred_at: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "Z"),
  attributes: { simulated: true }
};
var assertion = passkey.assert(toBase64Url(await computeChallenge(fromBase64Url(nonce.nonce), event)));
var upload = await call("POST", `/v1/devices/${dev.device.id}/events`, dev.device_token, { device_id: dev.device.id, records: [{ event, assertion }] });
var result = upload.results[0];
if (result.status !== "accepted") throw new Error(`upload: ${JSON.stringify(result)}`);
step(`check-in accepted (seq ${result.seq})`);
var again = await call("POST", `/v1/devices/${dev.device.id}/events`, dev.device_token, { device_id: dev.device.id, records: [{ event, assertion }] });
step(`re-sending the same record is safe: ${again.results[0].status}`);
var today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
var usage = await call("GET", `/v1/usage?from=${today}&to=${today}`, KEY);
step(`usage today: ${usage.billable_units} unit(s) in test mode (not billed)`);
console.log(`
Open the console, switch on \u30C6\u30B9\u30C8\u30E2\u30FC\u30C9, and look at \u5165\u9000\u8A18\u9332.`);
