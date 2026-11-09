import Foundation

/// Where the app keeps the nonce bundle while offline. Implement on encrypted,
/// persistent storage (e.g. a file with Data Protection, or the Keychain). Must survive restarts.
public protocol BundleStore: AnyObject {
    func current() -> DeviceBundle?
    func replace(_ bundle: DeviceBundle)
    /// Removes and returns the lowest unused nonce, or nil when the batch is used up.
    func takeNonce() -> DeviceBundle.Nonce?
    /// Puts back a nonce whose check-in was cancelled before signing.
    func releaseNonce(_ nonce: DeviceBundle.Nonce)
    func remaining() -> Int
}

/// Signed records waiting for upload. Must survive restarts.
public protocol RecordQueue: AnyObject {
    func add(_ record: UploadRecord)
    func pending() -> [UploadRecord]
    /// Called after the server answered accepted, duplicate or rejected for these sequence numbers.
    func remove(_ seqs: [Int64])
}

public final class InMemoryBundleStore: BundleStore {
    private let lock = NSLock()
    private var bundle: DeviceBundle?
    private var unused: [Int64: DeviceBundle.Nonce] = [:]

    public init() {}

    public func current() -> DeviceBundle? { lock.withLock { bundle } }

    public func replace(_ bundle: DeviceBundle) {
        lock.withLock {
            self.bundle = bundle
            unused = Dictionary(bundle.nonces.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
        }
    }

    public func takeNonce() -> DeviceBundle.Nonce? {
        lock.withLock {
            guard let first = unused.keys.min() else { return nil }
            return unused.removeValue(forKey: first)
        }
    }

    public func releaseNonce(_ nonce: DeviceBundle.Nonce) {
        lock.withLock {
            if bundle?.nonces.contains(where: { $0.seq == nonce.seq }) == true { unused[nonce.seq] = nonce }
        }
    }

    public func remaining() -> Int { lock.withLock { unused.count } }
}

public final class InMemoryRecordQueue: RecordQueue {
    private let lock = NSLock()
    private var records: [Int64: UploadRecord] = [:]

    public init() {}

    public func add(_ record: UploadRecord) { lock.withLock { records[record.event.seq] = record } }
    public func pending() -> [UploadRecord] { lock.withLock { records.keys.sorted().map { records[$0]! } } }
    public func remove(_ seqs: [Int64]) { lock.withLock { seqs.forEach { records.removeValue(forKey: $0) } } }
}
