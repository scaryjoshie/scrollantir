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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import app.scrollantir.db.EventRow
import app.scrollantir.db.ModeTotal
import app.scrollantir.tracker.TrackerForegroundService
import app.scrollantir.tracker.UsageStatsPoller
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

@Composable
fun TodayScreen(
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val dao = remember { AppDatabase.get(context).events() }

    val startOfDayMs = remember {
        LocalDate.now(ZoneId.systemDefault())
            .atStartOfDay(ZoneId.systemDefault())
            .toInstant()
            .toEpochMilli()
    }
    // Look back 24h before today_start so a session that began before midnight
    // is still available for day-boundary clipping.
    val lookbackIso = remember {
        Instant.ofEpochMilli(startOfDayMs - 24 * 3600 * 1000)
            .toString()
    }
    val startOfDayIso = remember {
        Instant.ofEpochMilli(startOfDayMs).toString()
    }

    // "Now" tick — advances every 10s so the live current-session tile and
    // the clipping upper-bound keep moving.
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(10_000)
            nowMs = System.currentTimeMillis()
        }
    }

    val running by TrackerForegroundService.running.collectAsState()
    val current by UsageStatsPoller.currentForeground.collectAsState()
    val foregroundEvents by dao.foregroundEventsSince(lookbackIso)
        .collectAsState(initial = emptyList())
    val modeEvents by dao.contentModeEventsSince(lookbackIso)
        .collectAsState(initial = emptyList())
    val unlockCount by dao.unlockCountSince(startOfDayIso).collectAsState(initial = 0)

    // Day-clip every session to [startOfDay, now], then group + sum + filter noise.
    // Also fold in the current in-flight foreground session (not yet in DB)
    // so the Today view reflects what's happening RIGHT NOW.
    val signalApps = remember(foregroundEvents, startOfDayMs, nowMs, current) {
        aggregateAppsClipped(
            events = foregroundEvents,
            inflight = current,
            windowStartMs = startOfDayMs,
            windowEndMs = nowMs
        ).let(EventFilter::filterAppTotals)
    }
    val modeTotals = remember(modeEvents, startOfDayMs, nowMs) {
        aggregateModesClipped(
            events = modeEvents,
            windowStartMs = startOfDayMs,
            windowEndMs = nowMs
        )
    }

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
            Spacer(Modifier.width(4.dp))
            IconButton(onClick = onOpenSettings) {
                Icon(
                    imageVector = Icons.Filled.Settings,
                    contentDescription = "Settings"
                )
            }
        }

        SummaryRow(
            totalSeconds = signalApps.sumOf { it.totalS },
            unlocks = unlockCount
        )

        current?.let { live ->
            CurrentSessionTile(pkg = live.pkg, startedAtMs = live.startedAtMs)
        }

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

@Composable
private fun CurrentSessionTile(pkg: String, startedAtMs: Long) {
    // Own 1s ticker so the elapsed time is always computed against a
    // fresh System.currentTimeMillis(), independent of the outer 10s tick
    // driving aggregation. Avoids negative-elapsed flashes right after
    // an app switch.
    var tickMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(pkg) {
        while (true) {
            delay(1000)
            tickMs = System.currentTimeMillis()
        }
    }
    val elapsedMs = (tickMs - startedAtMs).coerceAtLeast(0L)

    val (icon, label) = AppIconCache.rememberAppInfo(pkg)
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (icon != null) {
                androidx.compose.foundation.Image(
                    bitmap = icon,
                    contentDescription = null,
                    modifier = Modifier.size(28.dp).clip(androidx.compose.foundation.shape.RoundedCornerShape(7.dp)),
                    contentScale = androidx.compose.ui.layout.ContentScale.Crop
                )
            } else {
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .background(
                            MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
                            androidx.compose.foundation.shape.RoundedCornerShape(7.dp)
                        )
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "Now",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )
                Text(
                    text = label,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )
            }
            Text(
                text = humanDuration(elapsedMs / 1000.0),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onPrimaryContainer
            )
        }
    }
}

/**
 * Sum foreground-session time per app, clipped to [windowStart, windowEnd].
 * Folds in the in-flight session (from UsageStatsPoller.currentForeground)
 * since it's not yet in the DB.
 */
private fun aggregateAppsClipped(
    events: List<EventRow>,
    inflight: UsageStatsPoller.CurrentForeground?,
    windowStartMs: Long,
    windowEndMs: Long
): List<AppTotal> {
    data class Acc(var totalS: Double = 0.0, var count: Int = 0)
    val totals = mutableMapOf<String, Acc>()

    fun add(pkg: String, startMs: Long, endMs: Long) {
        val clipStart = maxOf(startMs, windowStartMs)
        val clipEnd = minOf(endMs, windowEndMs)
        if (clipEnd <= clipStart) return
        val acc = totals.getOrPut(pkg) { Acc() }
        acc.totalS += (clipEnd - clipStart) / 1000.0
        acc.count++
    }

    for (e in events) {
        val pkg = EventFilter.extractApp(e.dataJson) ?: continue
        val start = parseInstantMillis(e.timestampUtc) ?: continue
        val end = start + (e.durationS * 1000).toLong()
        add(pkg, start, end)
    }
    inflight?.let { add(it.pkg, it.startedAtMs, windowEndMs) }

    return totals.entries
        .map { (pkg, acc) -> AppTotal(pkg, acc.totalS, acc.count) }
        .sortedByDescending { it.totalS }
}

/** Same clipping logic for content-mode sources. No in-flight fold — the
 *  detector already emits modes on transition; a live one that started
 *  before window start is rare and the 24h lookback picks it up. */
private fun aggregateModesClipped(
    events: List<EventRow>,
    windowStartMs: Long,
    windowEndMs: Long
): List<ModeTotal> {
    val totals = mutableMapOf<String, Double>()
    for (e in events) {
        val start = parseInstantMillis(e.timestampUtc) ?: continue
        val end = start + (e.durationS * 1000).toLong()
        val clipStart = maxOf(start, windowStartMs)
        val clipEnd = minOf(end, windowEndMs)
        if (clipEnd <= clipStart) continue
        totals[e.source] = (totals[e.source] ?: 0.0) + (clipEnd - clipStart) / 1000.0
    }
    return totals.entries
        .map { (source, totalS) -> ModeTotal(source, totalS) }
        .sortedByDescending { it.totalS }
}

private fun parseInstantMillis(iso: String): Long? =
    try { Instant.parse(iso).toEpochMilli() } catch (_: Throwable) { null }
