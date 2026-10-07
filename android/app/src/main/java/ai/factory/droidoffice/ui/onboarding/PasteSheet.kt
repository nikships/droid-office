package ai.factory.droidoffice.ui.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import ai.factory.droidoffice.core.InviteParse
import ai.factory.droidoffice.core.Pairing
import ai.factory.droidoffice.core.PairingInvite
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.PrimaryButton
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.launch

/** The fallback to the camera: paste the join link (or the pairing payload) the office printed. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PasteSheet(onDismiss: () -> Unit, onInvite: (PairingInvite) -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var text by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }

    fun submit() {
        when (val r = Pairing.parse(text)) {
            is InviteParse.Ok -> onInvite(r.invite)
            is InviteParse.Invalid -> error = r.reason
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = Palette.Surface, shape = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp).navigationBarsPadding().imePadding().padding(bottom = 16.dp)) {
            Eyebrow("Pair by link")
            Spacer(Modifier.height(6.dp))
            Text("Paste the join link", style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(6.dp))
            Text(
                "The office prints it under its QR code: http://192.168.1.20:4600/?t=… Tailscale addresses work too.",
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(
                value = text,
                onValueChange = {
                    text = it
                    error = null
                },
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
                placeholder = { Text("http://…/?t=…", style = LocalOfficeType.current.monoBody, color = Palette.TextTertiary) },
                textStyle = LocalOfficeType.current.monoBody,
                isError = error != null,
                supportingText = error?.let { { Text(it) } },
                minLines = 2,
                maxLines = 4,
                shape = RoundedCornerShape(10.dp),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                keyboardActions = KeyboardActions(onGo = { submit() }),
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Palette.Accent, unfocusedBorderColor = Palette.BorderStrong, cursorColor = Palette.Accent),
            )
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SecondaryButton("From clipboard", {
                    scope.launch {
                        val clip = clipboard.getClipEntry()?.clipData
                        val pasted = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString().orEmpty()
                        if (pasted.isNotBlank()) {
                            text = pasted
                            submit()
                        } else error = "The clipboard is empty"
                    }
                }, Modifier.weight(1f), icon = OfficeIcons.Paste)
                PrimaryButton("Pair", ::submit, Modifier.weight(1f), enabled = text.isNotBlank(), icon = OfficeIcons.Link)
            }
        }
    }
}
