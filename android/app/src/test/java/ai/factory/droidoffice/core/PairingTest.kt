package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingTest {
    private fun ok(raw: String) = (Pairing.parse(raw) as InviteParse.Ok).invite
    private fun invalid(raw: String) = (Pairing.parse(raw) as InviteParse.Invalid).reason

    @Test
    fun readsThePayloadWithEveryAddressInOrder() {
        val invite = ok(
            "droidoffice://pair?v=1&name=Nik%27s%20MacBook%20%28Pro%29&t=EQKpRyC1i_DeLm3qG8tOQLmcv27XanhU" +
                "&u=http%3A%2F%2F192.168.0.148%3A4600&u=http%3A%2F%2Fniks-mac.tail1234.ts.net%3A4600&u=http%3A%2F%2F100.96.217.59%3A4600",
        )
        assertEquals("Nik's MacBook (Pro)", invite.name)
        assertEquals("EQKpRyC1i_DeLm3qG8tOQLmcv27XanhU", invite.lanToken)
        assertEquals(listOf("http://192.168.0.148:4600", "http://niks-mac.tail1234.ts.net:4600", "http://100.96.217.59:4600"), invite.bases)
    }

    @Test
    fun readsTheLinkAnOfficeShows() {
        // As GET /api/mobile/pairing returns it: every value encoded, including ’ and ().
        val invite = ok(
            "droidoffice://pair?v=1&name=Nikhil%E2%80%99s%20MacBook%20Pro%20%282%29&t=iJGp-CGV2TlzFD_5XJjMFyyJ0TIua4Z5" +
                "&u=http%3A%2F%2F192.168.0.148%3A4720&u=http%3A%2F%2Fnikhils-macbook-pro-2.tail08b849.ts.net%3A4720&u=http%3A%2F%2F100.96.217.59%3A4720",
        )
        assertEquals("Nikhil’s MacBook Pro (2)", invite.name)
        assertEquals(listOf(RouteKind.Lan, RouteKind.Tailscale, RouteKind.Tailscale), invite.bases.map(Routes::kindOf))
    }

    @Test
    fun normalizesAndDeduplicatesAddresses() {
        val invite = ok("droidoffice://pair?t=abcdefgh123&u=HTTPS%3A%2F%2FOffice.Example%3A443%2Fsome%2Fpath&u=https%3A%2F%2Foffice.example")
        assertEquals(listOf("https://office.example"), invite.bases)
        // No name: the first address stands in for it.
        assertEquals("office.example", invite.name)
    }

    @Test
    fun keepsAnUnencodedSpaceInTheName() {
        assertEquals("My Mac", ok("droidoffice://pair?v=1&name=My Mac&t=abcdefgh123&u=http%3A%2F%2F10.0.0.2%3A4600").name)
    }

    @Test
    fun readsThePrintedJoinUrl() {
        val invite = ok("http://192.168.1.20:4600/?t=EQKpRyC1i_DeLm3qG8tOQLmcv27XanhU")
        assertEquals(listOf("http://192.168.1.20:4600"), invite.bases)
        assertEquals("EQKpRyC1i_DeLm3qG8tOQLmcv27XanhU", invite.lanToken)
    }

    @Test
    fun findsTheLinkInsideAChatMessage() {
        val invite = ok("Join my office: http://192.168.1.20:4600/?t=abcdefgh123. See you there")
        assertEquals("abcdefgh123", invite.lanToken)
    }

    @Test
    fun refusesWhatIsntAnInvite() {
        assertTrue(invalid("hello there").isNotBlank())
        assertTrue(invalid("droidoffice://open?t=abcdefgh123&u=http%3A%2F%2F10.0.0.2").contains("pairing"))
        assertTrue(invalid("droidoffice://pair?u=http%3A%2F%2F10.0.0.2").contains("token"))
        assertTrue(invalid("droidoffice://pair?t=abcdefgh123").contains("address"))
        assertTrue(invalid("droidoffice://pair?t=abcdefgh123&u=ftp%3A%2F%2F10.0.0.2").contains("address"))
        assertTrue(invalid("http://192.168.1.20:4600/").contains("token"))
        assertTrue(invalid("droidoffice://pair?v=2&t=abcdefgh123&u=http%3A%2F%2F10.0.0.2").contains("newer"))
    }

    @Test
    fun refusesATokenWithStrayCharacters() {
        assertTrue(Pairing.parse("droidoffice://pair?t=abc%20def%3Cghi&u=http%3A%2F%2F10.0.0.2") is InviteParse.Invalid)
    }
}
