package id.intentgate.basicauth.android

import android.app.Activity
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialCancellationException
import id.intentgate.basicauth.CheckInClient
import id.intentgate.basicauth.CheckInRequest
import id.intentgate.basicauth.CheckInResult
import id.intentgate.basicauth.IssuedCheckIn
import id.intentgate.basicauth.Jcs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class PasskeyCancelledException : Exception("the user cancelled the passkey prompt")

/**
 * Signs check-in challenges with the worker's passkey through Android Credential Manager
 * (biometric / screen lock, user verification required).
 *
 * NOTE: not built in CI yet (no Android SDK there). Treat as a reference implementation.
 */
class PasskeySigner(private val activity: Activity, private val rpId: String) {
    private val credentialManager = CredentialManager.create(activity)

    /** Returns the WebAuthn AuthenticationResponseJSON for the challenge. */
    suspend fun sign(challenge: String, allowCredentialIds: List<String> = emptyList()): String {
        val requestJson = Jcs.canonicalize(
            mapOf(
                "challenge" to challenge,
                "rpId" to rpId,
                "userVerification" to "required",
                "timeout" to 60_000,
                "allowCredentials" to allowCredentialIds.map { mapOf("type" to "public-key", "id" to it) },
            ),
        )
        val request = GetCredentialRequest(listOf(GetPublicKeyCredentialOption(requestJson)))
        val result = try {
            credentialManager.getCredential(activity, request)
        } catch (e: GetCredentialCancellationException) {
            throw PasskeyCancelledException()
        }
        val credential = result.credential as? PublicKeyCredential
            ?: throw IllegalStateException("not a passkey credential")
        return credential.authenticationResponseJson
    }

    /**
     * Creates a passkey from the server's PublicKeyCredentialCreationOptions JSON
     * and returns the RegistrationResponseJSON to send back to the server.
     */
    suspend fun register(creationOptionsJson: String): String {
        val response = try {
            credentialManager.createCredential(activity, CreatePublicKeyCredentialRequest(creationOptionsJson))
        } catch (e: CreateCredentialCancellationException) {
            throw PasskeyCancelledException()
        }
        return (response as CreatePublicKeyCredentialResponse).registrationResponseJson
    }
}

/**
 * Full check-in: ask the server (with the position), check the issued event, show the
 * passkey prompt, complete. [confirm] runs between the server's answer and the prompt,
 * e.g. to show the worker the site name and time; return false to stop.
 *
 *   val location = fusedLocationClient.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null).await()
 *   val result = client.checkIn(signer, CheckInRequest("site_entry", siteId,
 *       location.latitude, location.longitude, location.accuracy.toDouble()))
 */
suspend fun CheckInClient.checkIn(
    signer: PasskeySigner,
    request: CheckInRequest,
    confirm: suspend (IssuedCheckIn) -> Boolean = { true },
): CheckInResult? {
    val issued = withContext(Dispatchers.IO) { start(request) }
    if (!confirm(issued)) return null
    val assertion = signer.sign(issued.challenge, issued.allowCredentials)
    return withContext(Dispatchers.IO) { complete(issued.checkinId, assertion) }
}
