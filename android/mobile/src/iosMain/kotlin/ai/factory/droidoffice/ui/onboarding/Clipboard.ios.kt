package ai.factory.droidoffice.ui.onboarding

import androidx.compose.ui.platform.Clipboard
import platform.UIKit.UIPasteboard

internal const val phonePlatform = "iOS"

internal suspend fun Clipboard.joinLinkText(): String = UIPasteboard.generalPasteboard.string.orEmpty()
