package ai.factory.droidoffice.ui.onboarding

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.camera.compose.CameraXViewfinder
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceRequest
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.lifecycle.awaitInstance
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import ai.factory.droidoffice.core.InviteParse
import ai.factory.droidoffice.core.Pairing
import ai.factory.droidoffice.core.PairingInvite
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.PrimaryButton
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.dotGrid
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.delay

/** The camera, looking for the office's pairing QR code; a pasted link works as well. */
@Composable
fun ScanScreen(onBack: () -> Unit, onInvite: (PairingInvite) -> Unit) {
    val context = LocalContext.current
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var denied by remember { mutableStateOf(false) }
    var showPaste by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        denied = !ok
    }
    LaunchedEffect(Unit) { if (!granted) launcher.launch(Manifest.permission.CAMERA) }

    Box(Modifier.fillMaxSize().tagged(Tags.Screen.SCAN).background(Color.Black)) {
        if (granted) {
            Scanner(onInvite)
        } else {
            NoCamera(
                denied = denied,
                onAsk = { launcher.launch(Manifest.permission.CAMERA) },
                onSettings = {
                    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
                },
                onPaste = { showPaste = true },
            )
        }

        Row(
            Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack, modifier = Modifier.tagged(Tags.Scan.BACK), colors = IconButtonDefaults.iconButtonColors(containerColor = Color(0x66000000), contentColor = Color.White)) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
            }
            Spacer(Modifier.weight(1f))
            if (granted) {
                IconButton(onClick = { showPaste = true }, modifier = Modifier.tagged(Tags.Scan.PASTE), colors = IconButtonDefaults.iconButtonColors(containerColor = Color(0x66000000), contentColor = Color.White)) {
                    Icon(OfficeIcons.Paste, "Paste a join link")
                }
            }
        }
    }
    if (showPaste) PasteSheet(onDismiss = { showPaste = false }, onInvite = { showPaste = false; onInvite(it) })
}

@OptIn(ExperimentalGetImage::class)
@Composable
private fun Scanner(onInvite: (PairingInvite) -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val haptics = LocalHapticFeedback.current
    var request by remember { mutableStateOf<SurfaceRequest?>(null) }
    var camera by remember { mutableStateOf<Camera?>(null) }
    var torch by remember { mutableStateOf(false) }
    var hint by remember { mutableStateOf<String?>(null) }
    var found by remember { mutableStateOf<PairingInvite?>(null) }
    val handled = remember { AtomicBoolean(false) }
    val executor = remember { Executors.newSingleThreadExecutor() }
    val scanner = remember {
        BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
    }
    DisposableEffect(Unit) {
        onDispose {
            scanner.close()
            executor.shutdown()
        }
    }

    LaunchedEffect(lifecycle) {
        val provider = ProcessCameraProvider.awaitInstance(context)
        val preview = Preview.Builder().build().apply { setSurfaceProvider { request = it } }
        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        analysis.setAnalyzer(executor) { proxy ->
            val media = proxy.image
            if (media == null || handled.get()) {
                proxy.close()
                return@setAnalyzer
            }
            scanner.process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
                .addOnSuccessListener { codes ->
                    for (code in codes) {
                        val raw = code.rawValue ?: continue
                        when (val r = Pairing.parse(raw)) {
                            is InviteParse.Ok -> if (handled.compareAndSet(false, true)) found = r.invite
                            is InviteParse.Invalid -> hint = "That QR code isn't an office's pairing code"
                        }
                    }
                }
                .addOnCompleteListener { proxy.close() }
        }
        provider.unbindAll()
        camera = provider.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
    }

    LaunchedEffect(found) {
        val invite = found ?: return@LaunchedEffect
        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        delay(420)
        onInvite(invite)
    }
    LaunchedEffect(hint) {
        if (hint != null) {
            delay(2_500)
            hint = null
        }
    }

    Box(Modifier.fillMaxSize()) {
        request?.let { CameraXViewfinder(surfaceRequest = it, modifier = Modifier.fillMaxSize()) }
        Frame(locked = found != null)
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 24.dp, vertical = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            AnimatedVisibility(hint != null, enter = fadeIn(), exit = fadeOut()) {
                Text(
                    hint.orEmpty(),
                    style = MaterialTheme.typography.labelMedium,
                    color = Palette.Warning,
                    modifier = Modifier.padding(bottom = 12.dp).background(Color(0xCC000000), RoundedCornerShape(8.dp)).padding(horizontal = 12.dp, vertical = 7.dp),
                )
            }
            Column(
                Modifier.widthIn(max = 480.dp).fillMaxWidth().tagged(Tags.Scan.STATUS).panel(RoundedCornerShape(14.dp), Color(0xE60A0A0A)).padding(16.dp),
            ) {
                Eyebrow(if (found != null) "Found it" else "Pair with an office", color = if (found != null) Palette.Success else Palette.Accent)
                Spacer(Modifier.height(4.dp))
                Text(
                    found?.let { "Joining ${it.name}…" } ?: "Point at the QR code",
                    style = MaterialTheme.typography.titleLarge,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    "The office shows it in its terminal when it starts, and under Settings → Phone.",
                    style = MaterialTheme.typography.bodySmall,
                )
                if (camera?.cameraInfo?.hasFlashUnit() == true) {
                    Spacer(Modifier.height(12.dp))
                    SecondaryButton(
                        if (torch) "Light off" else "Light on",
                        {
                            torch = !torch
                            camera?.cameraControl?.enableTorch(torch)
                        },
                        Modifier.fillMaxWidth().height(44.dp).tagged(Tags.Scan.TORCH),
                        icon = OfficeIcons.Bolt,
                    )
                }
            }
        }
    }
}

/** A dimmed surround with a clear rounded square, orange corners and a sweeping scan line. */
@Composable
private fun Frame(locked: Boolean) {
    val t = rememberInfiniteTransition(label = "scan")
    val sweep by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1800, easing = LinearEasing), RepeatMode.Reverse), label = "sweep")
    val color = if (locked) Palette.Success else Palette.Accent
    Canvas(Modifier.fillMaxSize().graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }) {
        val side = minOf(size.width, size.height) * 0.68f
        val left = (size.width - side) / 2
        val top = (size.height - side) / 2.4f
        val r = 22.dp.toPx()
        drawRect(Color(0xA6000000))
        drawRoundRect(Color.Transparent, Offset(left, top), Size(side, side), CornerRadius(r), blendMode = BlendMode.Clear)

        val arm = side * 0.16f
        val stroke = Stroke(4.dp.toPx(), cap = StrokeCap.Round)
        val box = Rect(left, top, left + side, top + side)
        val corners = Path().apply {
            // Each corner: down the side, round the bend, along the edge.
            moveTo(box.left, box.top + arm); lineTo(box.left, box.top + r); quadraticTo(box.left, box.top, box.left + r, box.top); lineTo(box.left + arm, box.top)
            moveTo(box.right - arm, box.top); lineTo(box.right - r, box.top); quadraticTo(box.right, box.top, box.right, box.top + r); lineTo(box.right, box.top + arm)
            moveTo(box.right, box.bottom - arm); lineTo(box.right, box.bottom - r); quadraticTo(box.right, box.bottom, box.right - r, box.bottom); lineTo(box.right - arm, box.bottom)
            moveTo(box.left + arm, box.bottom); lineTo(box.left + r, box.bottom); quadraticTo(box.left, box.bottom, box.left, box.bottom - r); lineTo(box.left, box.bottom - arm)
        }
        drawPath(corners, color, style = stroke)

        if (!locked) {
            val y = top + side * (0.08f + 0.84f * sweep)
            drawRect(
                Brush.verticalGradient(listOf(Color.Transparent, color.copy(alpha = 0.28f), Color.Transparent), startY = y - 24.dp.toPx(), endY = y + 24.dp.toPx()),
                Offset(left + 12.dp.toPx(), y - 24.dp.toPx()),
                Size(side - 24.dp.toPx(), 48.dp.toPx()),
            )
            drawLine(color.copy(alpha = 0.9f), Offset(left + 16.dp.toPx(), y), Offset(left + side - 16.dp.toPx(), y), 1.5.dp.toPx())
        } else {
            drawRoundRect(color.copy(alpha = 0.16f), Offset(left, top), Size(side, side), CornerRadius(r))
        }
    }
}

@Composable
private fun NoCamera(denied: Boolean, onAsk: () -> Unit, onSettings: () -> Unit, onPaste: () -> Unit) {
    Box(Modifier.fillMaxSize().background(Palette.Bg).dotGrid(), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 480.dp).fillMaxWidth().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(Modifier.size(64.dp).background(Palette.AccentMuted, CircleShape), contentAlignment = Alignment.Center) {
                Icon(OfficeIcons.Scan, null, Modifier.size(28.dp), tint = Palette.Accent)
            }
            Text("The camera reads the office's code", style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
            Text(
                if (denied) "Camera access is off for Droid Office. Turn it on in Settings, or paste the join link the office printed instead."
                else "Allow the camera to scan the pairing QR code. Nothing is recorded or kept.",
                style = MaterialTheme.typography.bodyMedium,
                color = Palette.TextSecondary,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(10.dp))
            PrimaryButton(if (denied) "Open Settings" else "Allow camera", if (denied) onSettings else onAsk, Modifier.fillMaxWidth().tagged(Tags.Scan.CAMERA), icon = OfficeIcons.Scan)
            SecondaryButton("Paste a join link", onPaste, Modifier.fillMaxWidth().tagged(Tags.Scan.PASTE_LINK), icon = OfficeIcons.Paste)
        }
    }
}
