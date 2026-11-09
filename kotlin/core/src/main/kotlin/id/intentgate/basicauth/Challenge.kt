package id.intentgate.basicauth

/**
 * challenge = SHA-256( "intentgate-basic-auth/v1" || 0x00 || nonce || JCS(event) )
 */
object Challenge {
    const val DOMAIN = "intentgate-basic-auth/v1"
    const val NONCE_LENGTH = 32

    fun compute(nonce: ByteArray, event: CheckInEvent): ByteArray {
        require(nonce.size == NONCE_LENGTH) { "nonce must be $NONCE_LENGTH bytes" }
        return sha256(DOMAIN.toByteArray(Charsets.UTF_8), byteArrayOf(0), nonce, event.canonicalJson().toByteArray(Charsets.UTF_8))
    }

    fun computeBase64Url(nonce: ByteArray, event: CheckInEvent): String = Base64Url.encode(compute(nonce, event))
}
