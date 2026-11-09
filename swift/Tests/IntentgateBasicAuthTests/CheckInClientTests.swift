import Foundation
import XCTest
@testable import IntentgateBasicAuth

final class CheckInClientTests: XCTestCase {
    private let seed = Hex.decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")!
    // 2026-11-09 08:00:05 JST
    private let now = Date(timeIntervalSince1970: 1_794_178_805)
    private let tokyo = TimeZone(identifier: "Asia/Tokyo")!
    private let assertion = Data(#"{"id":"cred","rawId":"cred","type":"public-key","response":{"clientDataJSON":"e30","authenticatorData":"AA","signature":"AA"}}"#.utf8)

    private func siteToken() throws -> String {
        try SiteToken(siteId: "site_a", kid: "k1", t: SiteToken.window(Int64(now.timeIntervalSince1970)))
            .encode(signer: Ed25519.signer(seed: seed))
    }

    private func client(lockAfter: String = "2026-11-15T23:00:00Z", at date: Date? = nil) throws -> (CheckInClient, InMemoryBundleStore) {
        let json = """
        {"device_id":"dev_1","nonce_kid":"n1","lock_after":"\(lockAfter)",
         "event_types":[{"type":"site_entry","billable":true},{"type":"site_exit","billable":true}],
         "nonces":[{"seq":0,"nonce":"\(Base64Url.encode(Data(repeating: 1, count: 32)))"},
                   {"seq":1,"nonce":"\(Base64Url.encode(Data(repeating: 2, count: 32)))"}]}
        """
        let store = InMemoryBundleStore()
        let client = CheckInClient(bundles: store, queue: InMemoryRecordQueue(), timeZone: tokyo, now: { date ?? self.now })
        client.sync(bundle: try DeviceBundle.parse(Data(json.utf8)))
        return (client, store)
    }

    func testPreparesSignsAndQueuesOffline() throws {
        let (client, store) = try client()
        let prepared = try client.prepare(type: "site_entry", siteToken: siteToken(), attributes: ["gate": "東ゲート"])
        XCTAssertEqual(prepared.event.seq, 0)
        XCTAssertEqual(prepared.event.occurredAt, "2026-11-09T08:00:05+09:00")
        XCTAssertEqual(prepared.challenge, try Challenge.computeBase64Url(nonce: Data(repeating: 1, count: 32), event: prepared.event))
        XCTAssertEqual(prepared.challengeData.count, 32)
        try client.complete(prepared, assertionJSON: assertion)
        XCTAssertEqual(store.remaining(), 1)

        let body = try JSONValue.parse(XCTUnwrap(client.uploadBody()))
        XCTAssertEqual(body["device_id"], "dev_1")
        XCTAssertEqual(body["records"]?.arrayValue?.count, 1)
        XCTAssertEqual(body["records"]?.arrayValue?.first?["event"], prepared.event.json)
        client.acknowledge([0])
        XCTAssertNil(try client.uploadBody())
    }

    func testTimestampKeepsZeroSeconds() throws {
        let (client, _) = try client(at: Date(timeIntervalSince1970: 1_794_178_800))
        XCTAssertEqual(try client.prepare(type: "site_entry", siteToken: siteToken()).event.occurredAt, "2026-11-09T08:00:00+09:00")
    }

    func testCancelReturnsTheNonce() throws {
        let (client, store) = try client()
        client.cancel(try client.prepare(type: "site_entry", siteToken: siteToken()))
        XCTAssertEqual(store.remaining(), 2)
        XCTAssertEqual(try client.prepare(type: "site_exit", siteToken: siteToken()).event.seq, 0)
    }

    func testRefusesWhenLockedOutOfNoncesOrGivenUnknownInput() throws {
        let (locked, _) = try client(lockAfter: "2026-11-08T00:00:00Z")
        XCTAssertTrue(locked.isLocked)
        XCTAssertThrowsError(try locked.prepare(type: "site_entry", siteToken: siteToken())) {
            XCTAssertEqual($0 as? CheckInError, .offlineLocked)
        }
        let (c, _) = try client()
        XCTAssertThrowsError(try c.prepare(type: "crane_start", siteToken: siteToken())) {
            XCTAssertEqual($0 as? CheckInError, .unknownEventType("crane_start"))
        }
        XCTAssertThrowsError(try c.prepare(type: "site_entry", siteToken: "https://example.com/not-a-site"))
        XCTAssertThrowsError(try c.complete(c.prepare(type: "site_entry", siteToken: siteToken()), assertionJSON: Data("{}".utf8)))
        _ = try c.prepare(type: "site_entry", siteToken: siteToken())
        XCTAssertThrowsError(try c.prepare(type: "site_entry", siteToken: siteToken())) {
            XCTAssertEqual($0 as? CheckInError, .noNonce)
        }
    }

    func testSiteTokenGeneratorRotatesEvery30Seconds() throws {
        var current = Date(timeIntervalSince1970: 1_794_178_805)
        let generator = SiteTokenGenerator(siteId: "site_a", kid: "k1", signer: try Ed25519.signer(seed: seed), now: { current })
        let first = try generator.current()
        XCTAssertEqual(try generator.current(), first)
        XCTAssertEqual(generator.secondsUntilRotation(), 25)
        current = current.addingTimeInterval(25)
        let second = try generator.current()
        XCTAssertNotEqual(second, first)
        XCTAssertEqual(try SiteToken.parse(second).t, 1_794_178_830)
    }
}
