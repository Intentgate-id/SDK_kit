package id.intentgate.basicauth

/**
 * Minimal JSON reader for server answers and assertion JSON.
 * Integers become Long, other numbers Double, objects LinkedHashMap.
 */
internal object Json {
    class ParseException(message: String) : IllegalArgumentException(message)

    fun parse(text: String): Any? {
        val p = Parser(text)
        p.skipWs()
        val v = p.value()
        p.skipWs()
        if (p.pos != text.length) throw ParseException("trailing data at ${p.pos}")
        return v
    }

    private class Parser(val s: String) {
        var pos = 0

        fun skipWs() {
            while (pos < s.length && s[pos] in " \t\r\n") pos++
        }

        fun value(): Any? {
            if (pos >= s.length) throw ParseException("unexpected end")
            return when (val c = s[pos]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c.isDigit()) num() else throw ParseException("unexpected '$c' at $pos")
            }
        }

        private fun literal(word: String, v: Any?): Any? {
            if (!s.startsWith(word, pos)) throw ParseException("invalid literal at $pos")
            pos += word.length
            return v
        }

        private fun obj(): Map<String, Any?> {
            val m = LinkedHashMap<String, Any?>()
            pos++
            skipWs()
            if (s.getOrNull(pos) == '}') { pos++; return m }
            while (true) {
                skipWs()
                if (s.getOrNull(pos) != '"') throw ParseException("expected key at $pos")
                val k = str()
                skipWs()
                if (s.getOrNull(pos) != ':') throw ParseException("expected ':' at $pos")
                pos++
                skipWs()
                if (m.containsKey(k)) throw ParseException("duplicate key '$k'")
                m[k] = value()
                skipWs()
                when (s.getOrNull(pos)) {
                    ',' -> pos++
                    '}' -> { pos++; return m }
                    else -> throw ParseException("expected ',' or '}' at $pos")
                }
            }
        }

        private fun arr(): List<Any?> {
            val l = ArrayList<Any?>()
            pos++
            skipWs()
            if (s.getOrNull(pos) == ']') { pos++; return l }
            while (true) {
                skipWs()
                l.add(value())
                skipWs()
                when (s.getOrNull(pos)) {
                    ',' -> pos++
                    ']' -> { pos++; return l }
                    else -> throw ParseException("expected ',' or ']' at $pos")
                }
            }
        }

        private fun str(): String {
            val sb = StringBuilder()
            pos++
            while (true) {
                if (pos >= s.length) throw ParseException("unterminated string")
                val c = s[pos++]
                when {
                    c == '"' -> return sb.toString()
                    c == '\\' -> {
                        when (val e = s.getOrNull(pos++)) {
                            '"' -> sb.append('"'); '\\' -> sb.append('\\'); '/' -> sb.append('/')
                            'b' -> sb.append('\b'); 'f' -> sb.append('\u000C'); 'n' -> sb.append('\n')
                            'r' -> sb.append('\r'); 't' -> sb.append('\t')
                            'u' -> {
                                if (pos + 4 > s.length) throw ParseException("bad escape")
                                sb.append(s.substring(pos, pos + 4).toInt(16).toChar())
                                pos += 4
                            }
                            else -> throw ParseException("bad escape '\\$e'")
                        }
                    }
                    c < ' ' -> throw ParseException("control character in string")
                    else -> sb.append(c)
                }
            }
        }

        private fun num(): Any {
            val start = pos
            if (s[pos] == '-') pos++
            while (pos < s.length && s[pos].isDigit()) pos++
            var integral = true
            if (pos < s.length && s[pos] == '.') { integral = false; pos++; while (pos < s.length && s[pos].isDigit()) pos++ }
            if (pos < s.length && (s[pos] == 'e' || s[pos] == 'E')) {
                integral = false; pos++
                if (pos < s.length && (s[pos] == '+' || s[pos] == '-')) pos++
                while (pos < s.length && s[pos].isDigit()) pos++
            }
            val text = s.substring(start, pos)
            return if (integral) text.toLongOrNull() ?: throw ParseException("integer overflow") else text.toDouble()
        }
    }
}
