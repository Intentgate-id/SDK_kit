package id.intentgate.basicauth

import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class SiteTokenGeneratorTest {
    private val signer = SiteToken.jdkSigner(ByteArray(32) { 9 })

    private fun at(epoch: Long) = SiteTokenGenerator("site_a", "k1", signer, Clock.fixed(Instant.ofEpochSecond(epoch), ZoneOffset.UTC))

    @Test
    fun rotatesEveryThirtySeconds() {
        assertEquals(at(1_762_642_680).current(), at(1_762_642_709).current())
        assertNotEquals(at(1_762_642_709).current(), at(1_762_642_710).current())
        assertEquals(1_762_642_680, SiteToken.parse(at(1_762_642_699).current()).t)
        assertEquals(11, at(1_762_642_699).secondsUntilRotation())
    }
}
