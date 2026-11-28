@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.core.DirectInput
import ai.factory.droidoffice.core.Keys
import ai.factory.droidoffice.core.KittyEventType
import ai.factory.droidoffice.core.KittyKeyKind
import ai.factory.droidoffice.core.KittyKeys
import platform.CoreGraphics.CGRectMake
import platform.UIKit.*
import platform.darwin.NSObject

/** A real UIKit text input behind the renderer, not the renderer's keyboard/output stream.
 * Keep only the in-progress IME word. Dictation, paste and marked-text replacements share the
 * normal UITextInput path; hardware special keys use the same Kitty encoder as the APK. */
internal class TerminalInput(private val send: (String) -> Unit) : UITextView(CGRectMake(0.0, 0.0, 1.0, 1.0), null) {
    private val input = DirectInput()
    private val pressed = mutableSetOf<Long>()
    // UITextView.delegate is weak. This view owns its delegate; the delegate does not own the view.
    private val textChanges = TextChanges()
    private var enabled = false
    private val active get() = enabled && window?.keyWindow == true && isFirstResponder
    var kittyFlags = 0
    var csiEnter = false

    init {
        delegate = textChanges
        backgroundColor = UIColor.clearColor
        textColor = UIColor.clearColor
        tintColor = UIColor.clearColor
        autocapitalizationType = UITextAutocapitalizationType.UITextAutocapitalizationTypeNone
        autocorrectionType = UITextAutocorrectionType.UITextAutocorrectionTypeNo
        spellCheckingType = UITextSpellCheckingType.UITextSpellCheckingTypeNo
        smartDashesType = UITextSmartDashesType.UITextSmartDashesTypeNo
        smartQuotesType = UITextSmartQuotesType.UITextSmartQuotesTypeNo
        smartInsertDeleteType = UITextSmartInsertDeleteType.UITextSmartInsertDeleteTypeNo
    }

    fun typeDirectly(value: Boolean) {
        if (enabled == value) return
        enabled = value
        if (value) open() else {
            resignFirstResponder()
            clearWord()
            pressed.clear()
        }
    }

    fun open() { if (enabled && window != null && !isFirstResponder) becomeFirstResponder() }

    override fun didMoveToWindow() {
        super.didMoveToWindow()
        if (window != null) open() else { pressed.clear(); clearWord() }
    }

    private fun clearWord() {
        input.finish()
        if (text.isNotEmpty()) text = ""
    }

    override fun hasText(): Boolean = enabled || super.hasText()

    override fun deleteBackward() {
        if (!active) return
        if (markedTextRange != null) super.deleteBackward() else send(KittyKeys.encodeQuickKey(Keys.BACKSPACE, kittyFlags))
    }

    private class TextChanges : NSObject(), UITextViewDelegateProtocol {
        override fun textViewDidChange(textView: UITextView) { (textView as? TerminalInput)?.changed() }
    }

    private fun changed() {
        if (!active) return
        val bytes = if (markedTextRange != null) input.compose(text) else {
            val raw = text.replace("\r\n", "\n")
            val committed = if (input.composing.isEmpty() && kittyFlags and KittyKeys.REPORT_ALL != 0) {
                KittyKeys.encodeCommittedText(raw, kittyFlags)
            } else input.commit(raw)
            clearWord()
            committed
        }
        if (bytes.isNotEmpty()) send(bytes)
    }

    override fun unmarkText() {
        super.unmarkText()
        // Dropping the marked range without changing its text is a commit too.
        if (active && input.composing.isNotEmpty()) changed()
    }

    override fun pressesBegan(presses: Set<*>, withEvent: UIPressesEvent?) {
        val pass = presses.filterNot { press ->
            val key = (press as? UIPress)?.key ?: return@filterNot false
            val type = if (key.keyCode in pressed) KittyEventType.Repeat else KittyEventType.Press
            handle(key, type).also { if (it) pressed.add(key.keyCode) }
        }.toSet()
        if (pass.isNotEmpty()) super.pressesBegan(pass, withEvent)
    }

    override fun pressesEnded(presses: Set<*>, withEvent: UIPressesEvent?) {
        val pass = presses.filterNot { press ->
            val key = (press as? UIPress)?.key ?: return@filterNot false
            pressed.remove(key.keyCode).also { if (it) handle(key, KittyEventType.Release) }
        }.toSet()
        if (pass.isNotEmpty()) super.pressesEnded(pass, withEvent)
    }

    override fun pressesCancelled(presses: Set<*>, withEvent: UIPressesEvent?) {
        presses.filterIsInstance<UIPress>().forEach { it.key?.keyCode?.let(pressed::remove) }
        super.pressesCancelled(presses, withEvent)
    }

    private fun handle(key: UIKey, type: KittyEventType): Boolean {
        if (!active || key.modifierFlags and UIKeyModifierCommand != 0L || markedTextRange != null) return false
        val shift = key.modifierFlags and UIKeyModifierShift != 0L
        val alt = key.modifierFlags and UIKeyModifierAlternate != 0L
        val ctrl = key.modifierFlags and UIKeyModifierControl != 0L
        val kind = when (key.keyCode) {
            UIKeyboardHIDUsageKeyboardReturnOrEnter -> KittyKeyKind.Enter
            UIKeyboardHIDUsageKeypadEnter -> KittyKeyKind.NumpadEnter
            UIKeyboardHIDUsageKeyboardTab -> KittyKeyKind.Tab
            UIKeyboardHIDUsageKeyboardEscape -> KittyKeyKind.Escape
            UIKeyboardHIDUsageKeyboardDeleteOrBackspace -> KittyKeyKind.Backspace
            UIKeyboardHIDUsageKeyboardDeleteForward -> KittyKeyKind.Delete
            UIKeyboardHIDUsageKeyboardInsert -> KittyKeyKind.Insert
            UIKeyboardHIDUsageKeyboardUpArrow -> KittyKeyKind.Up
            UIKeyboardHIDUsageKeyboardDownArrow -> KittyKeyKind.Down
            UIKeyboardHIDUsageKeyboardLeftArrow -> KittyKeyKind.Left
            UIKeyboardHIDUsageKeyboardRightArrow -> KittyKeyKind.Right
            UIKeyboardHIDUsageKeyboardHome -> KittyKeyKind.Home
            UIKeyboardHIDUsageKeyboardEnd -> KittyKeyKind.End
            UIKeyboardHIDUsageKeyboardPageUp -> KittyKeyKind.PageUp
            UIKeyboardHIDUsageKeyboardPageDown -> KittyKeyKind.PageDown
            in UIKeyboardHIDUsageKeyboardF1..UIKeyboardHIDUsageKeyboardF12 -> KittyKeyKind.entries[KittyKeyKind.F1.ordinal + (key.keyCode - UIKeyboardHIDUsageKeyboardF1).toInt()]
            else -> KittyKeyKind.Character
        }
        val base = key.charactersIgnoringModifiers.scalar()
        if (kind == KittyKeyKind.Character && (base == null || (!ctrl && !alt && kittyFlags == 0))) return false
        val shifted = if (ctrl || alt) base else key.characters.scalar()
        val bytes = KittyKeys.encodeKey(kind, kittyFlags, shift, alt, ctrl, type, base ?: 0, shifted ?: base ?: 0, csiEnter) ?: when {
            type == KittyEventType.Release -> ""
            kind == KittyKeyKind.Character && base != null -> {
                val ch = if (ctrl && base in 32..126) (if (base == 63) Keys.BACKSPACE else (base and 31).toChar().toString()) else key.charactersIgnoringModifiers
                (if (alt) Keys.ESC else "") + ch
            }
            kind == KittyKeyKind.Escape -> Keys.ESC
            kind == KittyKeyKind.Tab -> if (shift) Keys.SHIFT_TAB else Keys.TAB
            kind == KittyKeyKind.Enter || kind == KittyKeyKind.NumpadEnter -> Keys.ENTER
            kind == KittyKeyKind.Backspace -> Keys.BACKSPACE
            else -> KittyKeys.encodeKey(kind, KittyKeys.DISAMBIGUATE, shift, alt, ctrl) ?: return false
        }
        if (bytes.isNotEmpty()) send(bytes)
        return true
    }
}

private fun String.scalar(): Int? = when {
    length == 1 && !this[0].isSurrogate() -> this[0].code
    length == 2 && this[0].isHighSurrogate() && this[1].isLowSurrogate() -> 0x10000 + ((this[0].code - 0xd800) shl 10) + this[1].code - 0xdc00
    else -> null
}
