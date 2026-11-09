package id.intentgate.basicauth

import java.security.MessageDigest
import java.util.Base64

internal object Base64Url {
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()
    private val alphabet = Regex("^[A-Za-z0-9_-]*$")

    fun encode(bytes: ByteArray): String = encoder.encodeToString(bytes)

    fun decode(text: String): ByteArray {
        require(alphabet.matches(text) && text.length % 4 != 1) { "invalid base64url" }
        return decoder.decode(text)
    }
}

internal fun sha256(vararg parts: ByteArray): ByteArray {
    val md = MessageDigest.getInstance("SHA-256")
    parts.forEach { md.update(it) }
    return md.digest()
}

internal fun hexToBytes(hex: String): ByteArray {
    require(hex.length % 2 == 0 && hex.all { it in "0123456789abcdefABCDEF" }) { "invalid hex" }
    return ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
