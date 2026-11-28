@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package ai.factory.droidoffice.ui.onboarding

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.UIKitView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import platform.AVFoundation.*
import platform.CoreGraphics.CGRectMake
import platform.Foundation.NSURL
import platform.UIKit.*
import platform.darwin.*

@Composable internal fun rememberCameraAccess(): CameraAccess {
    fun status() = AVCaptureDevice.authorizationStatusForMediaType(AVMediaTypeVideo)
    var permission by remember { mutableStateOf(status()) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { permission = status() }
    val available = remember { AVCaptureDevice.defaultDeviceWithMediaType(AVMediaTypeVideo) != null }
    return CameraAccess(permission == AVAuthorizationStatusAuthorized, permission == AVAuthorizationStatusDenied || permission == AVAuthorizationStatusRestricted, {
        AVCaptureDevice.requestAccessForMediaType(AVMediaTypeVideo) { dispatch_async(dispatch_get_main_queue()) { permission = status() } }
    }, { UIApplication.sharedApplication.openURL(NSURL.URLWithString(UIApplicationOpenSettingsURLString)!!, emptyMap<Any?, Any>(), null) }, available)
}

private class Preview(session: AVCaptureSession) : UIView(frame = CGRectMake(0.0, 0.0, 0.0, 0.0)) {
    private val preview = AVCaptureVideoPreviewLayer.layerWithSession(session).apply { videoGravity = AVLayerVideoGravityResizeAspectFill }
    init { layer.addSublayer(preview) }
    override fun layoutSubviews() { super.layoutSubviews(); preview.frame = bounds }
}

@Composable internal fun CameraPreview(torch: Boolean, onTorchAvailable: (Boolean) -> Unit, onCode: (String) -> Unit) {
    val read by rememberUpdatedState(onCode)
    val camera = remember { AVCaptureDevice.defaultDeviceWithMediaType(AVMediaTypeVideo) } ?: return
    val queue = remember { dispatch_queue_create("office.qr", null) }
    val session = remember { AVCaptureSession() }
    val output = remember { AVCaptureMetadataOutput() }
    val delegate = remember { object : NSObject(), AVCaptureMetadataOutputObjectsDelegateProtocol {
        override fun captureOutput(output: AVCaptureOutput, didOutputMetadataObjects: List<*>, fromConnection: AVCaptureConnection) {
            didOutputMetadataObjects.filterIsInstance<AVMetadataMachineReadableCodeObject>().firstNotNullOfOrNull { it.stringValue }?.let(read)
        }
    } }
    DisposableEffect(camera) {
        onTorchAvailable(camera.hasTorch)
        dispatch_async(queue) {
            val input = AVCaptureDeviceInput.deviceInputWithDevice(camera, null) ?: return@dispatch_async
            if (!session.canAddInput(input)) return@dispatch_async
            session.addInput(input)
            if (!session.canAddOutput(output)) return@dispatch_async
            session.addOutput(output)
            output.setMetadataObjectsDelegate(delegate, dispatch_get_main_queue())
            output.metadataObjectTypes = listOfNotNull(AVMetadataObjectTypeQRCode)
            session.startRunning()
        }
        onDispose { dispatch_async(queue) { session.stopRunning(); output.setMetadataObjectsDelegate(null, null) } }
    }
    LaunchedEffect(torch) { dispatch_async(queue) {
        if (camera.hasTorch && camera.lockForConfiguration(null)) {
            camera.torchMode = if (torch) AVCaptureTorchModeOn else AVCaptureTorchModeOff
            camera.unlockForConfiguration()
        }
    } }
    UIKitView(factory = { Preview(session) }, modifier = Modifier.fillMaxSize())
}
