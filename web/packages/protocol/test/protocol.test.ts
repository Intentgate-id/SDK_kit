import { describe, expect, it } from "vitest";
import {
  aggregateUsage,
  canonicalize,
  CanonicalizationError,
  checkIssuedCheckIn,
  computeChallenge,
  distanceMeters,
  EventValidationError,
  IssuedCheckInMismatch,
  localDate,
  toBase64Url,
  toE7,
  type CheckInEvent,
  type CheckInRequest,
  type IssuedCheckIn,
} from "../src/index.js";

const NONCE = toBase64Url(new Uint8Array(32).fill(7));

function event(overrides: Partial<CheckInEvent> = {}): CheckInEvent {
  return {
    v: 2,
    type: "site_entry",
    checkin_id: "chk_1",
    device_id: "dev_1",
    site_id: "site_1",
    nonce: NONCE,
    issued_at: "2026-11-09T07:58:12.000Z",
    location: { lat_e7: 356812360, lng_e7: 1397671200, accuracy_m: 12 },
    attributes: { gate: "東ゲート" },
    ...overrides,
  };
}

describe("canonicalize", () => {
  it("sorts keys by UTF-16 code units and escapes like JSON.stringify", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], "\u20ac": 0, "\ud83d\ude00": 1, "\r": "\u2028<" })).toBe(
      '{"\\r":"\u2028<","a":[true,null,"x"],"b":1,"\u20ac":0,"\ud83d\ude00":1}',
    );
  });

  it("rejects floats, undefined and class instances", () => {
    expect(() => canonicalize({ a: 1.5 })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ a: undefined })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ a: new Date(0) })).toThrow(CanonicalizationError);
    expect(() => canonicalize(2 ** 53)).toThrow(CanonicalizationError);
  });
});

describe("computeChallenge", () => {
  it("is deterministic and 32 bytes", async () => {
    const a = await computeChallenge(event());
    const b = await computeChallenge(event());
    expect(a).toHaveLength(32);
    expect(toBase64Url(a)).toBe(toBase64Url(b));
  });

  it("changes when any signed field changes", async () => {
    const base = toBase64Url(await computeChallenge(event()));
    for (const changed of [
      event({ type: "site_exit" }),
      event({ checkin_id: "chk_2" }),
      event({ site_id: "site_2" }),
      event({ nonce: toBase64Url(new Uint8Array(32).fill(8)) }),
      event({ issued_at: "2026-11-09T07:58:13.000Z" }),
      event({ location: { lat_e7: 356812361, lng_e7: 1397671200, accuracy_m: 12 } }),
      event({ attributes: { gate: "西ゲート" } }),
    ]) {
      expect(toBase64Url(await computeChallenge(changed))).not.toBe(base);
    }
  });

  it("rejects malformed events", async () => {
    await expect(computeChallenge(event({ type: "Site Entry" }))).rejects.toThrow(EventValidationError);
    await expect(computeChallenge({ ...event(), extra: 1 } as CheckInEvent)).rejects.toThrow(EventValidationError);
    await expect(computeChallenge(event({ issued_at: "2026-11-09T07:58:12+09:00" }))).rejects.toThrow(EventValidationError);
    await expect(computeChallenge(event({ nonce: "short" }))).rejects.toThrow(EventValidationError);
    await expect(computeChallenge(event({ location: { lat_e7: 35.6, lng_e7: 1, accuracy_m: 1 } }))).rejects.toThrow(EventValidationError);
    await expect(computeChallenge(event({ location: { lat_e7: 950000000, lng_e7: 1, accuracy_m: 1 } }))).rejects.toThrow(EventValidationError);
  });
});

describe("geo", () => {
  it("converts degrees to e7 integers", () => {
    expect(toE7(35.681236)).toBe(356812360);
    expect(toE7(-122.4194155)).toBe(-1224194155);
  });

  it("measures distance in metres", () => {
    // Tokyo Station to the Imperial Palace main gate, about 1.3 km.
    const d = distanceMeters(356812360, 1397671200, 356852000, 1397528000);
    expect(d).toBeGreaterThan(1300);
    expect(d).toBeLessThan(1400);
    expect(distanceMeters(1, 2, 1, 2)).toBe(0);
    // 0.001° of latitude is about 111 m.
    expect(distanceMeters(0, 0, 10000, 0)).toBe(111);
  });
});

describe("checkIssuedCheckIn", () => {
  const request: CheckInRequest = {
    type: "site_entry",
    site_id: "site_1",
    location: { latitude: 35.681236, longitude: 139.76712, accuracy_m: 11.4 },
    attributes: { gate: "東ゲート" },
  };
  async function issued(e = event()): Promise<IssuedCheckIn> {
    return {
      checkin_id: e.checkin_id,
      event: e,
      challenge: toBase64Url(await computeChallenge(e)),
      expires_at: "2026-11-09T08:01:12.000Z",
      rp_id: "app.example.com",
      allow_credentials: [],
    };
  }

  it("returns the challenge when the event matches the request", async () => {
    const i = await issued();
    expect(toBase64Url(await checkIssuedCheckIn("dev_1", request, i))).toBe(i.challenge);
  });

  it("refuses an event that differs from what the app asked for", async () => {
    for (const e of [
      event({ type: "site_exit" }),
      event({ site_id: "site_2" }),
      event({ device_id: "dev_2" }),
      event({ attributes: {} }),
      event({ location: { lat_e7: 356900000, lng_e7: 1397671200, accuracy_m: 12 } }),
    ]) {
      await expect(checkIssuedCheckIn("dev_1", request, await issued(e))).rejects.toThrow(IssuedCheckInMismatch);
    }
  });

  it("refuses a challenge that is not derived from the event", async () => {
    const i = await issued();
    i.challenge = toBase64Url(new Uint8Array(32));
    await expect(checkIssuedCheckIn("dev_1", request, i)).rejects.toThrow(IssuedCheckInMismatch);
  });
});

describe("billing", () => {
  it("uses the local day at the site", () => {
    // 2026-11-09T15:30:00Z is 00:30 on 11-10 in Tokyo.
    expect(localDate(Date.UTC(2026, 10, 9, 15, 30) / 1000, "Asia/Tokyo")).toBe("2026-11-10");
    expect(localDate(Date.UTC(2026, 10, 9, 14, 30) / 1000, "Asia/Tokyo")).toBe("2026-11-09");
  });

  it("counts one row per worker, site and day", () => {
    const t = Date.UTC(2026, 10, 9, 0, 0) / 1000;
    const rows = aggregateUsage([
      { tenantId: "gc1", siteId: "s1", workerId: "w1", time: t, timeZone: "Asia/Tokyo" },
      { tenantId: "gc1", siteId: "s1", workerId: "w1", time: t + 3600, timeZone: "Asia/Tokyo" },
      { tenantId: "gc2", siteId: "s2", workerId: "w1", time: t + 7200, timeZone: "Asia/Tokyo" },
      { tenantId: "gc1", siteId: "s1", workerId: "w1", time: t + 86400, timeZone: "Asia/Tokyo" },
    ]);
    expect(rows).toEqual([
      { tenantId: "gc1", siteId: "s1", workerId: "w1", date: "2026-11-09", events: 2 },
      { tenantId: "gc1", siteId: "s1", workerId: "w1", date: "2026-11-10", events: 1 },
      { tenantId: "gc2", siteId: "s2", workerId: "w1", date: "2026-11-09", events: 1 },
    ]);
  });
});
