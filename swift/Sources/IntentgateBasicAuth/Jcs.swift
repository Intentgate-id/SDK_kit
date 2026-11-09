import Foundation

/// JSON Canonicalization Scheme (RFC 8785), restricted profile shared by all
/// Intentgate SDKs: numbers must be integers within ±(2^53 − 1).
public enum Jcs {
    public static let maxSafeInteger: Int64 = 9_007_199_254_740_991

    public struct CanonicalizationError: Error, CustomStringConvertible {
        public let description: String
    }

    public static func canonicalize(_ value: JSONValue) throws -> String {
        var out = ""
        try write(&out, value, path: "$")
        return out
    }

    private static func write(_ out: inout String, _ value: JSONValue, path: String) throws {
        switch value {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let n):
            guard n <= maxSafeInteger && n >= -maxSafeInteger else {
                throw CanonicalizationError(description: "\(path): integer out of safe range")
            }
            out += String(n)
        case .double(let d):
            throw CanonicalizationError(description: "\(path): only integers are allowed (got \(d))")
        case .string(let s): writeString(&out, s)
        case .array(let a):
            out += "["
            for (i, v) in a.enumerated() {
                if i > 0 { out += "," }
                try write(&out, v, path: "\(path)[\(i)]")
            }
            out += "]"
        case .object(let o):
            // RFC 8785 orders keys by UTF-16 code units.
            let keys = o.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
            out += "{"
            for (i, key) in keys.enumerated() {
                if i > 0 { out += "," }
                writeString(&out, key)
                out += ":"
                try write(&out, o[key]!, path: "\(path).\(key)")
            }
            out += "}"
        }
    }

    /// Same output as ECMAScript JSON.stringify. Swift strings cannot hold lone surrogates.
    private static func writeString(_ out: inout String, _ s: String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    let hex = String(scalar.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}
