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
import id.intentgate.basicauth.Jcs
import id.intentgate.basicauth.PreparedCheckIn

class PasskeyCancelledException : Exception("the user cancelled the passkey prompt")

/**
 * Signs check-in challenges with the worker's passkey through Android Credential Manager.
 * Signing happens on the device, so it works without network once the passkey exists.
 * Registration ([register]) needs network.
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
 * Full offline check-in: prepare, biometric signature, queue.
 * A cancelled prompt returns the nonce so no sequence gap is left behind.
 */
suspend fun CheckInClient.checkIn(
    signer: PasskeySigner,
    type: String,
    siteToken: String,
    attributes: Map<String, Any?> = emptyMap(),
) = prepare(type, siteToken, attributes).let { prepared: PreparedCheckIn ->
    val assertion = try {
        signer.sign(prepared.challenge)
    } catch (e: Exception) {
        cancel(prepared)
        throw e
    }
    complete(prepared, assertion)
}
