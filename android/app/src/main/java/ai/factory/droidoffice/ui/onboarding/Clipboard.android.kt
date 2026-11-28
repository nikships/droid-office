package ai.factory.droidoffice.ui.onboarding

import androidx.compose.ui.platform.Clipboard

internal const val phonePlatform = "Android"

internal suspend fun Clipboard.joinLinkText(): String {
    val clip = getClipEntry()?.clipData
    return clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString().orEmpty()
}
