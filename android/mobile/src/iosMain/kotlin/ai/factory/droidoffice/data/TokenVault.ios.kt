@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package ai.factory.droidoffice.data

import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.net.OfficeAuth
import kotlin.uuid.Uuid
import kotlinx.cinterop.*
import platform.CoreFoundation.*
import platform.Foundation.*
import platform.Security.*

/** Each enrollment is a distinct, non-migrating Keychain item. Public preferences hold only its handle. */
internal class TokenVault : OfficeVault {
    private val service = "${checkNotNull(NSBundle.mainBundle.bundleIdentifier)}.office-keys"

    private fun <T> item(handle: String, block: (CFMutableDictionaryRef) -> T): T {
        val query = checkNotNull(CFDictionaryCreateMutable(null, 0, kCFTypeDictionaryKeyCallBacks.ptr, kCFTypeDictionaryValueCallBacks.ptr))
        val account = CFBridgingRetain(handle)
        val namespace = CFBridgingRetain(service)
        try {
            CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword)
            CFDictionarySetValue(query, kSecAttrService, namespace)
            CFDictionarySetValue(query, kSecAttrAccount, account)
            return block(query)
        } finally {
            CFRelease(query)
            CFRelease(account)
            CFRelease(namespace)
        }
    }

    override fun seal(office: PairedOffice, token: String): String {
        val origin = office.bases.single() // iOS never enrolls a bearer for a second advertised origin.
        val key = OfficeKey(office.id, office.auth, listOf(origin), token)
        val handle = Uuid.random().toString()
        item(handle) { query ->
            val bytes = CFBridgingRetain(OfficeJson.encodeToString(key).encodeToByteArray().toData())
            try {
                CFDictionarySetValue(query, kSecAttrAccessible, kSecAttrAccessibleWhenUnlockedThisDeviceOnly)
                CFDictionarySetValue(query, kSecValueData, bytes)
                check(SecItemAdd(query, null) == errSecSuccess) { "Couldn't save the office key" }
            } finally { CFRelease(bytes) }
        }
        return handle
    }

    override fun open(office: PairedOffice, sealed: String): OfficeAuth? = item(sealed) { query ->
        memScoped {
            CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue)
            val result = alloc<CFTypeRefVar>()
            if (SecItemCopyMatching(query, result.ptr) != errSecSuccess) return@memScoped null
            val data = CFBridgingRelease(result.value) as? NSData ?: return@memScoped null
            runCatching { OfficeJson.decodeFromString<OfficeKey>(data.toBytes().decodeToString()).auth(office) }.getOrNull()
        }
    }

    override fun discard(sealed: String) = item(sealed) { query ->
        val status = SecItemDelete(query)
        check(status == errSecSuccess || status == errSecItemNotFound) { "Couldn't remove the office key" }
    }
}
