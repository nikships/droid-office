package ai.factory.droidoffice.core

import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.CPointerVar
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.cValue
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.pointed
import kotlinx.cinterop.ptr
import kotlinx.cinterop.readBytes
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.value
import platform.Foundation.NSDate
import platform.Foundation.NSDateFormatter
import platform.Foundation.NSDateFormatterMediumStyle
import platform.Foundation.NSDateFormatterShortStyle
import platform.Foundation.NSLocale
import platform.Foundation.NSMakeRange
import platform.Foundation.NSNumber
import platform.Foundation.NSNumberFormatter
import platform.Foundation.NSNumberFormatterDecimalStyle
import platform.Foundation.NSNumberFormatterRoundHalfUp
import platform.Foundation.NSString
import platform.Foundation.NSTimeZone
import platform.Foundation.NSURLComponents
import platform.Foundation.compare
import platform.Foundation.create
import platform.Foundation.autoupdatingCurrentLocale
import platform.Foundation.dateWithTimeIntervalSince1970
import platform.Foundation.localTimeZone
import platform.posix.AF_INET6
import platform.posix.AI_NUMERICHOST
import platform.posix.SOCK_STREAM
import platform.posix.addrinfo
import platform.posix.freeaddrinfo
import platform.posix.getaddrinfo
import platform.posix.sockaddr_in6

internal actual fun parseUri(text: String): UriParts? {
    val components = NSURLComponents.componentsWithString(text) ?: return null
    return UriParts(
        scheme = components.scheme,
        host = components.percentEncodedHost,
        port = components.port?.intValue ?: -1,
        rawPath = components.percentEncodedPath,
        rawQuery = components.percentEncodedQuery,
    )
}

@OptIn(ExperimentalForeignApi::class)
internal actual fun ipv6Bytes(host: String): ByteArray? = memScoped {
    val hints = cValue<addrinfo> {
        ai_family = AF_INET6
        ai_socktype = SOCK_STREAM
        ai_flags = AI_NUMERICHOST
    }
    val result = alloc<CPointerVar<addrinfo>>()
    if (getaddrinfo(host, null, hints, result.ptr) != 0) return@memScoped null
    val info = result.value ?: return@memScoped null
    try {
        val addr = info.pointed.ai_addr!!.reinterpret<sockaddr_in6>().pointed.sin6_addr
        val bytes = addr.ptr.reinterpret<ByteVar>().readBytes(16)
        // InetAddress represents ::ffff:a.b.c.d as IPv4 on Android.
        if ((0 until 10).all { bytes[it].toInt() == 0 } && bytes[10].toInt() == -1 && bytes[11].toInt() == -1) bytes.copyOfRange(12, 16) else bytes
    } finally {
        freeaddrinfo(info)
    }
}

// Foundation formatters are costly to build and safe to share across threads, so each is made once.
private val decimalFormatters = Array(4) { decimalFormatter(it) }

private fun decimalFormatter(decimals: Int) = NSNumberFormatter().apply {
    locale = NSLocale(localeIdentifier = "en_US_POSIX")
    numberStyle = NSNumberFormatterDecimalStyle
    usesGroupingSeparator = false
    roundingMode = NSNumberFormatterRoundHalfUp
    minimumIntegerDigits = 1u
    minimumFractionDigits = decimals.toULong()
    maximumFractionDigits = decimals.toULong()
}

internal actual fun formatDecimals(value: Double, decimals: Int): String {
    val formatter = decimalFormatters.getOrNull(decimals) ?: decimalFormatter(decimals)
    return formatter.stringFromNumber(NSNumber(double = value)) ?: value.toString()
}

internal actual fun lowercaseCodePoint(codePoint: Int): Int {
    if (codePoint !in 0..0x10FFFF) return codePoint
    if (codePoint < 0x10000) return codePoint.toChar().lowercaseChar().code
    val lower = CodePoints.toString(codePoint).lowercase()
    return if (CodePoints.count(lower, 0, lower.length) == 1) CodePoints.at(lower, 0) else codePoint
}

internal actual fun isUppercaseCodePoint(codePoint: Int): Boolean {
    if (codePoint !in 0..0x10FFFF) return false
    if (codePoint < 0x10000) return codePoint.toChar().isUpperCase()
    val text = CodePoints.toString(codePoint)
    return text.lowercase() != text && text.uppercase() == text
}

private val rootLocale = NSLocale(localeIdentifier = "")

@OptIn(BetaInteropApi::class, ExperimentalForeignApi::class)
internal actual fun collate(a: String, b: String): Int {
    val left = NSString.create(string = a)
    return left.compare(b, options = 0u, range = NSMakeRange(0u, left.length), locale = rootLocale).toInt()
}

// The autoupdating locale and time zone follow a change in Settings without a new formatter.
private val dateTimeFormatter = NSDateFormatter().apply {
    locale = NSLocale.autoupdatingCurrentLocale
    timeZone = NSTimeZone.localTimeZone
    dateStyle = NSDateFormatterMediumStyle
    timeStyle = NSDateFormatterShortStyle
}

internal actual fun localDateTime(epochMillis: Long): String =
    dateTimeFormatter.stringFromDate(NSDate.dateWithTimeIntervalSince1970(epochMillis / 1000.0))
