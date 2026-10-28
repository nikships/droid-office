package ai.factory.droidoffice.rn

import ai.factory.droidoffice.R
import ai.factory.droidoffice.core.Keys
import ai.factory.droidoffice.core.QuickKey
import ai.factory.droidoffice.ui.theme.Palette
import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.compose.ui.graphics.toArgb
import androidx.core.content.res.ResourcesCompat

/**
 * The quick keys under a worker's terminal: keys a phone keyboard lacks (Esc, Ctrl, arrows, Tab),
 * in the owner's saved order, plus a key that opens the keyboard. A key never takes focus from the
 * terminal on a tap, so the open keyboard stays put; a hardware keyboard can still reach each one.
 */
internal class QuickKeyBar(context: Context, private val onKey: (QuickKey) -> Unit, private val onKeyboard: () -> Unit) :
    HorizontalScrollView(context) {
    private val row = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(10), dp(8), dp(10), dp(8))
    }
    private val mono = ResourcesCompat.getFont(context, R.font.geist_mono)
    private var shown: List<QuickKey>? = null
    private var on = false

    init {
        isHorizontalScrollBarEnabled = false
        setBackgroundColor(Palette.Surface.toArgb())
        contentDescription = "Quick keys"
        addView(row, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.MATCH_PARENT))
    }

    fun show(keys: List<QuickKey>) {
        if (keys == shown) return
        shown = keys
        row.removeAllViews()
        row.addView(key("⌨", "Show the keyboard", accent = false) { onKeyboard() })
        keys.forEach { k -> row.addView(key(k.label, k.spoken, accent = k.bytes == Keys.ENTER) { onKey(k) }) }
        enable(on)
    }

    /** Keys only work while the terminal can type; otherwise they read as unavailable. */
    fun enable(enabled: Boolean) {
        on = enabled
        for (i in 0 until row.childCount) {
            val v = row.getChildAt(i)
            v.isEnabled = enabled
            v.alpha = if (enabled) 1f else 0.45f
        }
    }

    private fun key(label: String, spoken: String, accent: Boolean, onClick: () -> Unit): View = TextView(context).apply {
        text = label
        typeface = mono
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        setTextColor((if (accent) Palette.Accent else Palette.Text).toArgb())
        gravity = Gravity.CENTER
        minWidth = dp(40)
        setPadding(dp(10), 0, dp(10), 0)
        background = GradientDrawable().apply {
            cornerRadius = dp(7).toFloat()
            setColor((if (accent) Palette.AccentMuted else Palette.SurfaceRaised).toArgb())
            setStroke(dp(1), (if (accent) Palette.Accent.copy(alpha = 0.5f) else Palette.BorderStrong).toArgb())
        }
        contentDescription = spoken
        isFocusable = true
        isFocusableInTouchMode = false
        accessibilityDelegate = object : AccessibilityDelegate() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                info.className = "android.widget.Button"
            }
        }
        setOnClickListener {
            it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            onClick()
        }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(34)).apply { marginEnd = dp(6) }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        const val HEIGHT_DP = 50
    }
}
