package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Test

class DirectInputTest {
    @Test
    fun sendsCommittedCharactersAndEnterImmediately() {
        val input = DirectInput()
        assertEquals("a", input.commit("a"))
        assertEquals("b", input.commit("b"))
        assertEquals("\r", input.commit("\n"))
        assertEquals("\r", input.commit("\r\n"))
        assertEquals("\r", input.commit("\r"))
        assertEquals("one\rtwo", input.commit("one\ntwo"))
        assertEquals("", input.composing)
    }

    @Test
    fun composingLettersAreLiveAndCommittingDoesNotRepeatThem() {
        val input = DirectInput()
        assertEquals("h", input.compose("h"))
        assertEquals("e", input.compose("he"))
        assertEquals("llo", input.compose("hello"))
        assertEquals("", input.commit("hello"))
        assertEquals(" ", input.commit(" "))
        assertEquals("w", input.compose("w"))
    }

    @Test
    fun replacesOnlyTheChangedSuffixOfAComposingWord() {
        val input = DirectInput()
        assertEquals("teh", input.compose("teh"))
        assertEquals("\u007f\u007fhe", input.compose("the"))
        assertEquals("\u007f", input.compose("th"))
        assertEquals("ere ", input.commit("there "))
    }

    @Test
    fun finishingOrLosingTheInputSessionDoesNotRetypeAnything() {
        val input = DirectInput()
        input.compose("hi")
        input.finish()
        assertEquals("", input.composing)
        assertEquals("!", input.commit("!"))
        input.compose("x")
        assertEquals("\u007f", input.commit(""))
    }

    @Test
    fun deletesEvenWhenTheImeHasNoLocalText() {
        val input = DirectInput()
        assertEquals("\u007f", input.delete(1, 0))
        assertEquals("\u007f\u007f\u001b[3~", input.delete(2, 1))
        assertEquals("", input.delete(-1, 0))
        assertEquals("", input.delete(0, -1))
        input.compose("abc")
        assertEquals("\u007f", input.delete(1, 0))
        assertEquals("ab", input.composing)
        assertEquals("", input.commit("ab"))
    }

    @Test
    fun revisionsAndDeletesDoNotSplitSurrogatePairs() {
        val input = DirectInput()
        assertEquals("a😀", input.compose("a😀"))
        assertEquals("\u007f😃", input.compose("a😃"))
        assertEquals("\u007f", input.delete(2, 0))
        assertEquals("a", input.composing)
        input.compose("a😀")
        assertEquals("\u007f", input.delete(1, 0, codePoints = true))
        assertEquals("a", input.composing)
        input.compose("a😀")
        assertEquals("\u007f", input.delete(1, 0))
        assertEquals("a", input.composing)
        input.compose("😀")
        assertEquals("\u007f\u007f", input.delete(2, 0, codePoints = true))
        assertEquals("", input.composing)
    }
}
