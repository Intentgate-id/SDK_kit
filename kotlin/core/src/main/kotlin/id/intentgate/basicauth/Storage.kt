package id.intentgate.basicauth

/**
 * Where the app keeps the nonce bundle and the signed records while offline.
 * Implement on encrypted storage (e.g. Room + SQLCipher, or EncryptedFile).
 * Both stores must survive app restarts.
 */
interface BundleStore {
    fun current(): DeviceBundle?
    fun replace(bundle: DeviceBundle)
    /** Removes and returns the lowest unused nonce, or null when the batch is used up. */
    fun takeNonce(): DeviceBundle.Nonce?
    /** Puts back a nonce whose check-in was cancelled before signing. */
    fun releaseNonce(nonce: DeviceBundle.Nonce)
    fun remaining(): Int
}

interface RecordQueue {
    fun add(record: UploadRecord)
    fun pending(): List<UploadRecord>
    /** Called after the server answered accepted, duplicate or rejected for these sequence numbers. */
    fun remove(seqs: Collection<Long>)
}

class InMemoryBundleStore : BundleStore {
    private var bundle: DeviceBundle? = null
    private val unused = sortedMapOf<Long, DeviceBundle.Nonce>()

    @Synchronized override fun current() = bundle

    @Synchronized override fun replace(bundle: DeviceBundle) {
        this.bundle = bundle
        unused.clear()
        bundle.nonces.forEach { unused[it.seq] = it }
    }

    @Synchronized override fun takeNonce(): DeviceBundle.Nonce? {
        val first = unused.keys.firstOrNull() ?: return null
        return unused.remove(first)
    }

    @Synchronized override fun releaseNonce(nonce: DeviceBundle.Nonce) {
        if (bundle?.nonces?.any { it.seq == nonce.seq } == true) unused[nonce.seq] = nonce
    }

    @Synchronized override fun remaining() = unused.size
}

class InMemoryRecordQueue : RecordQueue {
    private val records = sortedMapOf<Long, UploadRecord>()
    @Synchronized override fun add(record: UploadRecord) { records[record.event.seq] = record }
    @Synchronized override fun pending() = records.values.toList()
    @Synchronized override fun remove(seqs: Collection<Long>) { seqs.forEach { records.remove(it) } }
}
