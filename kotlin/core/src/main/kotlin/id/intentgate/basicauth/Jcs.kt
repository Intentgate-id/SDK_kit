package id.intentgate.basicauth

/**
 * JSON Canonicalization Scheme (RFC 8785), restricted profile shared by all
 * Intentgate SDKs: numbers must be integers within ±(2^53 − 1).
 *
 * Accepted values: null, Boolean, Int/Long/Short/Byte, String, Map<String, *>, List<*>.
 */
object Jcs {
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    class CanonicalizationException(message: String) : IllegalArgumentException(message)

    fun canonicalize(value: Any?): String = StringBuilder().also { write(it, value, "$") }.toString()

    private fun write(out: StringBuilder, value: Any?, path: String) {
        when (value) {
            null -> out.append("null")
            is Boolean -> out.append(if (value) "true" else "false")
            is Int, is Long, is Short, is Byte -> {
                val n = (value as Number).toLong()
                if (n > MAX_SAFE_INTEGER || n < -MAX_SAFE_INTEGER) {
                    throw CanonicalizationException("$path: integer out of safe range")
                }
                out.append(n)
            }
            is Number -> throw CanonicalizationException("$path: only integers are allowed (got $value)")
            is String -> writeString(out, value)
            is Map<*, *> -> {
                val keys = value.keys.map {
                    it as? String ?: throw CanonicalizationException("$path: object keys must be strings")
                }.sorted() // String.compareTo orders by UTF-16 code units, as RFC 8785 requires.
                out.append('{')
                keys.forEachIndexed { i, key ->
                    if (i > 0) out.append(',')
                    writeString(out, key)
                    out.append(':')
                    write(out, value[key], "$path.$key")
                }
                out.append('}')
            }
            is List<*> -> {
                out.append('[')
                value.forEachIndexed { i, v ->
                    if (i > 0) out.append(',')
                    write(out, v, "$path[$i]")
                }
                out.append(']')
            }
            else -> throw CanonicalizationException("$path: unsupported type ${value::class.java.name}")
        }
    }

    /** Same output as ECMAScript JSON.stringify (ES2019, well-formed). */
    private fun writeString(out: StringBuilder, s: String) {
        out.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\b' -> out.append("\\b")
                c == '\u000C' -> out.append("\\f")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' -> out.append("\\u").append(String.format("%04x", c.code))
                Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> {
                    out.append(c).append(s[i + 1])
                    i++
                }
                Character.isSurrogate(c) -> out.append("\\u").append(String.format("%04x", c.code))
                else -> out.append(c)
            }
            i++
        }
        out.append('"')
    }
}
