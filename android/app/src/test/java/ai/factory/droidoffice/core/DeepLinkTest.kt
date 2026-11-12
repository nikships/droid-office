package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeepLinkTest {
    private val tailnetBase = "http://office-mac.tail08b849.ts.net:4600"

    @Test
    fun parsesHttpTailscaleLinksForEveryTarget() {
        assertEquals(
            DeepLink(
                target = DeepLinkTarget.Worker(workerId = "gizmo-c1cb", floorId = "droid-office", view = WorkerLinkView.Tty),
                officeBase = tailnetBase,
            ),
            DeepLinks.parse("$tailnetBase/open/worker/gizmo-c1cb?floor=droid-office"),
        )
        assertEquals(
            DeepLink(
                target = DeepLinkTarget.Worker(workerId = "gizmo-c1cb", floorId = "droid-office", view = WorkerLinkView.Thread),
                officeBase = tailnetBase,
            ),
            DeepLinks.parse("$tailnetBase/open/worker/gizmo-c1cb?floor=droid-office&view=thread"),
        )
        assertEquals(
            DeepLink(target = DeepLinkTarget.Floor(floorId = "droid-office"), officeBase = tailnetBase),
            DeepLinks.parse("$tailnetBase/open/floor/droid-office"),
        )
        assertEquals(
            DeepLink(target = DeepLinkTarget.Card(cardId = "card-9f2a", floorId = "droid-office"), officeBase = tailnetBase),
            DeepLinks.parse("$tailnetBase/open/card/card-9f2a?floor=droid-office"),
        )
        assertEquals(
            DeepLink(
                target = DeepLinkTarget.Question(
                    workerId = "gizmo-c1cb",
                    floorId = "droid-office",
                    questionId = "ask:droid-office:gizmo-c1cb:a1b2c3d4e5f6",
                ),
                officeBase = tailnetBase,
            ),
            DeepLinks.parse("$tailnetBase/open/question/gizmo-c1cb?floor=droid-office&ask=ask%3Adroid-office%3Agizmo-c1cb%3Aa1b2c3d4e5f6"),
        )
    }

    @Test
    fun parsesCustomSchemeCanonicalAndShorthandForms() {
        assertEquals(
            DeepLink(
                target = DeepLinkTarget.Worker(workerId = "w-42", floorId = "alpha", view = WorkerLinkView.Tty),
                officeBase = tailnetBase,
                officeId = "off-1",
            ),
            DeepLinks.parse("droidoffice://open/worker/w-42?floor=alpha&u=http%3A%2F%2Foffice-mac.tail08b849.ts.net%3A4600&office=off-1"),
        )
        assertEquals(
            DeepLink(target = DeepLinkTarget.Floor(floorId = "beta")),
            DeepLinks.parse("droidoffice://floor/beta"),
        )
        assertEquals(
            DeepLink(target = DeepLinkTarget.Card(cardId = "c-7", floorId = "beta")),
            DeepLinks.parse("droidoffice://card/c-7?floor=beta"),
        )
        // Composite ask ID directly in path populates floorId, workerId and questionId.
        assertEquals(
            DeepLink(
                target = DeepLinkTarget.Question(
                    workerId = "w-7",
                    floorId = "beta",
                    questionId = "ask:beta:w-7:0123456789ab",
                ),
            ),
            DeepLinks.parse("droidoffice://ask/ask%3Abeta%3Aw-7%3A0123456789ab"),
        )
    }

    @Test
    fun extractsDeepLinkFromSurroundingChatMessage() {
        val parsed = DeepLinks.parse("Gizmo needs your answer: $tailnetBase/open/question/gizmo-c1cb?floor=main&ask=team%3Amain%3A4). Tap to reply.")
        assertEquals(
            DeepLink(
                target = DeepLinkTarget.Question(workerId = "gizmo-c1cb", floorId = "main", questionId = "team:main:4"),
                officeBase = tailnetBase,
            ),
            parsed,
        )
        // Scans past earlier non-deep-link URLs in the same chat message.
        val afterGithubLink = DeepLinks.parse("PR https://github.com/nikships/droid-office/pull/1 is ready — jump in: $tailnetBase/open/worker/gizmo-c1cb?floor=main")
        assertEquals(
            DeepLink(
                target = DeepLinkTarget.Worker(workerId = "gizmo-c1cb", floorId = "main", view = WorkerLinkView.Tty),
                officeBase = tailnetBase,
            ),
            afterGithubLink,
        )
    }

    @Test
    fun refusesPairingLinksAndMalformedUrls() {
        assertNull(DeepLinks.parse("droidoffice://pair?v=1&name=Mac&t=secret12345&u=http%3A%2F%2F192.168.1.20%3A4600"))
        assertNull(DeepLinks.parse("$tailnetBase/?t=secret12345"))
        assertNull(DeepLinks.parse("$tailnetBase/open/worker/w-1?t=secret12345"))
        assertNull(DeepLinks.parse("$tailnetBase/dashboard#worker=w-1"))
        assertNull(DeepLinks.parse("droidoffice://open/unknown/w-1"))
        assertNull(DeepLinks.parse("droidoffice://open/worker/bad%20id"))
        assertNull(DeepLinks.parse("hello world"))
    }

    @Test
    fun resolvesMatchingPairedOfficeByIdBaseHostOrActiveFallback() {
        val laptop = OfficeRouteCandidate(
            id = "laptop",
            bases = listOf("http://192.168.1.10:4600", "http://laptop.tail08b849.ts.net:4600"),
            lastBase = "http://192.168.1.10:4600",
        )
        val mini = OfficeRouteCandidate(
            id = "mini",
            bases = listOf("http://192.168.1.50:4600", tailnetBase, "http://100.96.217.59:4600"),
            lastBase = "http://100.96.217.59:4600",
        )
        val offices = listOf(laptop, mini)

        // Exact base match selects mini even when laptop is active.
        val byBase = DeepLinks.parse("$tailnetBase/open/floor/main")!!
        assertEquals("mini", byBase.resolveOfficeId(offices, activeId = "laptop"))

        // Same MagicDNS host on another port (e.g. HTTPS proxy) still matches mini by host.
        val byHost = DeepLinks.parse("https://office-mac.tail08b849.ts.net:8443/open/floor/main")!!
        assertEquals("mini", byHost.resolveOfficeId(offices, activeId = "laptop"))

        // Explicit ?office= wins first, and returns null when that office is no longer paired.
        val byId = DeepLinks.parse("droidoffice://open/floor/main?office=laptop&u=http%3A%2F%2F100.96.217.59%3A4600")!!
        assertEquals("laptop", byId.resolveOfficeId(offices, activeId = "mini"))
        val missingId = DeepLinks.parse("droidoffice://open/floor/main?office=removed-office")!!
        assertNull(missingId.resolveOfficeId(offices, activeId = "mini"))

        // Unknown base returns null when multiple offices are paired, instead of guessing active;
        // when only a single office is paired (e.g. paired on Wi-Fi, tapped via Tailscale), it routes there.
        val unknownBase = DeepLinks.parse("http://other-office.tail08b849.ts.net:4600/open/floor/main")!!
        assertNull(unknownBase.resolveOfficeId(offices, activeId = "laptop"))
        assertEquals("laptop", unknownBase.resolveOfficeId(listOf(laptop), activeId = "laptop"))

        // Custom scheme without ?u= or ?office= falls back to active office.
        val fallback = DeepLinks.parse("droidoffice://open/floor/main")!!
        assertEquals("mini", fallback.resolveOfficeId(offices, activeId = "mini"))
        assertNull(fallback.resolveOfficeId(emptyList(), activeId = null))
    }

    @Test
    fun resolvesFloorByExactIdCaseInsensitiveIdOrUniqueName() {
        val floors = listOf(
            FloorInfo(id = "droid-office", name = "Droid Office"),
            FloorInfo(id = "home", name = "Home"),
        )
        assertEquals("droid-office", DeepLinks.resolveFloorId(floors, "droid-office"))
        assertEquals("droid-office", DeepLinks.resolveFloorId(floors, "DROID-OFFICE"))
        assertEquals("droid-office", DeepLinks.resolveFloorId(floors, "Droid Office"))
        assertNull(DeepLinks.resolveFloorId(floors, "closed-floor"))
    }

    @Test
    fun roundTripsThroughOfficeJsonAndFormatsPairingPrompts() {
        val link = DeepLinks.parse("$tailnetBase/open/card/card-1?floor=main")!!
        val encoded = OfficeJson.encodeToString(DeepLink.serializer(), link)
        assertEquals(link, OfficeJson.decodeFromString(DeepLink.serializer(), encoded))
        assertTrue(link.pairingPrompt().contains("card-1"))
    }
}
