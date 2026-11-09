import Foundation
import XCTest
@testable import IntentgateBasicAuth

final class CheckInClientTests: XCTestCase {
    private let assertion = Data(#"{"id":"cred1","rawId":"cred1","type":"public-key","response":{"clientDataJSON":"e30","authenticatorData":"AA","signature":"AA"}}"#.utf8)
    private let resultJSON = #"{"checkin_id":"chk_1","status":"accepted","flags":["outside_site"],"billable":true,"distance_m":412}"#

    private func request() throws -> CheckInRequest {
        try CheckInRequest(type: "site_entry", siteId: "site_123", latitude: 35.681236, longitude: 139.76712,
                           accuracyM: 11.4, attributes: ["gate": "東ゲート"])
    }

    private func event(_ change: (inout [String: JSONValue]) -> Void = { _ in }) -> [String: JSONValue] {
        var e: [String: JSONValue] = [
            "v": 2, "type": "site_entry", "checkin_id": "chk_1", "device_id": "dev_1", "site_id": "site_123",
            "nonce": .string(Base64Url.encode(Data(repeating: 7, count: 32))), "issued_at": "2026-11-08T22:58:12.000Z",
            "location": ["lat_e7": 356812360, "lng_e7": 1397671200, "accuracy_m": 12],
            "attributes": ["gate": "東ゲート"],
        ]
        change(&e)
        return e
    }

    private func issued(_ e: [String: JSONValue], challengeOf c: [String: JSONValue]? = nil) throws -> String {
        let challenge = try Challenge.computeBase64Url(event: CheckInEvent(json: .object(c ?? e)))
        return try Jcs.canonicalize([
            "checkin_id": "chk_1", "event": .object(e), "challenge": .string(challenge),
            "expires_at": "2026-11-08T23:01:12.000Z", "rp_id": "app.example.co.jp", "allow_credentials": ["cred1"],
        ])
    }

    final class FakeTransport: CheckInTransport, @unchecked Sendable {
        let answers: [String: (Int, String)]
        var calls: [(URL, String, Data)] = []
        init(_ answers: [String: (Int, String)]) { self.answers = answers }
        func post(url: URL, bearerToken: String, body: Data) async throws -> (status: Int, body: Data) {
            calls.append((url, bearerToken, body))
            let (status, text) = answers.first { url.path.hasSuffix($0.key) }!.value
            return (status, Data(text.utf8))
        }
    }

    private func client(_ t: FakeTransport) -> CheckInClient {
        CheckInClient(baseURL: URL(string: "https://checkin.example")!, deviceId: "dev_1", deviceToken: "igd_secret", transport: t)
    }

    func testStartsVerifiesAndCompletes() async throws {
        let t = FakeTransport(["/checkins": (201, try issued(event())), "/complete": (200, resultJSON)])
        let c = client(t)
        let i = try await c.start(try request())
        XCTAssertEqual(i.checkinId, "chk_1")
        XCTAssertEqual(i.challengeData.count, 32)
        let r = try await c.complete(checkinId: i.checkinId, assertionJSON: assertion)
        XCTAssertEqual(r.status, "accepted")
        XCTAssertEqual(r.distanceM, 412)
        XCTAssertTrue(r.needsReview)

        XCTAssertEqual(t.calls[0].0.absoluteString, "https://checkin.example/v1/devices/dev_1/checkins")
        XCTAssertEqual(t.calls[0].1, "igd_secret")
        let body = try JSONValue.parse(t.calls[0].2)
        XCTAssertEqual(body["site_id"], "site_123")
        XCTAssertEqual(body["location"]?["latitude"], .double(35.681236))
        XCTAssertEqual(t.calls[1].0.absoluteString, "https://checkin.example/v1/devices/dev_1/checkins/chk_1/complete")
    }

    func testRefusesToSignWhatWasNotAskedFor() async throws {
        let cases: [String: (inout [String: JSONValue]) -> Void] = [
            "type": { $0["type"] = "site_exit" },
            "site_id": { $0["site_id"] = "site_999" },
            "device_id": { $0["device_id"] = "dev_2" },
            "location.lat_e7": { $0["location"] = ["lat_e7": 356912360, "lng_e7": 1397671200, "accuracy_m": 12] },
            "location.accuracy_m": { $0["location"] = ["lat_e7": 356812360, "lng_e7": 1397671200, "accuracy_m": 1] },
            "attributes": { $0["attributes"] = ["gate": "西ゲート"] },
        ]
        for (field, change) in cases {
            let t = FakeTransport(["/checkins": (201, try issued(event(change)))])
            do {
                _ = try await client(t).start(try request())
                XCTFail("\(field) accepted")
            } catch let e as IssuedCheckInMismatch {
                XCTAssertEqual(e.field, field)
            }
        }
        // The event is as requested, but the challenge is for another event.
        let t = FakeTransport(["/checkins": (201, try issued(event(), challengeOf: event { $0["type"] = "site_exit" }))])
        do {
            _ = try await client(t).start(try request())
            XCTFail("foreign challenge accepted")
        } catch let e as IssuedCheckInMismatch {
            XCTAssertEqual(e.field, "challenge")
        }
    }

    func testSurfacesServerErrors() async throws {
        let t = FakeTransport(["/checkins": (409, #"{"error":{"code":"site_location_missing","message":"site has no location"}}"#)])
        do {
            _ = try await client(t).start(try request())
            XCTFail("no error")
        } catch let e as CheckInAPIError {
            XCTAssertEqual(e.status, 409)
            XCTAssertEqual(e.code, "site_location_missing")
        }
    }

    func testRoundsLikeTheReference() {
        XCTAssertEqual(Geo.toE7(35.681236), 356812360)
        XCTAssertEqual(Geo.toE7(-139.76712), -1397671200)
    }
}
