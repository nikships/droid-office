package ai.factory.droidoffice.core

enum class KittyKeyKind {
    Enter,
    NumpadEnter,
    Tab,
    Backspace,
    Delete,
    Insert,
    Escape,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
    Character,
}

enum class KittyEventType(val wire: Int) {
    Press(1),
    Repeat(2),
    Release(3),
}

/**
 * Pure JVM Kitty keyboard (`CSI u`) encoder and `U+10EEEE` placeholder stripper for Android's
 * direct terminal keyboard, quick keys and TalkBack screen text (`src/shared/kitty.ts` parity).
 */
object KittyKeys {
    const val DISAMBIGUATE = 1
    const val REPORT_EVENTS = 2
    const val REPORT_ALTERNATE = 4
    const val REPORT_ALL = 8
    const val REPORT_TEXT = 16
    const val ALL_FLAGS = 31

    private const val PLACEHOLDER_CP = 0x10EEEE
    private const val CTRL_ENTER = "\u001b[13;5u"
    private const val SHIFT_ENTER = "\u001b[13;2u"

    /** Exact 297-entry combining diacritic table from Kitty's `rowcolumn-diacritics.txt` (matches `src/shared/kitty.ts`). */
    private val KITTY_DIACRITIC_SET: Set<Int> = intArrayOf(
        773, 781, 782, 784, 786, 829, 830, 831, 838, 842, 843, 844, 848, 849, 850, 855, 859, 867, 868, 869, 870, 871, 872, 873, 874, 875, 876, 877, 878, 879,
        1155, 1156, 1157, 1158, 1159, 1426, 1427, 1428, 1429, 1431, 1432, 1433, 1436, 1437, 1438, 1439, 1440, 1441, 1448, 1449, 1451, 1452, 1455, 1476,
        1552, 1553, 1554, 1555, 1556, 1557, 1558, 1559, 1623, 1624, 1625, 1626, 1627, 1629, 1630, 1750, 1751, 1752, 1753, 1754, 1755, 1756, 1759, 1760,
        1761, 1762, 1764, 1767, 1768, 1771, 1772, 1840, 1842, 1843, 1845, 1846, 1850, 1853, 1855, 1856, 1857, 1859, 1861, 1863, 1865, 1866,
        2027, 2028, 2029, 2030, 2031, 2032, 2033, 2035, 2070, 2071, 2072, 2073, 2075, 2076, 2077, 2078, 2079, 2080, 2081, 2082, 2083, 2085, 2086, 2087, 2089, 2090, 2091, 2092, 2093,
        2385, 2387, 2388, 3970, 3971, 3974, 3975, 4957, 4958, 4959, 6109, 6458, 6679, 6773, 6774, 6775, 6776, 6777, 6778, 6779, 6780,
        7019, 7021, 7022, 7023, 7024, 7025, 7026, 7027, 7376, 7377, 7378, 7386, 7387, 7392,
        7616, 7617, 7619, 7620, 7621, 7622, 7623, 7624, 7625, 7627, 7628, 7633, 7634, 7635, 7636, 7637, 7638, 7639, 7640, 7641, 7642, 7643, 7644, 7645, 7646, 7647, 7648, 7649, 7650, 7651, 7652, 7653, 7654, 7678,
        8400, 8401, 8404, 8405, 8406, 8407, 8411, 8412, 8417, 8423, 8425, 8432, 11503, 11504, 11505,
        11744, 11745, 11746, 11747, 11748, 11749, 11750, 11751, 11752, 11753, 11754, 11755, 11756, 11757, 11758, 11759, 11760, 11761, 11762, 11763, 11764, 11765, 11766, 11767, 11768, 11769, 11770, 11771, 11772, 11773, 11774, 11775,
        42607, 42620, 42621, 42736, 42737, 43232, 43233, 43234, 43235, 43236, 43237, 43238, 43239, 43240, 43241, 43242, 43243, 43244, 43245, 43246, 43247, 43248, 43249,
        43696, 43698, 43699, 43703, 43704, 43710, 43711, 43713, 65056, 65057, 65058, 65059, 65060, 65061, 65062, 68111, 68152,
        119173, 119174, 119175, 119176, 119177, 119210, 119211, 119212, 119213, 119362, 119363, 119364,
    ).toSet()

    private fun isPlaceholderDiacritic(cp: Int): Boolean =
        cp in KITTY_DIACRITIC_SET ||
            cp in 0x0300..0x036F ||
            cp in 0x1AB0..0x1AFF ||
            cp in 0x1DC0..0x1DFF ||
            cp in 0x20D0..0x20FF ||
            cp in 0xFE20..0xFE2F

    private fun formatCsiU(codePoint: Int, shifted: Int?, mod: Int, eventType: Int, textCp: Int?): String {
        val keyPart = if (shifted != null && shifted != codePoint && shifted > 0) "$codePoint:$shifted" else "$codePoint"
        val evSuffix = if (eventType > 1) ":$eventType" else ""
        val hasText = textCp != null && textCp >= 32 && textCp != 127
        if (mod == 1 && evSuffix.isEmpty() && !hasText) return "\u001b[${keyPart}u"
        val modPart = "$mod$evSuffix"
        return if (!hasText) "\u001b[$keyPart;${modPart}u" else "\u001b[$keyPart;$modPart;${textCp}u"
    }

    /**
     * Encodes a key event under negotiated Kitty `flags` (or fallback `csiEnter` when `flags == 0`).
     * Returns `null` when `flags == 0` and legacy encoding should run, or `""` when the event should be swallowed.
     */
    fun encodeKey(
        kind: KittyKeyKind,
        flags: Int,
        shift: Boolean = false,
        alt: Boolean = false,
        ctrl: Boolean = false,
        eventType: KittyEventType = KittyEventType.Press,
        baseCodePoint: Int = 0,
        shiftedCodePoint: Int = 0,
        csiEnter: Boolean = false,
    ): String? {
        val f = flags and ALL_FLAGS
        if (f == 0) {
            if (!csiEnter || (kind != KittyKeyKind.Enter && kind != KittyKeyKind.NumpadEnter) || alt) return null
            val seq = when {
                ctrl && !shift -> CTRL_ENTER
                shift && !ctrl -> SHIFT_ENTER
                else -> return null
            }
            return if (eventType == KittyEventType.Release) "" else seq
        }

        val reportEvents = (f and REPORT_EVENTS) != 0
        val reportAlt = (f and REPORT_ALTERNATE) != 0
        val reportAll = (f and REPORT_ALL) != 0
        val reportText = (f and REPORT_TEXT) != 0

        if (eventType == KittyEventType.Release && !reportEvents) return ""
        val wireEvent = when (eventType) {
            KittyEventType.Release -> 3
            KittyEventType.Repeat -> if (reportEvents) 2 else 1
            KittyEventType.Press -> 1
        }
        val mod = 1 + (if (shift) 1 else 0) + (if (alt) 2 else 0) + (if (ctrl) 4 else 0)
        val evSuffix = if (wireEvent > 1) ":$wireEvent" else ""

        // 1. Letter-terminated CSI keys (arrows, Home/End, F1..F4).
        val letterFinal = when (kind) {
            KittyKeyKind.Up -> 'A'
            KittyKeyKind.Down -> 'B'
            KittyKeyKind.Right -> 'C'
            KittyKeyKind.Left -> 'D'
            KittyKeyKind.Home -> 'H'
            KittyKeyKind.End -> 'F'
            KittyKeyKind.F1 -> 'P'
            KittyKeyKind.F2 -> 'Q'
            KittyKeyKind.F3 -> 'R'
            KittyKeyKind.F4 -> 'S'
            else -> null
        }
        if (letterFinal != null) {
            if (mod == 1 && wireEvent == 1) {
                val prefix = if (kind == KittyKeyKind.F1 || kind == KittyKeyKind.F2 || kind == KittyKeyKind.F3 || kind == KittyKeyKind.F4) "\u001bO" else "\u001b["
                return "$prefix$letterFinal"
            }
            return "\u001b[1;$mod$evSuffix$letterFinal"
        }

        // 2. Tilde-terminated CSI keys (Insert, Delete, PageUp, PageDown, F5..F12).
        val tildeNum = when (kind) {
            KittyKeyKind.Insert -> 2
            KittyKeyKind.Delete -> 3
            KittyKeyKind.PageUp -> 5
            KittyKeyKind.PageDown -> 6
            KittyKeyKind.F5 -> 15
            KittyKeyKind.F6 -> 17
            KittyKeyKind.F7 -> 18
            KittyKeyKind.F8 -> 19
            KittyKeyKind.F9 -> 20
            KittyKeyKind.F10 -> 21
            KittyKeyKind.F11 -> 23
            KittyKeyKind.F12 -> 24
            else -> null
        }
        if (tildeNum != null) {
            return if (mod == 1 && evSuffix.isEmpty()) "\u001b[${tildeNum}~" else "\u001b[$tildeNum;$mod$evSuffix~"
        }

        // 3. Functional CSI u keys (Escape, Enter, Tab, Backspace, NumpadEnter).
        val funcCode = when (kind) {
            KittyKeyKind.Escape -> 27
            KittyKeyKind.Enter -> 13
            KittyKeyKind.NumpadEnter -> 57414
            KittyKeyKind.Tab -> 9
            KittyKeyKind.Backspace -> 127
            else -> null
        }
        if (funcCode != null) {
            if (!reportAll && mod == 1 && wireEvent == 1) {
                when (funcCode) {
                    13 -> return Keys.ENTER
                    9 -> return Keys.TAB
                    127 -> return Keys.BACKSPACE
                }
            }
            return formatCsiU(funcCode, null, mod, wireEvent, null)
        }

        // 4. Character keys.
        if (kind == KittyKeyKind.Character && baseCodePoint > 0) {
            val lowerCp = Character.toLowerCase(baseCodePoint)
            val actualCp = if (shiftedCodePoint > 0) shiftedCodePoint else baseCodePoint
            val isModifiedSpace = lowerCp == 32 && mod > 1
            if (!reportAll && !ctrl && !alt && !isModifiedSpace && wireEvent == 1) {
                return String(Character.toChars(actualCp))
            }
            val shifted = if (reportAlt && shift && actualCp != lowerCp) actualCp else null
            val textCp = if (reportText && wireEvent != 3 && !ctrl && !alt) actualCp else null
            return formatCsiU(lowerCp, shifted, mod, wireEvent, textCp)
        }

        return null
    }

    /** Adapts a QuickKey's bytes to negotiated Kitty keyboard `flags` when active. */
    fun encodeQuickKey(bytes: String, flags: Int): String {
        val f = flags and ALL_FLAGS
        if (f == 0) return bytes
        val reportAll = (f and REPORT_ALL) != 0
        return when (bytes) {
            Keys.ESC -> "\u001b[27u"
            Keys.CTRL_C -> "\u001b[99;5u"
            Keys.CTRL_D -> "\u001b[100;5u"
            Keys.CTRL_X -> "\u001b[120;5u"
            Keys.SHIFT_TAB -> "\u001b[9;2u"
            Keys.OPT_UP -> "\u001b[1;3A"
            Keys.OPT_DOWN -> "\u001b[1;3B"
            Keys.ENTER -> if (reportAll) "\u001b[13u" else Keys.ENTER
            Keys.TAB -> if (reportAll) "\u001b[9u" else Keys.TAB
            Keys.BACKSPACE -> if (reportAll) "\u001b[127u" else Keys.BACKSPACE
            "/" -> if (reportAll) "\u001b[47u" else "/"
            else -> bytes
        }
    }

    /** Encodes IME committed text when `REPORT_ALL` (`flag 8`) is negotiated; passes UTF-8 through otherwise. */
    fun encodeCommittedText(text: String, flags: Int): String {
        val f = flags and ALL_FLAGS
        if ((f and REPORT_ALL) == 0 || text.isEmpty()) return text
        val reportText = (f and REPORT_TEXT) != 0
        val out = StringBuilder()
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            i += Character.charCount(cp)
            when (cp) {
                10, 13 -> out.append(formatCsiU(13, null, 1, 1, if (reportText) 13 else null))
                9 -> out.append(formatCsiU(9, null, 1, 1, null))
                127, 8 -> out.append(formatCsiU(127, null, 1, 1, null))
                else -> {
                    val lower = Character.toLowerCase(cp)
                    val isShifted = cp != lower && Character.isUpperCase(cp)
                    val mod = if (isShifted) 2 else 1
                    val shifted = if ((f and REPORT_ALTERNATE) != 0 && isShifted) cp else null
                    out.append(formatCsiU(lower, shifted, mod, 1, if (reportText) cp else null))
                }
            }
        }
        return out.toString()
    }

    /** Strips Kitty `U+10EEEE` placeholder cells and their combining row/col diacritics from plain text. */
    fun stripPlaceholders(text: String): String {
        if (!text.contains("\uDBFB\uDEEE")) return text
        val out = StringBuilder(text.length)
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            i += Character.charCount(cp)
            if (cp == PLACEHOLDER_CP) {
                while (i < text.length) {
                    val next = text.codePointAt(i)
                    if (isPlaceholderDiacritic(next)) {
                        i += Character.charCount(next)
                    } else {
                        break
                    }
                }
            } else {
                out.appendCodePoint(cp)
            }
        }
        return out.toString()
    }
}
