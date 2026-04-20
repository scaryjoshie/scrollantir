package app.scrollantir.ui

import androidx.compose.foundation.Image
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.scrollantir.db.AppDatabase
import app.scrollantir.db.AppTotal
import app.scrollantir.db.ModeTotal
import app.scrollantir.tracker.TrackerForegroundService
import java.time.LocalDate
import java.time.ZoneId

@Composable
fun TodayScreen(
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val dao = remember { AppDatabase.get(context).events() }

    val startOfDayIso = remember {
        LocalDate.now(ZoneId.systemDefault())
            .atStartOfDay(ZoneId.systemDefault())
            .toInstant()
            .toString()
    }

    val running by TrackerForegroundService.running.collectAsState()
    val appTotals by dao.foregroundTotalsSince(startOfDayIso).collectAsState(initial = emptyList())
    val modeTotals by dao.contentModeTotalsSince(startOfDayIso).collectAsState(initial = emptyList())
    val unlockCount by dao.unlockCountSince(startOfDayIso).collectAsState(initial = 0)

    val signalApps = remember(appTotals) { EventFilter.filterAppTotals(appTotals) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = "Today",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f)
            )
            StatusPill(running = running)
            Spacer(Modifier.width(8.dp))
            TextButton(onClick = onOpenSettings) {
                Text("Settings")
            }
        }

        SummaryRow(
            totalSeconds = signalApps.sumOf { it.totalS },
            unlocks = unlockCount
        )

        if (modeTotals.isNotEmpty()) {
            ContentModesCard(modes = modeTotals)
        }

        AppTotalsCard(apps = signalApps)
    }
}

@Composable
private fun StatusPill(running: Boolean) {
    Box(
        modifier = Modifier
            .size(10.dp)
            .background(
                color = if (running) Color(0xFF22C55E) else MaterialTheme.colorScheme.outline,
                shape = CircleShape
            )
    )
}

@Composable
private fun SummaryRow(totalSeconds: Double, unlocks: Int) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        SummaryTile(
            label = "Phone time",
            value = humanDuration(totalSeconds),
            modifier = Modifier.weight(1f)
        )
        SummaryTile(
            label = "Unlocks",
            value = "$unlocks",
            modifier = Modifier.weight(1f)
        )
    }
}

@Composable
private fun SummaryTile(label: String, value: String, modifier: Modifier = Modifier) {
    Card(
        modifier = modifier,
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerHigh
        )
    ) {
        Column(
            modifier = Modifier.padding(14.dp)
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = value,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold
            )
        }
    }
}

@Composable
private fun ContentModesCard(modes: List<ModeTotal>) {
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
                text = "Short-form",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            modes.forEach { m ->
                ModeRow(m)
            }
        }
    }
}

@Composable
private fun ModeRow(m: ModeTotal) {
    val parentPkg = EventFilter.parentAppForMode(m.source)
    val (icon, _) = if (parentPkg != null) AppIconCache.rememberAppInfo(parentPkg) else (null to "")
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (icon != null) {
            Image(
                bitmap = icon,
                contentDescription = null,
                modifier = Modifier.size(24.dp).clip(RoundedCornerShape(6.dp)),
                contentScale = ContentScale.Crop
            )
        } else {
            Box(
                modifier = Modifier
                    .size(24.dp)
                    .background(MaterialTheme.colorScheme.outline, RoundedCornerShape(6.dp))
            )
        }
        Spacer(Modifier.width(12.dp))
        Text(
            text = EventFilter.humanizeMode(m.source),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f)
        )
        Text(
            text = humanDuration(m.totalS),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium
        )
    }
}

@Composable
private fun AppTotalsCard(apps: List<AppTotal>) {
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
                text = "Apps",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (apps.isEmpty()) {
                Text(
                    text = "No app activity yet today.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                val maxTotal = apps.first().totalS.coerceAtLeast(1.0)
                apps.forEach { a ->
                    AppRow(app = a, maxTotal = maxTotal)
                }
            }
        }
    }
}

@Composable
private fun AppRow(app: AppTotal, maxTotal: Double) {
    val (icon, label) = AppIconCache.rememberAppInfo(app.app)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (icon != null) {
                Image(
                    bitmap = icon,
                    contentDescription = null,
                    modifier = Modifier.size(28.dp).clip(RoundedCornerShape(7.dp)),
                    contentScale = ContentScale.Crop
                )
            } else {
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .background(
                            MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
                            RoundedCornerShape(7.dp)
                        )
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium
                )
                Text(
                    text = "${app.sessionCount} session${if (app.sessionCount == 1) "" else "s"}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Text(
                text = humanDuration(app.totalS),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold
            )
        }
        // Thin bar viz
        val fraction = (app.totalS / maxTotal).coerceIn(0.0, 1.0).toFloat()
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(3.dp)
                .background(
                    MaterialTheme.colorScheme.outline.copy(alpha = 0.15f),
                    RoundedCornerShape(1.5.dp)
                )
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(fraction)
                    .height(3.dp)
                    .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(1.5.dp))
            )
        }
    }
}

fun humanDuration(s: Double): String {
    val total = s.toLong()
    val h = total / 3600
    val m = (total % 3600) / 60
    val sec = total % 60
    return when {
        h >= 1 -> "${h}h ${m}m"
        m >= 1 -> "${m}m ${sec}s"
        else -> "${sec}s"
    }
}
