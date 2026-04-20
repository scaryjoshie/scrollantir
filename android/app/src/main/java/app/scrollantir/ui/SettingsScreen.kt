package app.scrollantir.ui

import android.Manifest
import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import app.scrollantir.BuildConfig
import app.scrollantir.net.ForwarderWorker
import app.scrollantir.net.SecurePrefs
import app.scrollantir.tracker.ContentDetectorService
import app.scrollantir.tracker.TrackerForegroundService
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    var refreshTick by remember { mutableIntStateOf(0) }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) refreshTick++
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val notifGranted = remember(refreshTick) { hasNotificationPermission(context) }
    val usageGranted = remember(refreshTick) { hasUsageStatsPermission(context) }
    val batteryOK = remember(refreshTick) { isIgnoringBatteryOptimizations(context) }
    val a11yGranted = remember(refreshTick) { isAccessibilityEnabled(context) }
    val running by TrackerForegroundService.running.collectAsState()
    val canStart = notifGranted && usageGranted

    val notifLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { refreshTick++ }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("← Today") }
            Spacer(Modifier.width(4.dp))
            Text(
                text = "Settings",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold
            )
        }

        TrackingControlCard(
            running = running,
            canStart = canStart,
            onToggle = {
                if (running) TrackerForegroundService.stop(context)
                else TrackerForegroundService.start(context)
            }
        )

        PermissionsSection(
            notifGranted = notifGranted,
            usageGranted = usageGranted,
            batteryOK = batteryOK,
            a11yGranted = a11yGranted,
            onGrantNotif = {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            },
            onGrantUsage = {
                context.startActivity(
                    Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            },
            onGrantBattery = {
                val intent = Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:${context.packageName}")
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            },
            onGrantA11y = {
                context.startActivity(
                    Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        )

        SyncCard(context = context, refreshKey = refreshTick)
        ServerSettingsCard(context = context, onSaved = { refreshTick++ })

        VersionFooter()
    }
}

@Composable
private fun TrackingControlCard(
    running: Boolean,
    canStart: Boolean,
    onToggle: () -> Unit
) {
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
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(12.dp)
                        .background(
                            color = if (running) Color(0xFF22C55E)
                                    else MaterialTheme.colorScheme.outline,
                            shape = CircleShape
                        )
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    text = if (running) "Tracking is on" else "Tracking is off",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Medium
                )
            }
            Button(
                onClick = onToggle,
                enabled = running || canStart,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    text = when {
                        running -> "Pause tracking"
                        !canStart -> "Grant required permissions below to start"
                        else -> "Start tracking"
                    }
                )
            }
        }
    }
}

@Composable
private fun PermissionsSection(
    notifGranted: Boolean,
    usageGranted: Boolean,
    batteryOK: Boolean,
    a11yGranted: Boolean,
    onGrantNotif: () -> Unit,
    onGrantUsage: () -> Unit,
    onGrantBattery: () -> Unit,
    onGrantA11y: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainer
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text(
                text = "Permissions",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            PermissionRow("Notifications", notifGranted, onGrantNotif)
            PermissionRow("Usage access", usageGranted, onGrantUsage)
            PermissionRow("Ignore battery optimization", batteryOK, onGrantBattery)
            PermissionRow("Accessibility (Shorts/Reels detection)", a11yGranted, onGrantA11y)
        }
    }
}

@Composable
private fun PermissionRow(
    label: String,
    granted: Boolean,
    onGrant: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .background(
                    color = if (granted) Color(0xFF22C55E)
                            else MaterialTheme.colorScheme.outline,
                    shape = CircleShape
                )
        )
        Spacer(Modifier.width(10.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f)
        )
        if (!granted) {
            TextButton(onClick = onGrant) { Text("Grant") }
        }
    }
}

@Composable
private fun SyncCard(context: Context, refreshKey: Int) {
    val status by ForwarderWorker.status.collectAsState()
    val configured = remember(refreshKey) {
        val prefs = SecurePrefs.get(context)
        !prefs.getString(SecurePrefs.KEY_SERVER_URL, null).isNullOrBlank() &&
        !prefs.getString(SecurePrefs.KEY_TOKEN, null).isNullOrBlank()
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainer
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(
                text = "Sync",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Text(
                text = buildString {
                    if (!configured) {
                        append("Server not configured")
                    } else if (status.lastAttempt == null) {
                        append("No sync yet")
                    } else {
                        append("Last: ")
                        append(humanAgo(status.lastAttempt!!))
                        append("  (")
                        append(if (status.lastError == null) "ok" else "error")
                        append(", ")
                        append(status.lastBatchSize)
                        append(" events)")
                    }
                },
                style = MaterialTheme.typography.bodyMedium
            )
            if (status.lastError != null) {
                Text(
                    text = status.lastError!!,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error
                )
            }
            OutlinedButton(
                enabled = configured,
                onClick = { ForwarderWorker.syncNow(context) },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(if (configured) "Sync now" else "Configure server below")
            }
        }
    }
}

@Composable
private fun ServerSettingsCard(context: Context, onSaved: () -> Unit) {
    val prefs = remember { SecurePrefs.get(context) }
    var url by remember {
        mutableStateOf(prefs.getString(SecurePrefs.KEY_SERVER_URL, "") ?: "")
    }
    var token by remember {
        mutableStateOf(prefs.getString(SecurePrefs.KEY_TOKEN, "") ?: "")
    }
    var saved by remember { mutableStateOf(false) }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainer
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = "Server",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedTextField(
                value = url,
                onValueChange = { url = it; saved = false },
                label = { Text("URL") },
                placeholder = { Text("http://192.168.1.x:8069") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = token,
                onValueChange = { token = it; saved = false },
                label = { Text("Bearer token") },
                placeholder = { Text("dev-token") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth()
            )
            Button(
                onClick = {
                    prefs.edit()
                        .putString(SecurePrefs.KEY_SERVER_URL, url.trim())
                        .putString(SecurePrefs.KEY_TOKEN, token.trim())
                        .apply()
                    saved = true
                    onSaved()
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(if (saved) "Saved" else "Save")
            }
        }
    }
}

@Composable
private fun VersionFooter() {
    val built = remember {
        val instant = Instant.ofEpochMilli(BuildConfig.BUILD_TIME_MS)
        DateTimeFormatter.ofPattern("MMM d  HH:mm:ss")
            .withZone(ZoneId.systemDefault())
            .format(instant)
    }
    Text(
        text = "v${BuildConfig.VERSION_NAME}  ·  built $built",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth()
    )
}

internal fun humanAgo(then: Instant): String {
    val seconds = Duration.between(then, Instant.now()).seconds
    return when {
        seconds < 60 -> "${seconds}s ago"
        seconds < 3600 -> "${seconds / 60}m ago"
        seconds < 86400 -> "${seconds / 3600}h ago"
        else -> "${seconds / 86400}d ago"
    }
}

private fun hasNotificationPermission(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    return ContextCompat.checkSelfPermission(
        context, Manifest.permission.POST_NOTIFICATIONS
    ) == PackageManager.PERMISSION_GRANTED
}

private fun hasUsageStatsPermission(context: Context): Boolean {
    val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
    val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        appOps.unsafeCheckOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS,
            Process.myUid(),
            context.packageName
        )
    } else {
        @Suppress("DEPRECATION")
        appOps.checkOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS,
            Process.myUid(),
            context.packageName
        )
    }
    return mode == AppOpsManager.MODE_ALLOWED
}

private fun isIgnoringBatteryOptimizations(context: Context): Boolean {
    val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    return pm.isIgnoringBatteryOptimizations(context.packageName)
}

private fun isAccessibilityEnabled(context: Context): Boolean {
    val enabled = Settings.Secure.getString(
        context.contentResolver,
        Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
    ) ?: return false
    val serviceId = "${context.packageName}/${ContentDetectorService::class.java.name}"
    val shortId = "${context.packageName}/.tracker.ContentDetectorService"
    return enabled.contains(serviceId) || enabled.contains(shortId)
}
