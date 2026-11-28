package ai.factory.droidoffice.core

/**
 * What core needs from the platform it runs on. Android answers with the same JDK calls core made
 * before it was shared, so its behavior is unchanged; iOS answers with Foundation.
 */

/** The parts of a link that core reads, as `java.net.URI` gives them. */
internal class UriParts(val scheme: String?, val host: String?, val port: Int, val rawPath: String?, val rawQuery: String?)

/** [text] read as a URI; null when it isn't one. */
internal expect fun parseUri(text: String): UriParts?

/** Parses an IPv6 literal and its interface scope without DNS. Mapped IPv4 addresses return four bytes. */
internal expect fun ipv6Bytes(host: String): ByteArray?

/** [value] with exactly [decimals] digits after a `.` and no grouping, as `"%.Nf"` gives it. */
internal expect fun formatDecimals(value: Double, decimals: Int): String

/** Lower case of one Unicode code point, as `Character.toLowerCase(Int)` gives it. */
internal expect fun lowercaseCodePoint(codePoint: Int): Int

/** Whether one Unicode code point is upper case, as `Character.isUpperCase(Int)` says. */
internal expect fun isUppercaseCodePoint(codePoint: Int): Boolean

/** Root-locale collation: the order JavaScript's `localeCompare` gives on the web. */
internal expect fun collate(a: String, b: String): Int

/** A medium date and a short time in the device's language and time zone: "Nov 4, 2026, 4:31 AM" on Android in English. */
internal expect fun localDateTime(epochMillis: Long): String
