package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class KittyProtocolTest {
    @Test
    fun legacyModeUsesCsiEnterOnlyForDroidAgents() {
        assertEquals("\u001b[13;5u", KittyKeys.encodeKey(KittyKeyKind.Enter, flags = 0, ctrl = true, csiEnter = true))
        assertEquals("\u001b[13;2u", KittyKeys.encodeKey(KittyKeyKind.Enter, flags = 0, shift = true, csiEnter = true))
        assertEquals("", KittyKeys.encodeKey(KittyKeyKind.Enter, flags = 0, ctrl = true, eventType = KittyEventType.Release, csiEnter = true))
        assertNull(KittyKeys.encodeKey(KittyKeyKind.Enter, flags = 0, ctrl = true, csiEnter = false))
        assertNull(KittyKeys.encodeKey(KittyKeyKind.Escape, flags = 0, csiEnter = true))
    }

    @Test
    fun disambiguateFlagEncodesEscapeAndModifiedKeys() {
        val f1 = KittyKeys.DISAMBIGUATE
        assertEquals("\u001b[27u", KittyKeys.encodeKey(KittyKeyKind.Escape, flags = f1))
        assertEquals("\r", KittyKeys.encodeKey(KittyKeyKind.Enter, flags = f1))
        assertEquals("\u001b[13;2u", KittyKeys.encodeKey(KittyKeyKind.Enter, flags = f1, shift = true))
        assertEquals("\u001b[13;5u", KittyKeys.encodeKey(KittyKeyKind.Enter, flags = f1, ctrl = true))
        assertEquals("\t", KittyKeys.encodeKey(KittyKeyKind.Tab, flags = f1))
        assertEquals("\u001b[9;2u", KittyKeys.encodeKey(KittyKeyKind.Tab, flags = f1, shift = true))
        assertEquals("\u007f", KittyKeys.encodeKey(KittyKeyKind.Backspace, flags = f1))
        assertEquals("\u001b[127;3u", KittyKeys.encodeKey(KittyKeyKind.Backspace, flags = f1, alt = true))
        assertEquals("\u001b[1;3A", KittyKeys.encodeKey(KittyKeyKind.Up, flags = f1, alt = true))
        assertEquals("\u001b[3;5~", KittyKeys.encodeKey(KittyKeyKind.Delete, flags = f1, ctrl = true))
        assertEquals("a", KittyKeys.encodeKey(KittyKeyKind.Character, flags = f1, baseCodePoint = 'a'.code, shiftedCodePoint = 'a'.code))
        assertEquals("\u001b[97;5u", KittyKeys.encodeKey(KittyKeyKind.Character, flags = f1, ctrl = true, baseCodePoint = 'a'.code))
        assertEquals("", KittyKeys.encodeKey(KittyKeyKind.Escape, flags = f1, eventType = KittyEventType.Release))
    }

    @Test
    fun fullEnhancementFlagsReportEventsShiftedCodePointsAndText() {
        val full = KittyKeys.ALL_FLAGS
        assertEquals("\u001b[13u", KittyKeys.encodeKey(KittyKeyKind.Enter, flags = full))
        assertEquals(
            "\u001b[97:65;2;65u",
            KittyKeys.encodeKey(KittyKeyKind.Character, flags = full, shift = true, baseCodePoint = 'a'.code, shiftedCodePoint = 'A'.code),
        )
        assertEquals(
            "\u001b[97;1:2;97u",
            KittyKeys.encodeKey(KittyKeyKind.Character, flags = full, eventType = KittyEventType.Repeat, baseCodePoint = 'a'.code),
        )
        assertEquals(
            "\u001b[97;1:3u",
            KittyKeys.encodeKey(KittyKeyKind.Character, flags = full, eventType = KittyEventType.Release, baseCodePoint = 'a'.code),
        )
        assertEquals("\u001b[104;1;104u\u001b[105;1;105u", KittyKeys.encodeCommittedText("hi", full))
    }

    @Test
    fun quickKeysAdaptWhenKittyKeyboardIsActive() {
        val esc = QuickKeys.all.single { it.id == "escape" }
        val shiftTab = QuickKeys.all.single { it.id == "shift_tab" }
        val ctrlX = QuickKeys.all.single { it.id == "control_x" }
        assertEquals(Keys.ESC, QuickKeys.bytes(esc, flags = 0))
        assertEquals("\u001b[27u", QuickKeys.bytes(esc, flags = 1))
        assertEquals("\u001b[9;2u", QuickKeys.bytes(shiftTab, flags = 1))
        assertEquals("\u001b[120;5u", QuickKeys.bytes(ctrlX, flags = 1))
    }

    @Test
    fun stripsUnicodeImagePlaceholdersAndDiacritics() {
        val placeholder = "\uDBFB\uDEEE\u0305\u030D"
        assertEquals("before  after", KittyKeys.stripPlaceholders("before $placeholder$placeholder after"))
    }
}
