package id.intentgate.basicauth

/**
 * challenge = SHA-256( "intentgate-basic-auth/v2" || 0x00 || JCS(event) )
 *
 * The passkey signs clientDataJSON, which carries this challenge, so the signature
 * covers the type, site, device, position, server time and server nonce.
 */
object Challenge {
    const val DOMAIN = "intentgate-basic-auth/v2"

    fun compute(event: CheckInEvent): ByteArray =
        sha256(DOMAIN.toByteArray(Charsets.UTF_8), byteArrayOf(0), event.canonicalJson().toByteArray(Charsets.UTF_8))

    fun computeBase64Url(event: CheckInEvent): String = Base64Url.encode(compute(event))
}
