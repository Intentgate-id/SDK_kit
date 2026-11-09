package id.intentgate.basicauth

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI

/** An error answer from Intentgate. [code] is the reason, e.g. "unknown_site", "checkin_expired". */
class CheckInApiException(val status: Int, val code: String, message: String) :
    IOException("Intentgate $status $code: $message")

/** HTTP POST with a bearer token. Replace it to use OkHttp, Ktor or a test double. */
fun interface Transport {
    /** Returns (status, body). Throws IOException when the network fails. */
    fun post(url: String, bearerToken: String, jsonBody: String): Pair<Int, String>
}

/** Default transport on HttpURLConnection (available on the JVM and Android). Blocking. */
class UrlConnectionTransport(private val timeoutMillis: Int = 15_000) : Transport {
    override fun post(url: String, bearerToken: String, jsonBody: String): Pair<Int, String> {
        val conn = URI(url).toURL().openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = timeoutMillis
            conn.readTimeout = timeoutMillis
            conn.doOutput = true
            conn.setRequestProperty("authorization", "Bearer $bearerToken")
            conn.setRequestProperty("content-type", "application/json")
            conn.outputStream.use { it.write(jsonBody.toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            return status to body
        } finally {
            conn.disconnect()
        }
    }
}

/**
 * Worker-side check-in (online). Calls are blocking: run them off the main thread.
 *
 *   val issued = client.start(CheckInRequest("site_entry", siteId, lat, lng, accuracy))
 *   // show issued.event to the worker, then the passkey prompt:
 *   val assertionJson = passkeySigner.sign(issued.challenge, issued.allowCredentials)
 *   val result = client.complete(issued.checkinId, assertionJson)
 *
 * [start] verifies the issued event before returning, so the app never signs something
 * other than what it asked for. [complete] is safe to repeat after a network error:
 * a second call answers status "duplicate" with the stored result.
 *
 * @param baseUrl e.g. "https://checkin.intentgate.id"
 * @param deviceToken the device token (igd_…) your backend handed to this phone. Keep it in
 *   encrypted storage (Android Keystore / EncryptedSharedPreferences).
 */
class CheckInClient(
    baseUrl: String,
    val deviceId: String,
    private val deviceToken: String,
    private val transport: Transport = UrlConnectionTransport(),
) {
    private val base = baseUrl.trimEnd('/')

    fun start(request: CheckInRequest): IssuedCheckIn {
        val body = call("/v1/devices/$deviceId/checkins", request.toJson())
        val issued = IssuedCheckIn.parse(body)
        issued.verify(deviceId, request)
        return issued
    }

    /** [assertionJson] is the WebAuthn AuthenticationResponseJSON from the passkey. */
    fun complete(checkinId: String, assertionJson: String): CheckInResult {
        val parsed = Json.parse(assertionJson) as? Map<*, *> ?: throw IllegalArgumentException("assertion must be a JSON object")
        require(parsed["id"] is String && parsed["response"] is Map<*, *>) { "not a WebAuthn assertion" }
        val body = call("/v1/devices/$deviceId/checkins/$checkinId/complete", """{"assertion":$assertionJson}""")
        return CheckInResult.parse(body)
    }

    private fun call(path: String, json: String): String {
        val (status, body) = transport.post("$base$path", deviceToken, json)
        if (status in 200..299) return body
        val err = (runCatching { Json.parse(body) }.getOrNull() as? Map<*, *>)?.get("error") as? Map<*, *>
        throw CheckInApiException(status, err?.get("code") as? String ?: "http_$status", err?.get("message") as? String ?: body.take(200))
    }
}
