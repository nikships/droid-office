package ai.factory.droidoffice.core

/**
 * The effort dial beside a worker's model: a half-circle gauge that sweeps a fifth further for each
 * step from Low to Max, white at Low to Factory orange at Max in even OKLab steps. Kept in step with
 * src/shared/effort-dial.ts; tests/effort-dial.test.ts compares the colours and names.
 */
object EffortDial {
    /** ARGB, one per level. */
    val colors: Map<Effort, Long> = mapOf(
        Effort.Low to 0xFFFFFFFF,
        Effort.Medium to 0xFFFFDACB,
        Effort.High to 0xFFFDB497,
        Effort.XHigh to 0xFFF78C61,
        Effort.Max to 0xFFEE6018,
    )

    /** The web's names (EFFORT_LABEL in src/client/ui/effort-label.ts), for what TalkBack says. */
    private val names = mapOf(
        Effort.Low to "Low",
        Effort.Medium to "Medium",
        Effort.High to "High",
        Effort.XHigh to "Extra high",
        Effort.Max to "Max",
    )

    /** How far round the dial it sits: 0.2 for Low to 1 for Max. */
    fun fraction(e: Effort): Float = (e.ordinal + 1) / Effort.entries.size.toFloat()

    fun label(e: Effort): String = "${names.getValue(e)} effort"
}
