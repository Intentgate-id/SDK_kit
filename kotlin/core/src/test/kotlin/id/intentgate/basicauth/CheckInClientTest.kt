package id.intentgate.basicauth

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class CheckInClientTest {
    private val request = CheckInRequest("site_entry", "site_123", 35.681236, 139.76712, 11.4, mapOf("gate" to "東ゲート"))

    /** What the server would fix for [request]; [tamper] changes it the way a bad server might. */
    private fun issuedJson(tamper: (MutableMap<String, Any?>) -> Unit = {}, challengeFor: Map<String, Any?>? = null): String {
        val event = linkedMapOf<String, Any?>(
            "v" to 2L, "type" to "site_entry", "checkin_id" to "chk_1", "device_id" to "dev_1", "site_id" to "site_123",
            "nonce" to Base64Url.encode(ByteArray(32) { 7 }), "issued_at" to "2026-11-08T22:58:12.000Z",
            "location" to mapOf("lat_e7" to 356812360L, "lng_e7" to 1397671200L, "accuracy_m" to 12L),
            "attributes" to mapOf("gate" to "東ゲート"),
        )
        val honest = Challenge.computeBase64Url(CheckInEvent.fromJsonMap(challengeFor ?: event))
        tamper(event)
        val challenge = if (challengeFor == null) Challenge.computeBase64Url(CheckInEvent.fromJsonMap(event)) else honest
        return Jcs.canonicalize(mapOf(
            "checkin_id" to "chk_1", "event" to event, "challenge" to challenge,
            "expires_at" to "2026-11-08T23:01:12.000Z", "rp_id" to "app.example.co.jp", "allow_credentials" to listOf("cred1"),
        ))
    }

    private class FakeTransport(val answers: Map<String, Pair<Int, String>>) : Transport {
        val calls = mutableListOf<Triple<String, String, String>>()
        override fun post(url: String, bearerToken: String, jsonBody: String): Pair<Int, String> {
            calls += Triple(url, bearerToken, jsonBody)
            return answers.entries.first { url.endsWith(it.key) }.value
        }
    }

    private val assertion = """{"id":"cred1","rawId":"cred1","type":"public-key","response":{"clientDataJSON":"e30","authenticatorData":"AA","signature":"AA"}}"""
    private val resultJson = """{"checkin_id":"chk_1","status":"accepted","flags":["outside_site"],"billable":true,"distance_m":412}"""

    @Test
    fun startsVerifiesAndCompletes() {
        val t = FakeTransport(mapOf("/checkins" to (201 to issuedJson()), "/complete" to (200 to resultJson)))
        val client = CheckInClient("https://checkin.example/", "dev_1", "igd_secret", t)
        val issued = client.start(request)
        assertEquals("chk_1", issued.checkinId)
        assertEquals(listOf("cred1"), issued.allowCredentials)
        val result = client.complete(issued.checkinId, assertion)
        assertEquals("accepted", result.status)
        assertEquals(412L, result.distanceM)
        assertTrue(result.needsReview)

        val (url, token, body) = t.calls[0]
        assertEquals("https://checkin.example/v1/devices/dev_1/checkins", url)
        assertEquals("igd_secret", token)
        assertEquals("""{"type":"site_entry","site_id":"site_123","location":{"latitude":35.681236,"longitude":139.76712,"accuracy_m":11.4},"attributes":{"gate":"東ゲート"}}""", body)
        assertEquals("https://checkin.example/v1/devices/dev_1/checkins/chk_1/complete", t.calls[1].first)
        assertTrue(t.calls[1].third.startsWith("""{"assertion":{"id":"cred1""""))
    }

    @Test
    fun refusesToSignWhatWasNotAskedFor() {
        val cases = mapOf<String, (MutableMap<String, Any?>) -> Unit>(
            "type" to { it["type"] = "site_exit" },
            "site_id" to { it["site_id"] = "site_999" },
            "device_id" to { it["device_id"] = "dev_2" },
            "location.lat_e7" to { it["location"] = mapOf("lat_e7" to 356912360L, "lng_e7" to 1397671200L, "accuracy_m" to 12L) },
            "location.accuracy_m" to { it["location"] = mapOf("lat_e7" to 356812360L, "lng_e7" to 1397671200L, "accuracy_m" to 1L) },
            "attributes" to { it["attributes"] = mapOf("gate" to "西ゲート") },
        )
        for ((what, tamper) in cases) {
            val t = FakeTransport(mapOf("/checkins" to (201 to issuedJson(tamper))))
            val e = assertFailsWith<IssuedCheckInMismatchException>(what) { CheckInClient("https://x", "dev_1", "igd_t", t).start(request) }
            assertTrue(e.message!!.endsWith(what), "$what: ${e.message}")
        }
    }

    @Test
    fun refusesAChallengeThatIsNotTheEventHash() {
        // Event as requested, but the challenge belongs to a different (exit) event.
        val other = linkedMapOf<String, Any?>(
            "v" to 2L, "type" to "site_exit", "checkin_id" to "chk_1", "device_id" to "dev_1", "site_id" to "site_123",
            "nonce" to Base64Url.encode(ByteArray(32) { 7 }), "issued_at" to "2026-11-08T22:58:12.000Z",
            "location" to mapOf("lat_e7" to 356812360L, "lng_e7" to 1397671200L, "accuracy_m" to 12L),
            "attributes" to mapOf("gate" to "東ゲート"),
        )
        val t = FakeTransport(mapOf("/checkins" to (201 to issuedJson(challengeFor = other))))
        val e = assertFailsWith<IssuedCheckInMismatchException> { CheckInClient("https://x", "dev_1", "igd_t", t).start(request) }
        assertTrue(e.message!!.endsWith("challenge"))
    }

    @Test
    fun surfacesServerErrors() {
        val t = FakeTransport(mapOf("/checkins" to (409 to """{"error":{"code":"site_location_missing","message":"site has no location"}}""")))
        val e = assertFailsWith<CheckInApiException> { CheckInClient("https://x", "dev_1", "igd_t", t).start(request) }
        assertEquals(409, e.status)
        assertEquals("site_location_missing", e.code)
    }

    @Test
    fun roundsLikeTheReference() {
        assertEquals(356812360L, Geo.toE7(35.681236))
        assertEquals(-1397671200L, Geo.toE7(-139.76712))
        assertEquals(1L, Geo.toE7(0.00000005))
    }

    @Test
    fun rejectsMalformedEvents() {
        assertFailsWith<IllegalArgumentException> {
            CheckInEvent("site_entry", "chk_1", "dev_1", "s", "short", "2026-11-08T22:58:12Z", EventLocation(0, 0, 1))
        }
        assertFailsWith<IllegalArgumentException> {
            CheckInEvent("site_entry", "chk_1", "dev_1", "s", Base64Url.encode(ByteArray(32)), "2026-11-08T22:58:12+09:00", EventLocation(0, 0, 1))
        }
    }
}
