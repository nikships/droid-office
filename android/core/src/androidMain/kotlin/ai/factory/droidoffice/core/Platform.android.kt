package ai.factory.droidoffice.core

import java.net.InetAddress
import java.net.URI
import java.text.Collator
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

internal actual fun parseUri(text: String): UriParts? {
    val uri = try {
        URI(text)
    } catch (_: Exception) {
        return null
    }
    return UriParts(scheme = uri.scheme, host = uri.host, port = uri.port, rawPath = uri.rawPath, rawQuery = uri.rawQuery)
}

internal actual fun ipv6Bytes(host: String): ByteArray? =
    if (':' in host) runCatching { InetAddress.getByName(host).address }.getOrNull() else null

internal actual fun formatDecimals(value: Double, decimals: Int): String = String.format(Locale.ROOT, "%.${decimals}f", value)

internal actual fun lowercaseCodePoint(codePoint: Int): Int = Character.toLowerCase(codePoint)

internal actual fun isUppercaseCodePoint(codePoint: Int): Boolean = Character.isUpperCase(codePoint)

// ICU root collation, the order JavaScript's localeCompare gives on the web.
private val rootCollator: Collator = Collator.getInstance(Locale.ROOT)

internal actual fun collate(a: String, b: String): Int = rootCollator.compare(a, b)

internal actual fun localDateTime(epochMillis: Long): String =
    DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(epochMillis))
