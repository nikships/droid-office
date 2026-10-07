package ai.factory.droidoffice.core

import java.net.InetAddress
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RoutesTest {
    @Test
    fun tellsRoutesApart() {
        assertEquals(RouteKind.Lan, Routes.kindOf("http://192.168.0.148:4600"))
        assertEquals(RouteKind.Lan, Routes.kindOf("http://10.0.2.2:4720"))
        assertEquals(RouteKind.Lan, Routes.kindOf("http://172.20.1.4:4600"))
        assertEquals(RouteKind.Lan, Routes.kindOf("http://my-mac.local:4600"))
        assertEquals(RouteKind.Lan, Routes.kindOf("http://my-mac:4600"))
        assertEquals(RouteKind.Tailscale, Routes.kindOf("http://100.96.217.59:4600"))
        assertEquals(RouteKind.Tailscale, Routes.kindOf("https://niks-mac.tail1234.ts.net"))
        assertEquals(RouteKind.Tailscale, Routes.kindOf("http://[fd7a:115c:a1e0::1]:4600"))
        assertEquals(RouteKind.Remote, Routes.kindOf("https://office.example.com"))
        assertEquals(RouteKind.Remote, Routes.kindOf("http://8.8.8.8:4600"))
        // 100.x outside 100.64.0.0/10 isn't Tailscale.
        assertEquals(RouteKind.Remote, Routes.kindOf("http://100.200.1.1:4600"))
    }

    @Test
    fun cleartextOnlyToPrivateAddresses() {
        assertTrue(Routes.isPrivate(InetAddress.getByName("127.0.0.1")))
        assertTrue(Routes.isPrivate(InetAddress.getByName("192.168.1.2")))
        assertTrue(Routes.isPrivate(InetAddress.getByName("100.100.1.1")))
        assertTrue(Routes.isPrivate(InetAddress.getByName("fd7a:115c:a1e0::1")))
        assertTrue(Routes.isPrivate(InetAddress.getByName("fe80::1")))
        assertFalse(Routes.isPrivate(InetAddress.getByName("8.8.8.8")))
        assertFalse(Routes.isPrivate(InetAddress.getByName("2001:4860:4860::8888")))
    }

    @Test
    fun parsesOnlyDottedQuads() {
        assertEquals(null, Routes.parseIpv4("1.2.3"))
        assertEquals(null, Routes.parseIpv4("1.2.3.256"))
        assertEquals(null, Routes.parseIpv4("a.b.c.d"))
        assertEquals(4, Routes.parseIpv4("10.0.0.1")?.size)
    }
}

class RouteRacerTest {
    private val lan = "http://192.168.0.2:4600"
    private val ts = "http://100.96.0.2:4600"
    private val dns = "http://mac.tail1.ts.net:4600"

    @Test
    fun waitsBrieflyForWifiWhenTailscaleAnswersFirst() = runTest {
        val r = RouteRacer(graceMs = 600).race(listOf(lan, ts)) { base ->
            if (base == ts) delay(10) else delay(300)
            Probe.Ok("Office")
        }
        assertEquals(lan, (r as RaceResult.Winner).base)
        assertEquals(RouteKind.Lan, r.kind)
    }

    @Test
    fun settlesOnTailscaleWhenWifiIsTooSlow() = runTest {
        val r = RouteRacer(graceMs = 200).race(listOf(lan, ts)) { base ->
            if (base == ts) delay(10) else delay(3_000)
            Probe.Ok()
        }
        assertEquals(ts, (r as RaceResult.Winner).base)
    }

    @Test
    fun takesWhicheverTailscaleRouteAnswers() = runTest {
        val r = RouteRacer().race(listOf(lan, dns, ts)) { base ->
            when (base) {
                lan -> Probe.Failed("unreachable")
                dns -> { delay(50); Probe.Ok() }
                else -> { delay(5); Probe.Ok() }
            }
        }
        assertEquals(ts, (r as RaceResult.Winner).base)
    }

    @Test
    fun reportsARefusalWhenNothingLetsItIn() = runTest {
        val r = RouteRacer().race(listOf(lan, ts)) { base -> if (base == lan) Probe.Unauthorized else Probe.Failed("timeout") }
        assertEquals(RaceResult.Unauthorized(lan), r)
    }

    @Test
    fun timesOutAndCatchesErrors() = runTest {
        val r = RouteRacer(timeoutMs = 100).race(listOf(lan, ts)) { base ->
            if (base == lan) {
                delay(10_000)
                Probe.Ok()
            } else error("boom")
        }
        r as RaceResult.AllFailed
        assertEquals("timed out", r.reasons[lan])
        assertEquals("boom", r.reasons[ts])
    }

    @Test
    fun backoffDoublesUpToItsCap() {
        val b = Backoff(baseMs = 1_000, maxMs = 8_000, jitter = 0.0)
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 8_000L), List(5) { b.next() })
        b.reset()
        assertEquals(1_000L, b.next())
    }
}
