package app.scrollantir.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import android.view.ViewGroup
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.scrollantir.net.DeviceId
import app.scrollantir.net.ForwarderWorker
import app.scrollantir.net.SecurePrefs
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Onboarding QR-scan screen. Parses the runtime admin's mint payload:
 *
 *   {
 *     "v": 3,                 // version bump from the Supabase-era v2
 *     "url": "https://...",   // base URL of the runtime stack — no
 *                             //   trailing path; client appends
 *                             //   /rpc/<func> for each call
 *     "token": "...",         // bearer (validated server-side as
 *                             //   p_token in the RPC body)
 *     "device": "phone",      // matches the first segment of every
 *                             //   event source emitted from this device
 *     "label": "...",         // optional human label
 *     "platform": "..."       // optional, free-form
 *   }
 *
 * Writes url + token + device into SecurePrefs so the ForwarderWorker
 * posts to the runtime as the intended device.
 */
@Composable
fun OnboardScanScreen(
    onBack: () -> Unit,
    onDone: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(
                context, Manifest.permission.CAMERA
            ) == PackageManager.PERMISSION_GRANTED
        )
    }
    val permLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted -> hasCameraPermission = granted }

    var result by remember { mutableStateOf<ScanResult>(ScanResult.Scanning) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Back"
                )
            }
            Spacer(Modifier.width(4.dp))
            Text(
                text = "Scan Onboarding QR",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold
            )
        }

        when {
            !hasCameraPermission -> PermissionPrompt(
                onGrant = { permLauncher.launch(Manifest.permission.CAMERA) }
            )
            result is ScanResult.Success -> SuccessCard(
                details = result as ScanResult.Success,
                onDone = onDone
            )
            else -> {
                QrPreview(
                    onPayload = { raw ->
                        if (result is ScanResult.Success) return@QrPreview
                        val parsed = parseOnboardPayload(raw)
                        result = parsed
                        if (parsed is ScanResult.Success) {
                            commitToPrefs(context, parsed)
                            ForwarderWorker.syncNow(context)
                        }
                    }
                )
                HintCard(current = result)
            }
        }
    }
}

@Composable
private fun PermissionPrompt(onGrant: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainer
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = "Camera permission required",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Medium
            )
            Text(
                text = "The QR scanner needs the camera to read the " +
                    "onboarding code minted by ./admin mint.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Button(onClick = onGrant, modifier = Modifier.fillMaxWidth()) {
                Text("Grant camera access")
            }
        }
    }
}

@Composable
private fun QrPreview(onPayload: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val scanner = remember {
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build()
        )
    }

    DisposableEffect(Unit) {
        onDispose {
            executor.shutdown()
            scanner.close()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .clip(RoundedCornerShape(20.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
    ) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                val previewView = PreviewView(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                    scaleType = PreviewView.ScaleType.FILL_CENTER
                }
                val providerFuture = ProcessCameraProvider.getInstance(ctx)
                providerFuture.addListener({
                    val provider = providerFuture.get()
                    val preview = Preview.Builder().build().also {
                        it.setSurfaceProvider(previewView.surfaceProvider)
                    }
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                        .apply { setAnalyzer(executor, QrAnalyzer(scanner, onPayload)) }
                    try {
                        provider.unbindAll()
                        provider.bindToLifecycle(
                            lifecycleOwner,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            analysis
                        )
                    } catch (t: Throwable) {
                        Log.e(TAG, "bindToLifecycle failed", t)
                    }
                }, ContextCompat.getMainExecutor(ctx))
                previewView
            }
        )
    }
}

private class QrAnalyzer(
    private val scanner: BarcodeScanner,
    private val onPayload: (String) -> Unit
) : ImageAnalysis.Analyzer {

    override fun analyze(proxy: ImageProxy) {
        val media = proxy.image
        if (media == null) {
            proxy.close()
            return
        }
        val input = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
        scanner.process(input)
            .addOnSuccessListener { barcodes ->
                barcodes.firstOrNull()?.rawValue?.let(onPayload)
            }
            .addOnFailureListener { Log.w(TAG, "barcode scan failed", it) }
            .addOnCompleteListener { proxy.close() }
    }
}

@Composable
private fun HintCard(current: ScanResult) {
    val text = when (current) {
        is ScanResult.Scanning -> "Point the camera at the QR code printed by " +
            "./admin mint. The scan happens automatically."
        is ScanResult.Error -> current.message
        is ScanResult.Success -> ""
    }
    if (text.isEmpty()) return
    val isError = current is ScanResult.Error
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (isError)
                MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.35f)
            else MaterialTheme.colorScheme.surfaceContainer
        )
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = if (isError) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(14.dp)
        )
    }
}

@Composable
private fun SuccessCard(details: ScanResult.Success, onDone: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerHigh
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(
                text = "Onboarded as ${details.label ?: details.deviceId}",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Medium
            )
            KeyValueRow("Device id", details.deviceId)
            KeyValueRow("Token prefix", details.tokenPrefix)
            KeyValueRow("Runtime URL", details.url)
            Text(
                text = "A sync has been kicked off. Verify with " +
                    "`./admin list` — last_used_at should advance shortly.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Button(onClick = onDone, modifier = Modifier.fillMaxWidth()) {
                Text("Done")
            }
        }
    }
}

@Composable
private fun KeyValueRow(key: String, value: String) {
    Row(verticalAlignment = Alignment.Top) {
        Text(
            text = key,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(100.dp)
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium
        )
    }
}

private sealed class ScanResult {
    object Scanning : ScanResult()
    data class Error(val message: String) : ScanResult()
    data class Success(
        val url: String,
        val token: String,
        val deviceId: String,
        val label: String?,
        val platform: String?,
        val tokenPrefix: String
    ) : ScanResult()
}

private fun parseOnboardPayload(raw: String): ScanResult {
    val json = try {
        JSONObject(raw)
    } catch (_: Throwable) {
        return ScanResult.Error("QR does not contain JSON. Scan a QR minted by the runtime admin CLI.")
    }
    val version = json.optInt("v", -1)
    if (version != 3) {
        return ScanResult.Error(
            "Unsupported QR version $version (expected 3 — runtime stack)."
        )
    }
    val url = json.optString("url").takeIf { it.isNotBlank() }
        ?: return ScanResult.Error("QR is missing `url`.")
    val token = json.optString("token").takeIf { it.isNotBlank() }
        ?: return ScanResult.Error("QR is missing `token`.")
    // Accept legacy `device_id` for transitional compatibility, but the
    // canonical key is `device` (matches the source-prefix on the wire).
    val deviceId = json.optString("device").takeIf { it.isNotBlank() }
        ?: json.optString("device_id").takeIf { it.isNotBlank() }
        ?: return ScanResult.Error("QR is missing `device`.")
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return ScanResult.Error("QR `url` is not http(s).")
    }
    // The runtime URL is a base origin; the client appends /rpc/<func>.
    // Reject obvious legacy paths so we fail loudly on a stale QR
    // instead of silently double-pathing later.
    val normalized = url.trimEnd('/')
    if (normalized.endsWith("/ingest") || normalized.contains("/functions/v1/")) {
        return ScanResult.Error(
            "QR `url` looks like a Supabase ingest endpoint. The runtime " +
                "stack expects a base URL (e.g. https://api.example.com)."
        )
    }
    return ScanResult.Success(
        url = normalized,
        token = token,
        deviceId = deviceId,
        label = json.optString("label").takeIf { it.isNotBlank() },
        platform = json.optString("platform").takeIf { it.isNotBlank() },
        tokenPrefix = token.take(8)
    )
}

private fun commitToPrefs(context: Context, success: ScanResult.Success) {
    SecurePrefs.get(context).edit()
        .putString(SecurePrefs.KEY_SERVER_URL, success.url)
        .putString(SecurePrefs.KEY_TOKEN, success.token)
        .putString(SecurePrefs.KEY_DEVICE_ID, success.deviceId)
        .apply()
    DeviceId.set(success.deviceId)
}

private const val TAG = "ScrollantirOnboard"
