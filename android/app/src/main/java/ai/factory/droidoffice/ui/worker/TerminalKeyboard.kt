package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.core.DirectInput
import ai.factory.droidoffice.core.Keys
import android.content.Context
import android.graphics.Rect
import android.text.InputType
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView

/**
 * The native keyboard goes straight to term.input, never through xterm.onData (which also emits
 * terminal-query replies). The WebView remains a read-only renderer and keeps its swipe handling.
 */
internal class TerminalKeyboard(context: Context, private val onInput: (String) -> Unit) : WebView(context) {
    private val ime get() = context.getSystemService(InputMethodManager::class.java)
    private var typing = false
    private var connection: KeyboardConnection? = null
    private var downX = 0f
    private var downY = 0f
    private var dragged = false
    private val slop = ViewConfiguration.get(context).scaledTouchSlop

    fun typeDirectly(enabled: Boolean) {
        if (typing == enabled) return
        typing = enabled
        connection = null
        isFocusable = enabled
        isFocusableInTouchMode = enabled
        if (enabled) {
            openKeyboard()
        } else {
            ime.hideSoftInputFromWindow(windowToken, 0)
            clearFocus()
        }
    }

    private fun openKeyboard() {
        if (!typing) return
        requestFocus()
        post { if (typing && hasFocus()) ime.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT) }
    }

    override fun onCheckIsTextEditor(): Boolean = typing

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        if (!typing) return null
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_FLAG_MULTI_LINE
        outAttrs.imeOptions = EditorInfo.IME_ACTION_NONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        outAttrs.initialSelStart = 0
        outAttrs.initialSelEnd = 0
        return KeyboardConnection().also { connection = it }
    }

    override fun onFocusChanged(focused: Boolean, direction: Int, previouslyFocusedRect: Rect?) {
        if (!focused) connection = null
        super.onFocusChanged(focused, direction, previouslyFocusedRect)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x
                downY = event.y
                dragged = false
            }
            MotionEvent.ACTION_MOVE -> if (kotlin.math.abs(event.x - downX) > slop || kotlin.math.abs(event.y - downY) > slop) dragged = true
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_CANCEL -> dragged = true
        }
        val handled = super.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP && !dragged && typing) {
            performClick()
            openKeyboard()
        }
        return handled
    }

    override fun performClick(): Boolean = super.performClick()

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (!typing || !hasFocus()) return super.dispatchKeyEvent(event)
        val bytes = keyBytes(event) ?: return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN) {
            connection?.input?.finish()
            onInput(bytes)
        }
        return true
    }

    private fun keyBytes(event: KeyEvent): String? {
        val special = when (event.keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> Keys.ENTER
            KeyEvent.KEYCODE_DEL -> Keys.BACKSPACE
            KeyEvent.KEYCODE_FORWARD_DEL -> "\u001b[3~"
            KeyEvent.KEYCODE_ESCAPE -> Keys.ESC
            KeyEvent.KEYCODE_TAB -> if (event.isShiftPressed) Keys.SHIFT_TAB else Keys.TAB
            KeyEvent.KEYCODE_DPAD_UP -> if (event.isAltPressed) Keys.OPT_UP else Keys.UP
            KeyEvent.KEYCODE_DPAD_DOWN -> if (event.isAltPressed) Keys.OPT_DOWN else Keys.DOWN
            KeyEvent.KEYCODE_DPAD_LEFT -> Keys.LEFT
            KeyEvent.KEYCODE_DPAD_RIGHT -> Keys.RIGHT
            KeyEvent.KEYCODE_MOVE_HOME -> "\u001b[H"
            KeyEvent.KEYCODE_MOVE_END -> "\u001b[F"
            KeyEvent.KEYCODE_PAGE_UP -> "\u001b[5~"
            KeyEvent.KEYCODE_PAGE_DOWN -> "\u001b[6~"
            else -> null
        }
        if (special != null) return special
        val code = event.getUnicodeChar(event.metaState and KeyEvent.META_CTRL_MASK.inv() and KeyEvent.META_ALT_MASK.inv())
        if (code == 0 || code and Int.MIN_VALUE != 0) return null
        val text = if (event.isCtrlPressed && code in 32..126) {
            if (code == 63) Keys.BACKSPACE else (code and 31).toChar().toString()
        } else String(Character.toChars(code))
        return (if (event.isAltPressed) Keys.ESC else "") + text
    }

    private inner class KeyboardConnection : BaseInputConnection(this@TerminalKeyboard, false) {
        val input = DirectInput()
        private val active get() = typing && hasFocus() && connection === this

        private fun send(bytes: () -> String): Boolean {
            if (!active) return false
            bytes().takeIf { it.isNotEmpty() }?.let(onInput)
            return true
        }

        override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean = send { input.commit(text?.toString().orEmpty()) }
        override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean = send { input.compose(text?.toString().orEmpty()) }
        override fun finishComposingText(): Boolean {
            input.finish()
            return true
        }
        override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean = send { input.delete(beforeLength, afterLength) }
        override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean = send { input.delete(beforeLength, afterLength, codePoints = true) }
        override fun getTextBeforeCursor(n: Int, flags: Int): CharSequence = input.composing.takeLast(n.coerceAtLeast(0))
        override fun getTextAfterCursor(n: Int, flags: Int): CharSequence = ""
        override fun getSelectedText(flags: Int): CharSequence = ""
        override fun getCursorCapsMode(reqModes: Int): Int = 0
        override fun performEditorAction(actionCode: Int): Boolean = send { input.finish(); Keys.ENTER }
        override fun sendKeyEvent(event: KeyEvent): Boolean = active && dispatchKeyEvent(event)
        override fun closeConnection() {
            if (connection === this) connection = null
            input.finish()
            super.closeConnection()
        }
    }
}
