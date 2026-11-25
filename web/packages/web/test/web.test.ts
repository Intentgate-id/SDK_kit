import { describe, expect, it } from "vitest";
import { computeChallenge, toBase64Url, type CheckInEvent, type IssuedCheckIn as WireIssued } from "@intentgate/basic-auth-protocol";
import { FakePasskey } from "./fakeAuthenticator.js";
import {
  CheckInAPIError,
  CheckInClient,
  CheckInNetworkError,
  CheckInValidationError,
  currentPosition,
  IssuedCheckInMismatch,
  LocationError,
  PasskeyError,
  PasskeySigner,
  type CheckInRequest,
} from "../src/index.js";
import { fakeCredentials } from "./fakeCredentials.js";

const RP_ID = "worker.example.com";
const ORIGIN = "https://worker.example.com";
const DEVICE = "dev_1";
const TOKEN = "igd_0123456789abcdef";

const request: CheckInRequest = { type: "site_entry", siteId: "site_1", latitude: 35.681236, longitude: 139.76712, accuracyM: 9.2 };

async function issuedFor(r: CheckInRequest, tamper: (e: CheckInEvent) => void = () => {}): Promise<WireIssued> {
  const event: CheckInEvent = {
    v: 2,
    type: r.type,
    checkin_id: "chk_1",
    device_id: DEVICE,
    site_id: r.siteId,
    nonce: toBase64Url(new Uint8Array(32).fill(3)),
    issued_at: "2026-11-20T08:00:00.000Z",
    location: { lat_e7: Math.round(r.latitude * 1e7), lng_e7: Math.round(r.longitude * 1e7), accuracy_m: Math.ceil(r.accuracyM) },
    attributes: r.attributes ?? {},
  };
  const challenge = toBase64Url(await computeChallenge(event));
  tamper(event);
  return { checkin_id: "chk_1", event, challenge, expires_at: "2026-11-20T08:03:00.000Z", rp_id: RP_ID, allow_credentials: [] };
}

/** A fetch stand-in that answers with the given handler and records what was sent. */
function fakeFetch(handler: (url: string, body: any) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const sent: { url: string; init: RequestInit; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    sent.push({ url, init, body });
    const r = handler(url, body);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fetch: f, sent };
}

describe("CheckInClient", () => {
  it("runs the whole flow: ask, check, sign with the passkey, complete", async () => {
    const passkey = new FakePasskey(RP_ID, ORIGIN);
    const creds = fakeCredentials(passkey);
    const wire = await issuedFor(request);
    wire.allow_credentials = [passkey.credentialId];
    const { fetch, sent } = fakeFetch((url) =>
      url.endsWith("/checkins")
        ? { status: 201, body: wire }
        : { status: 200, body: { checkin_id: "chk_1", status: "accepted", flags: ["outside_site"], billable: true, distance_m: 412 } },
    );
    const client = new CheckInClient({ baseUrl: "https://checkin.intentgate.id/", deviceId: DEVICE, deviceToken: TOKEN, fetch });
    const seen: string[] = [];
    const result = await client.checkIn({
      signer: new PasskeySigner({ rpId: RP_ID, credentials: creds }),
      request,
      confirm: (issued) => {
        seen.push(issued.event.site_id);
        return true;
      },
    });

    expect(result).toEqual({ checkinId: "chk_1", status: "accepted", flags: ["outside_site"], billable: true, distanceM: 412, needsReview: true });
    expect(seen).toEqual(["site_1"]);
    expect(sent[0]!.url).toBe("https://checkin.intentgate.id/v1/devices/dev_1/checkins");
    expect(sent[0]!.body).toEqual({ type: "site_entry", site_id: "site_1", location: { latitude: 35.681236, longitude: 139.76712, accuracy_m: 9.2 }, attributes: {} });
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent[0]!.init.credentials).toBe("omit");
    expect(sent[1]!.url).toBe("https://checkin.intentgate.id/v1/devices/dev_1/checkins/chk_1/complete");
    // The passkey was asked for UV over the challenge the server derived from the event.
    const get = (creds.calls[0]!.options as CredentialRequestOptions).publicKey!;
    expect(get.userVerification).toBe("required");
    expect(get.rpId).toBe(RP_ID);
    expect(toBase64Url(new Uint8Array(get.challenge as ArrayBuffer))).toBe(wire.challenge);
    expect(get.allowCredentials).toHaveLength(1);
    const clientData = JSON.parse(Buffer.from(sent[1]!.body.assertion.response.clientDataJSON, "base64url").toString());
    expect(clientData.challenge).toBe(wire.challenge);
    expect(sent[1]!.body.assertion.id).toBe(passkey.credentialId);
  });

  it("does not show the passkey prompt when the worker cancels at the confirm step", async () => {
    const creds = fakeCredentials(new FakePasskey(RP_ID, ORIGIN));
    const wire = await issuedFor(request);
    const { fetch, sent } = fakeFetch(() => ({ status: 201, body: wire }));
    const client = new CheckInClient({ baseUrl: "https://x", deviceId: DEVICE, deviceToken: TOKEN, fetch });
    const result = await client.checkIn({ signer: new PasskeySigner({ rpId: RP_ID, credentials: creds }), request, confirm: () => false });
    expect(result).toBeNull();
    expect(creds.calls).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it("refuses to sign an event other than the one asked for", async () => {
    const cases: [string, (e: CheckInEvent) => void][] = [
      ["site_id", (e) => (e.site_id = "site_other")],
      ["type", (e) => (e.type = "site_exit")],
      ["location.lat_e7", (e) => (e.location.lat_e7 += 100)],
      ["device_id", (e) => (e.device_id = "dev_2")],
    ];
    for (const [field, tamper] of cases) {
      const wire = await issuedFor(request, tamper);
      const { fetch } = fakeFetch(() => ({ status: 201, body: wire }));
      const client = new CheckInClient({ baseUrl: "https://x", deviceId: DEVICE, deviceToken: TOKEN, fetch });
      await expect(client.start(request)).rejects.toThrow(IssuedCheckInMismatch);
      await expect(client.start(request)).rejects.toThrow(field);
    }
    // A challenge that is not the hash of the event.
    const wire = await issuedFor(request);
    wire.challenge = toBase64Url(new Uint8Array(32));
    const { fetch } = fakeFetch(() => ({ status: 201, body: wire }));
    const client = new CheckInClient({ baseUrl: "https://x", deviceId: DEVICE, deviceToken: TOKEN, fetch });
    await expect(client.start(request)).rejects.toThrow("challenge");
  });

  it("reports API errors with their code and Retry-After", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 429,
      body: { error: { code: "rate_limited", message: "slow down" } },
      headers: { "retry-after": "30" },
    }));
    const client = new CheckInClient({ baseUrl: "https://x", deviceId: DEVICE, deviceToken: TOKEN, fetch });
    const err = await client.start(request).catch((e) => e);
    expect(err).toBeInstanceOf(CheckInAPIError);
    expect(err).toMatchObject({ status: 429, code: "rate_limited", retryAfter: 30 });

    const html = fakeFetch(() => ({ status: 502, body: undefined }));
    const err2 = await new CheckInClient({ baseUrl: "https://x", deviceId: DEVICE, deviceToken: TOKEN, fetch: html.fetch }).start(request).catch((e) => e);
    expect(err2).toMatchObject({ status: 502, code: "http_502" });
  });

  it("reports network failures separately", async () => {
    const fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof globalThis.fetch;
    const client = new CheckInClient({ baseUrl: "https://x", deviceId: DEVICE, deviceToken: TOKEN, fetch });
    await expect(client.start(request)).rejects.toThrow(CheckInNetworkError);
  });

  it("validates input before calling the server", async () => {
    const { fetch, sent } = fakeFetch(() => ({ status: 500 }));
    const client = new CheckInClient({ baseUrl: "https://x", deviceId: DEVICE, deviceToken: TOKEN, fetch });
    await expect(client.start({ ...request, latitude: 91 })).rejects.toThrow(CheckInValidationError);
    await expect(client.start({ ...request, accuracyM: Number.NaN })).rejects.toThrow("accuracy");
    await expect(client.start({ ...request, attributes: { ratio: 0.5 } })).rejects.toThrow("attributes");
    expect(sent).toHaveLength(0);
    expect(() => new CheckInClient({ baseUrl: "https://x", deviceId: DEVICE, deviceToken: "igk_live_x", fetch })).toThrow("igd_");
  });

  it("keeps attributes in the signed event", async () => {
    const r = { ...request, attributes: { gate: "東ゲート" } };
    const wire = await issuedFor(r);
    const { fetch } = fakeFetch(() => ({ status: 201, body: wire }));
    const client = new CheckInClient({ baseUrl: "https://x", deviceId: DEVICE, deviceToken: TOKEN, fetch });
    const issued = await client.start(r);
    expect(issued.event.attributes).toEqual({ gate: "東ゲート" });
    await expect(client.start({ ...r, attributes: { gate: "西ゲート" } })).rejects.toThrow("attributes");
  });
});

describe("PasskeySigner", () => {
  it("registers from the server's options with user verification required", async () => {
    const passkey = new FakePasskey(RP_ID, ORIGIN);
    const creds = fakeCredentials(passkey);
    const signer = new PasskeySigner({ rpId: RP_ID, credentials: creds });
    const options = {
      challenge: toBase64Url(new Uint8Array(32).fill(9)),
      rp: { id: RP_ID, name: "元請A" },
      user: { id: toBase64Url(new TextEncoder().encode("wrk_1")), name: "山田 太郎", displayName: "山田 太郎" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ id: toBase64Url(new Uint8Array([1, 2, 3])), type: "public-key", transports: ["internal"] }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    };
    const reg = await signer.register(JSON.stringify(options));
    expect(reg.id).toBe(passkey.credentialId);
    expect(reg.response.transports).toEqual(["internal", "hybrid"]);
    const create = (creds.calls[0]!.options as CredentialCreationOptions).publicKey!;
    expect(create.authenticatorSelection?.userVerification).toBe("required");
    expect(create.rp.id).toBe(RP_ID);
    expect(create.excludeCredentials).toHaveLength(1);
    const clientData = JSON.parse(Buffer.from(reg.response.clientDataJSON, "base64url").toString());
    expect(clientData).toMatchObject({ type: "webauthn.create", challenge: options.challenge });

    await expect(signer.register({ ...options, rp: { id: "other.example.com" } })).rejects.toMatchObject({ code: "invalid_options" });
    await expect(signer.register({ rp: { id: RP_ID } })).rejects.toMatchObject({ code: "invalid_options" });
  });

  it("maps browser errors to codes", async () => {
    const failing = (name: string) => ({
      get: async () => {
        throw Object.assign(new Error(name), { name });
      },
      create: async () => {
        throw Object.assign(new Error(name), { name });
      },
    });
    const sign = (name: string) => new PasskeySigner({ rpId: RP_ID, credentials: failing(name) }).sign(new Uint8Array(32));
    await expect(sign("NotAllowedError")).rejects.toMatchObject({ code: "cancelled" });
    await expect(sign("SecurityError")).rejects.toMatchObject({ code: "rp_id_mismatch" });
    await expect(sign("UnknownError")).rejects.toMatchObject({ code: "failed" });
    const signer = new PasskeySigner({ rpId: RP_ID, credentials: failing("InvalidStateError") });
    await expect(
      signer.register({ challenge: "AAAA", user: { id: "AAAA", name: "x" } }),
    ).rejects.toMatchObject({ code: "already_registered" });
    await expect(sign("NotAllowedError")).rejects.toBeInstanceOf(PasskeyError);
  });
});

describe("currentPosition", () => {
  it("measures once with high accuracy and maps errors", async () => {
    let options: PositionOptions | undefined;
    const ok = {
      getCurrentPosition: (success: PositionCallback, _e: PositionErrorCallback | null | undefined, o?: PositionOptions) => {
        options = o;
        success({ coords: { latitude: 35.1, longitude: 139.2, accuracy: 8.5 } } as GeolocationPosition);
      },
    };
    expect(await currentPosition({ geolocation: ok })).toEqual({ latitude: 35.1, longitude: 139.2, accuracyM: 8.5 });
    expect(options).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });

    const fail = (code: number) => ({
      getCurrentPosition: (_s: PositionCallback, error?: PositionErrorCallback | null) => error!({ code, message: "" } as GeolocationPositionError),
    });
    await expect(currentPosition({ geolocation: fail(1) })).rejects.toMatchObject({ code: "denied" });
    await expect(currentPosition({ geolocation: fail(2) })).rejects.toMatchObject({ code: "unavailable" });
    await expect(currentPosition({ geolocation: fail(3) })).rejects.toBeInstanceOf(LocationError);
  });
});
