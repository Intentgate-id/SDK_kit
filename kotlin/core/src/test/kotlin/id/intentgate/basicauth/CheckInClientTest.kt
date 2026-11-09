package id.intentgate.basicauth

import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CheckInClientTest {
    private val seed = hexToBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    private val now = Instant.parse("2026-11-08T23:00:05Z")
    private val clock = Clock.fixed(now, ZoneId.of("Asia/Tokyo"))
    private val siteToken = SiteToken("site_a", "k1", SiteToken.window(now.epochSecond)).encode(SiteToken.jdkSigner(seed))

    private fun bundleJson(lockAfter: String = "2026-11-15T23:00:00Z") = """
        {"device_id":"dev_1","nonce_kid":"n1","lock_after":"$lockAfter",
         "event_types":[{"type":"site_entry","billable":true},{"type":"site_exit","billable":true}],
         "nonces":[{"seq":0,"nonce":"${Base64Url.encode(ByteArray(32) { 1 })}"},
                   {"seq":1,"nonce":"${Base64Url.encode(ByteArray(32) { 2 })}"}]}
    """.trimIndent()

    private fun client(lockAfter: String = "2026-11-15T23:00:00Z"): Pair<CheckInClient, InMemoryBundleStore> {
        val store = InMemoryBundleStore().apply { replace(DeviceBundle.parse(bundleJson(lockAfter))) }
        return CheckInClient(store, InMemoryRecordQueue(), clock) to store
    }

    private val assertion = """{"id":"cred","rawId":"cred","type":"public-key","response":{"clientDataJSON":"e30","authenticatorData":"AA","signature":"AA"}}"""

    @Test
    fun preparesSignsAndQueuesOffline() {
        val (client, store) = client()
        val prepared = client.prepare("site_entry", siteToken, mapOf("gate" to "東ゲート"))
        assertEquals(0L, prepared.event.seq)
        assertEquals("2026-11-09T08:00:05+09:00", prepared.event.occurredAt)
        assertEquals(Challenge.computeBase64Url(ByteArray(32) { 1 }, prepared.event), prepared.challenge)
        client.complete(prepared, assertion)
        assertEquals(1, store.remaining())
        val body = Json.parse(client.uploadBody()!!) as Map<*, *>
        assertEquals("dev_1", body["device_id"])
        assertEquals(1, (body["records"] as List<*>).size)
        client.acknowledge(listOf(0L))
        assertNull(client.uploadBody())
    }

    @Test
    fun timestampKeepsZeroSeconds() {
        val store = InMemoryBundleStore().apply { replace(DeviceBundle.parse(bundleJson())) }
        val atZero = Clock.fixed(Instant.parse("2026-11-08T23:00:00Z"), ZoneId.of("Asia/Tokyo"))
        val prepared = CheckInClient(store, InMemoryRecordQueue(), atZero).prepare("site_entry", siteToken)
        assertEquals("2026-11-09T08:00:00+09:00", prepared.event.occurredAt)
        val utc = Clock.fixed(Instant.parse("2026-11-08T23:00:00Z"), ZoneId.of("UTC"))
        assertEquals("2026-11-08T23:00:00Z", CheckInClient(store, InMemoryRecordQueue(), utc).prepare("site_entry", siteToken).event.occurredAt)
    }

    @Test
    fun cancelReturnsTheNonce() {
        val (client, store) = client()
        client.cancel(client.prepare("site_entry", siteToken))
        assertEquals(2, store.remaining())
        assertEquals(0L, client.prepare("site_exit", siteToken).event.seq)
    }

    @Test
    fun refusesWhenLockedOutOfNoncesOrGivenUnknownInput() {
        assertTrue(client("2026-11-08T00:00:00Z").first.isLocked())
        assertFailsWith<OfflineLockedException> { client("2026-11-08T00:00:00Z").first.prepare("site_entry", siteToken) }
        val (c, _) = client()
        assertFailsWith<UnknownEventTypeException> { c.prepare("crane_start", siteToken) }
        assertFailsWith<SiteToken.SiteTokenException> { c.prepare("site_entry", "https://example.com/not-a-site") }
        c.prepare("site_entry", siteToken)
        c.prepare("site_entry", siteToken)
        assertFailsWith<NoNonceException> { c.prepare("site_entry", siteToken) }
    }
}
