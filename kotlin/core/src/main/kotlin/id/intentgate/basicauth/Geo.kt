package id.intentgate.basicauth

import kotlin.math.roundToLong

object Geo {
    /** Degrees → integer degrees × 10^7, rounded half up like JavaScript's Math.round. */
    fun toE7(degrees: Double): Long = Math.floor(degrees * 1e7 + 0.5).roundToLong()
}
