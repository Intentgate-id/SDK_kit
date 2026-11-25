import { fromBase64Url, toBase64Url, type AssertionJSON } from "@intentgate/basic-auth-protocol";

export type PasskeyErrorCode =
  /** The worker dismissed the prompt, or it timed out (WebAuthn does not tell them apart). */
  | "cancelled"
  /** This browser has no WebAuthn, or the page is not a secure context (https or localhost). */
  | "unsupported"
  /** The page's domain does not match the RP ID (SecurityError). */
  | "rp_id_mismatch"
  /** A passkey for this worker already exists on this authenticator (registration). */
  | "already_registered"
  /** The registration options from the server are not usable. */
  | "invalid_options"
  /** Any other failure; `cause` holds the browser's error. */
  | "failed";

export class PasskeyError extends Error {
  override name = "PasskeyError";
  constructor(readonly code: PasskeyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** WebAuthn RegistrationResponseJSON, for POST /v1/workers/{id}/passkeys (through your backend). */
export interface RegistrationJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment?: string | null;
}

export interface SignOptions {
  /** base64url credential ids of the worker's passkeys (IssuedCheckIn.allowCredentials). */
  allowCredentials?: string[];
  signal?: AbortSignal;
  /** Prompt timeout hint for the browser. Default 120 s. */
  timeoutMs?: number;
}

type Credentials = Pick<CredentialsContainer, "get" | "create">;

/**
 * Registers and uses the worker's passkey with WebAuthn in the browser.
 *
 * The page must be served from the RP ID or a subdomain of it (e.g. rpId "worker.example.com"
 * on https://worker.example.com), over https (http://localhost works for development), and its
 * origin must be registered as one of the tenant's origins at Intentgate.
 */
export class PasskeySigner {
  readonly rpId: string;
  readonly #credentials: Credentials | undefined;

  constructor(opts: { rpId: string; credentials?: Credentials }) {
    if (!opts.rpId) throw new PasskeyError("invalid_options", "rpId required");
    this.rpId = opts.rpId;
    this.#credentials = opts.credentials ?? (globalThis.navigator?.credentials as Credentials | undefined);
  }

  /** True when this browser can use a passkey on this device (Face ID, Touch ID, Windows Hello, fingerprint ...). */
  static async isAvailable(): Promise<boolean> {
    const pkc = (globalThis as { PublicKeyCredential?: typeof PublicKeyCredential }).PublicKeyCredential;
    if (!pkc || globalThis.isSecureContext === false) return false;
    try {
      return await pkc.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Signs a check-in challenge with user verification required.
   * Returns the AuthenticationResponseJSON for CheckInClient.complete.
   */
  async sign(challenge: Uint8Array, opts: SignOptions = {}): Promise<AssertionJSON> {
    const publicKey: PublicKeyCredentialRequestOptions = {
      challenge: buffer(challenge),
      rpId: this.rpId,
      userVerification: "required",
      timeout: opts.timeoutMs ?? 120_000,
      allowCredentials: (opts.allowCredentials ?? []).map((id) => ({ type: "public-key" as const, id: buffer(fromBase64Url(id)) })),
    };
    const credential = (await this.#call("get", { publicKey, ...(opts.signal ? { signal: opts.signal } : {}) })) as PublicKeyCredential;
    const response = credential.response as AuthenticatorAssertionResponse;
    if (!response?.signature || !response.authenticatorData) throw new PasskeyError("failed", "unexpected credential type");
    return {
      id: toBase64Url(bytes(credential.rawId)),
      rawId: toBase64Url(bytes(credential.rawId)),
      type: "public-key",
      authenticatorAttachment: credential.authenticatorAttachment ?? null,
      clientExtensionResults: {},
      response: {
        clientDataJSON: toBase64Url(bytes(response.clientDataJSON)),
        authenticatorData: toBase64Url(bytes(response.authenticatorData)),
        signature: toBase64Url(bytes(response.signature)),
        userHandle: response.userHandle ? toBase64Url(bytes(response.userHandle)) : null,
      },
    };
  }

  /**
   * Creates a passkey from the `options` object returned by POST /v1/workers/{id}/passkeys/options
   * (PublicKeyCredentialCreationOptionsJSON). Returns RegistrationResponseJSON for
   * POST /v1/workers/{id}/passkeys; send it through your backend with the challenge_id.
   */
  async register(options: unknown, opts: { signal?: AbortSignal } = {}): Promise<RegistrationJSON> {
    const publicKey = this.#creationOptions(options);
    const credential = (await this.#call("create", { publicKey, ...(opts.signal ? { signal: opts.signal } : {}) })) as PublicKeyCredential;
    const response = credential.response as AuthenticatorAttestationResponse;
    if (!response?.attestationObject) throw new PasskeyError("failed", "unexpected credential type");
    const transports = typeof response.getTransports === "function" ? response.getTransports() : ["internal"];
    return {
      id: toBase64Url(bytes(credential.rawId)),
      rawId: toBase64Url(bytes(credential.rawId)),
      type: "public-key",
      authenticatorAttachment: credential.authenticatorAttachment ?? null,
      clientExtensionResults: {},
      response: {
        clientDataJSON: toBase64Url(bytes(response.clientDataJSON)),
        attestationObject: toBase64Url(bytes(response.attestationObject)),
        transports,
      },
    };
  }

  #creationOptions(options: unknown): PublicKeyCredentialCreationOptions {
    const o = (typeof options === "string" ? safeParse(options) : options) as Record<string, any> | undefined;
    try {
      if (!o || typeof o.challenge !== "string" || typeof o.user?.id !== "string" || typeof o.user?.name !== "string") {
        throw new Error("challenge and user required");
      }
      if (o.rp?.id !== undefined && o.rp.id !== this.rpId) throw new Error(`options are for RP ID ${o.rp.id}, not ${this.rpId}`);
      return {
        challenge: buffer(fromBase64Url(o.challenge)),
        rp: { id: this.rpId, name: typeof o.rp?.name === "string" ? o.rp.name : this.rpId },
        user: { id: buffer(fromBase64Url(o.user.id)), name: o.user.name, displayName: o.user.displayName ?? o.user.name },
        pubKeyCredParams: Array.isArray(o.pubKeyCredParams) && o.pubKeyCredParams.length > 0
          ? o.pubKeyCredParams
          : [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        timeout: typeof o.timeout === "number" ? o.timeout : 120_000,
        attestation: o.attestation ?? "none",
        excludeCredentials: (Array.isArray(o.excludeCredentials) ? o.excludeCredentials : []).map((c: { id: string; transports?: string[] }) => ({
          type: "public-key" as const,
          id: buffer(fromBase64Url(c.id)),
          ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
        })),
        authenticatorSelection: {
          ...(o.authenticatorSelection ?? {}),
          residentKey: o.authenticatorSelection?.residentKey ?? "preferred",
          userVerification: "required",
        },
      };
    } catch (err) {
      throw new PasskeyError("invalid_options", `invalid registration options: ${(err as Error).message}`, { cause: err });
    }
  }

  async #call(kind: "get" | "create", options: CredentialRequestOptions | CredentialCreationOptions): Promise<Credential> {
    if (!this.#credentials) {
      throw new PasskeyError("unsupported", "WebAuthn is not available in this browser");
    }
    if (globalThis.isSecureContext === false) throw new PasskeyError("unsupported", "passkeys need https (or http://localhost)");
    let credential: Credential | null;
    try {
      credential = kind === "get"
        ? await this.#credentials.get(options as CredentialRequestOptions)
        : await this.#credentials.create(options as CredentialCreationOptions);
    } catch (err) {
      throw mapError(err, kind);
    }
    if (!credential) throw new PasskeyError("cancelled", "no credential returned");
    return credential;
  }
}

function mapError(err: unknown, kind: "get" | "create"): PasskeyError {
  const name = (err as { name?: string })?.name;
  const message = (err as Error)?.message ?? String(err);
  if (name === "NotAllowedError" || name === "AbortError") return new PasskeyError("cancelled", message, { cause: err });
  if (name === "SecurityError") return new PasskeyError("rp_id_mismatch", message, { cause: err });
  if (name === "InvalidStateError" && kind === "create") return new PasskeyError("already_registered", message, { cause: err });
  if (name === "NotSupportedError") return new PasskeyError("unsupported", message, { cause: err });
  return new PasskeyError("failed", message, { cause: err });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function buffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function bytes(b: ArrayBuffer | ArrayBufferView): Uint8Array {
  return b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}
