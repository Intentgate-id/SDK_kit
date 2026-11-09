#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
import Foundation

func sha256(_ parts: Data...) -> Data {
    var hasher = SHA256()
    for part in parts { hasher.update(data: part) }
    return Data(hasher.finalize())
}
