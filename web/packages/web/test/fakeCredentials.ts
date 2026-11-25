import { fromBase64Url, toBase64Url } from "@intentgate/basic-auth-protocol";
import type { FakePasskey } from "./fakeAuthenticator.js";

const ab = (b64url: string) => {
  const b = fromBase64Url(b64url);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const b64 = (b: BufferSource) => toBase64Url(b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

/**
 * navigator.credentials stand-in backed by a software passkey: what a browser would hand back
 * (ArrayBuffers), so PasskeySigner's conversion to JSON is exercised too.
 */
export function fakeCredentials(passkey: FakePasskey, opts: { origin?: string } = {}) {
  const calls: { kind: "get" | "create"; options: CredentialRequestOptions | CredentialCreationOptions }[] = [];
  return {
    calls,
    async get(options: CredentialRequestOptions) {
      calls.push({ kind: "get", options });
      const a = passkey.assert(b64(options.publicKey!.challenge), opts);
      return {
        id: a.id,
        rawId: ab(a.rawId),
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: ab(a.response.clientDataJSON),
          authenticatorData: ab(a.response.authenticatorData),
          signature: ab(a.response.signature),
          userHandle: null,
        },
      } as unknown as Credential;
    },
    async create(options: CredentialCreationOptions) {
      calls.push({ kind: "create", options });
      const r = passkey.register(b64(options.publicKey!.challenge), opts);
      return {
        id: r.id,
        rawId: ab(r.rawId),
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: ab(r.response.clientDataJSON),
          attestationObject: ab(r.response.attestationObject),
          getTransports: () => ["internal", "hybrid"],
        },
      } as unknown as Credential;
    },
  };
}
