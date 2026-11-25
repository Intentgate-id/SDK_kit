import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { fromBase64Url, toBase64Url, type AssertionJSON } from "@intentgate/basic-auth-protocol";

/** A software ES256 passkey that produces real WebAuthn assertions for tests. */
export class FakePasskey {
  readonly credentialId = toBase64Url(randomBytes(16));
  readonly cosePublicKey: Uint8Array;
  private readonly privateKey;
  counter = 0;

  constructor(readonly rpId: string, readonly origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    const x = fromBase64Url(jwk.x!);
    const y = fromBase64Url(jwk.y!);
    // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
    this.cosePublicKey = Uint8Array.from([
      0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...x, 0x22, 0x58, 0x20, ...y,
    ]);
  }

  /** A registration response with attestation "none" (RegistrationResponseJSON). */
  register(challenge: string, opts: { origin?: string } = {}) {
    const rpIdHash = createHash("sha256").update(this.rpId).digest();
    const credId = fromBase64Url(this.credentialId);
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(credId.length);
    // flags: UP | UV | AT
    const authData = Buffer.concat([
      rpIdHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), credIdLen, credId, this.cosePublicKey,
    ]);
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3]), cborText("fmt"), cborText("none"), cborText("attStmt"), Buffer.from([0xa0]),
      cborText("authData"), cborBytes(authData),
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge, origin: opts.origin ?? this.origin, crossOrigin: false }),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key" as const,
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        attestationObject: toBase64Url(attestationObject),
        transports: ["internal" as const],
      },
      clientExtensionResults: {},
    };
  }

  assert(challenge: string, opts: { userVerified?: boolean; origin?: string } = {}): AssertionJSON {
    this.counter += 1;
    const rpIdHash = createHash("sha256").update(this.rpId).digest();
    const flags = 0x01 | (opts.userVerified === false ? 0 : 0x04);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([flags]), counter]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge, origin: opts.origin ?? this.origin, crossOrigin: false }),
    );
    const signature = sign(
      "sha256",
      Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
      this.privateKey,
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        authenticatorData: toBase64Url(authenticatorData),
        signature: toBase64Url(signature),
        userHandle: null,
      },
      clientExtensionResults: {},
    };
  }
}

function cborHead(major: number, len: number): Buffer {
  if (len < 24) return Buffer.from([(major << 5) | len]);
  if (len < 256) return Buffer.from([(major << 5) | 24, len]);
  return Buffer.from([(major << 5) | 25, len >> 8, len & 0xff]);
}

function cborText(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([cborHead(3, b.length), b]);
}

function cborBytes(b: Buffer): Buffer {
  return Buffer.concat([cborHead(2, b.length), b]);
}
