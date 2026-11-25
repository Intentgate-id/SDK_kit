import {
  canonicalize,
  checkIssuedCheckIn,
  type AssertionJSON,
  type CheckInEvent,
  type CheckInRequest as WireCheckInRequest,
  type IssuedCheckIn as WireIssuedCheckIn,
  type JsonValue,
} from "@intentgate/basic-auth-protocol";
import type { PasskeySigner } from "./passkey.js";

/**
 * What the worker app asks for. `latitude`/`longitude` in degrees and `accuracyM`
 * (horizontal accuracy, metres) straight from `GeolocationPosition.coords`.
 */
export interface CheckInRequest {
  type: string;
  siteId: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** Extra fields covered by the signature (e.g. a gate name). No fractional numbers. */
  attributes?: { [key: string]: JsonValue };
}

/** The event the server fixed for this check-in, already checked against the request. */
export interface IssuedCheckIn {
  checkinId: string;
  event: CheckInEvent;
  /** base64url, 32 bytes. */
  challenge: string;
  /** The challenge as bytes, for the passkey. */
  challengeBytes: Uint8Array;
  expiresAt: string;
  rpId: string;
  /** Credential ids (base64url) of the worker's passkeys, for allowCredentials. */
  allowCredentials: string[];
}

/** Answer of the complete call. `flags` e.g. "outside_site", "low_accuracy", "unassigned_site". */
export interface CheckInResult {
  checkinId: string;
  /** "accepted", or "duplicate" when the same check-in was already completed (safe re-send). */
  status: "accepted" | "duplicate" | (string & {});
  flags: string[];
  billable: boolean;
  /** Distance from the site centre, metres. */
  distanceM: number;
  /** True when `flags` is not empty: the console shows the check-in as 要確認. */
  needsReview: boolean;
}

/** An error answer from Intentgate. `code` is the reason, e.g. "unknown_site", "checkin_expired". */
export class CheckInAPIError extends Error {
  override name = "CheckInAPIError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds to wait, when the server sent Retry-After (rate limit). */
    readonly retryAfter?: number,
  ) {
    super(`Intentgate ${status} ${code}: ${message}`);
  }
}

/** The request could not reach Intentgate (offline, DNS, CORS, timeout). */
export class CheckInNetworkError extends Error {
  override name = "CheckInNetworkError";
}

export class CheckInValidationError extends Error {
  override name = "CheckInValidationError";
}

export interface CheckInClientOptions {
  /** e.g. "https://checkin.intentgate.id" */
  baseUrl: string;
  deviceId: string;
  /** igd_... handed to this browser by your backend. */
  deviceToken: string;
  /** Replace for tests or your own networking. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number;
}

export interface CheckInFlowOptions {
  signer: PasskeySigner;
  request: CheckInRequest;
  /**
   * Runs between the server's answer and the passkey prompt, e.g. to show the worker the
   * site and time. Return false to stop (checkIn then returns null).
   */
  confirm?: (issued: IssuedCheckIn) => boolean | Promise<boolean>;
  /** Aborts the passkey prompt. */
  signal?: AbortSignal;
}

/** Checks a request the same way the Swift and Kotlin SDKs do, and returns the wire body. */
export function toWireRequest(r: CheckInRequest): WireCheckInRequest {
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (typeof r.type !== "string" || r.type === "") throw new CheckInValidationError("invalid type");
  if (typeof r.siteId !== "string" || r.siteId === "") throw new CheckInValidationError("invalid siteId");
  if (!finite(r.latitude) || r.latitude < -90 || r.latitude > 90) throw new CheckInValidationError("invalid latitude");
  if (!finite(r.longitude) || r.longitude < -180 || r.longitude > 180) throw new CheckInValidationError("invalid longitude");
  if (!finite(r.accuracyM) || r.accuracyM < 0) throw new CheckInValidationError("invalid accuracy");
  const attributes = r.attributes ?? {};
  try {
    canonicalize(attributes);
  } catch (err) {
    throw new CheckInValidationError(`invalid attributes: ${(err as Error).message}`);
  }
  return {
    type: r.type,
    site_id: r.siteId,
    location: { latitude: r.latitude, longitude: r.longitude, accuracy_m: r.accuracyM },
    attributes,
  };
}

/**
 * Worker-side check-in from a web page.
 *
 *     const client = new CheckInClient({ baseUrl: "https://checkin.intentgate.id", deviceId, deviceToken });
 *     const signer = new PasskeySigner({ rpId: "worker.example.com" });
 *     const position = await currentPosition();
 *     const result = await client.checkIn({ signer, request: { type: "site_entry", siteId, ...position } });
 *
 * `start` checks the issued event before returning, so the page never signs something other
 * than what it asked for. `complete` is safe to repeat after a network error: a second call
 * answers status "duplicate" with the stored result.
 */
export class CheckInClient {
  readonly baseUrl: string;
  readonly deviceId: string;
  readonly #deviceToken: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: CheckInClientOptions) {
    if (!opts.deviceToken?.startsWith("igd_")) throw new CheckInValidationError("deviceToken must be an igd_ device token");
    if (!opts.deviceId) throw new CheckInValidationError("deviceId required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.deviceId = opts.deviceId;
    this.#deviceToken = opts.deviceToken;
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new CheckInValidationError("fetch is not available");
    this.#fetch = f.bind(globalThis);
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** Asks to check in. The server fixes the event; this checks it before returning. */
  async start(request: CheckInRequest): Promise<IssuedCheckIn> {
    const wire = toWireRequest(request);
    const body = (await this.#post(`/v1/devices/${encodeURIComponent(this.deviceId)}/checkins`, wire)) as WireIssuedCheckIn;
    if (typeof body?.checkin_id !== "string" || typeof body.challenge !== "string" || typeof body.event !== "object") {
      throw new CheckInValidationError("malformed issued check-in");
    }
    const challengeBytes = await checkIssuedCheckIn(this.deviceId, wire, body);
    return {
      checkinId: body.checkin_id,
      event: body.event,
      challenge: body.challenge,
      challengeBytes,
      expiresAt: body.expires_at,
      rpId: body.rp_id,
      allowCredentials: Array.isArray(body.allow_credentials) ? body.allow_credentials : [],
    };
  }

  /** Hands in the passkey's signature. Safe to repeat with the same arguments. */
  async complete(checkinId: string, assertion: AssertionJSON): Promise<CheckInResult> {
    if (typeof assertion?.id !== "string" || typeof assertion.response !== "object") {
      throw new CheckInValidationError("not a WebAuthn assertion");
    }
    const path = `/v1/devices/${encodeURIComponent(this.deviceId)}/checkins/${encodeURIComponent(checkinId)}/complete`;
    const r = (await this.#post(path, { assertion })) as Record<string, unknown>;
    if (typeof r?.checkin_id !== "string" || typeof r.status !== "string" || !Array.isArray(r.flags) ||
        typeof r.billable !== "boolean" || typeof r.distance_m !== "number") {
      throw new CheckInValidationError("malformed result");
    }
    const flags = r.flags.filter((f): f is string => typeof f === "string");
    return { checkinId: r.checkin_id, status: r.status, flags, billable: r.billable, distanceM: r.distance_m, needsReview: flags.length > 0 };
  }

  /**
   * Full check-in: ask the server (with the position), check the issued event, passkey
   * prompt, complete. Returns null when `confirm` returned false.
   */
  async checkIn(opts: CheckInFlowOptions): Promise<CheckInResult | null> {
    const issued = await this.start(opts.request);
    if (opts.confirm && !(await opts.confirm(issued))) return null;
    const assertion = await opts.signer.sign(issued.challengeBytes, {
      allowCredentials: issued.allowCredentials,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return this.complete(issued.checkinId, assertion);
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(this.baseUrl + path, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
      });
    } catch (err) {
      throw new CheckInNetworkError(controller.signal.aborted ? "request timed out" : `network error: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok || json === undefined) {
      const error = (json as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      const retry = Number(res.headers.get("retry-after"));
      throw new CheckInAPIError(
        res.status,
        typeof error?.code === "string" ? error.code : `http_${res.status}`,
        typeof error?.message === "string" ? error.message : text.slice(0, 200),
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
      );
    }
    return json;
  }
}
