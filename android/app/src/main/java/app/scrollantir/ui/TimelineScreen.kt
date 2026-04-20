package app.scrollantir.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.scrollantir.db.AppDatabase
import app.scrollantir.db.EventRow
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private const val DAY_MS = 24L * 3600 * 1000
private val HOUR_LABEL_WIDTH = 44.dp

private const val MIN_DP_PER_MIN = 0.5f
private const val MAX_DP_PER_MIN = 8f
private const val DEFAULT_DP_PER_MIN = 2f

/**
 * Visualizes today's foreground sessions as colored blocks stacked top-to-bottom.
 *
 * - Y axis: time of day, 0:00 at top, 24:00 at bottom.
 * - Block height: duration of that session (clipped to today).
 * - Block color: stable hash of package name.
 * - Red horizontal line: "now".
 * - Tap any block to open a details sheet.
 * - Zoom in/out icons scale dp/minute between [0.5, 8].
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimelineScreen(
    onBack: () -> Unit,
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
    val lookbackIso = remember {
        Instant.ofEpochMilli(startOfDayMs - DAY_MS).toString()
    }

    val foregroundEvents by dao.foregroundEventsSince(lookbackIso)
        .collectAsState(initial = emptyList())

    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(10_000)
            nowMs = System.currentTimeMillis()
        }
    }

    // dp per minute. DEFAULT is starting point; zoom in goes up, out goes down.
    var dpPerMin by remember { mutableFloatStateOf(DEFAULT_DP_PER_MIN) }
    // Pending scrollTo value applied by a LaunchedEffect, so zoom handlers
    // can request a scroll target that takes effect after the new height
    // has been laid out.
    var pendingScrollPx by remember { mutableStateOf<Int?>(null) }

    val blocks = remember(foregroundEvents, startOfDayMs, nowMs) {
        buildBlocks(foregroundEvents, startOfDayMs, nowMs)
    }

    var selected by remember { mutableStateOf<TimelineBlock?>(null) }

    val scrollState = rememberScrollState()
    val density = LocalDensity.current

    // Scroll to "now" on first render at the initial zoom.
    LaunchedEffect(Unit) {
        val nowMinute = ((System.currentTimeMillis() - startOfDayMs) / 60_000f)
        val targetPx = with(density) { (nowMinute * DEFAULT_DP_PER_MIN).dp.toPx() } - 400f
        scrollState.scrollTo(targetPx.toInt().coerceAtLeast(0))
    }

    LaunchedEffect(pendingScrollPx) {
        pendingScrollPx?.let {
            scrollState.scrollTo(it)
            pendingScrollPx = null
        }
    }

    val hourHeightDp = (dpPerMin * 60).dp
    val timelineHeightDp = hourHeightDp * 24

    Column(
        modifier = modifier
            .fillMaxSize()
    ) {
        // Header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
            Spacer(Modifier.width(4.dp))
            Text(
                text = "Timeline",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f)
            )
            Text(
                text = "Pinch to zoom",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(end = 12.dp)
            )
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(scrollState)
                .pointerInput(Unit) {
                    // Pinch zoom. detectTransformGestures only fires on
                    // multi-pointer gestures, so single-finger drags still
                    // flow through to verticalScroll naturally.
                    detectTransformGestures { centroid, _, zoom, _ ->
                        if (zoom == 1f) return@detectTransformGestures
                        val currentPxPerMin = dpPerMin.dp.toPx()
                        // Time-of-day currently under the centroid:
                        val centroidMinute =
                            (scrollState.value + centroid.y) / currentPxPerMin
                        val newDpPerMin = (dpPerMin * zoom)
                            .coerceIn(MIN_DP_PER_MIN, MAX_DP_PER_MIN)
                        if (newDpPerMin == dpPerMin) return@detectTransformGestures
                        dpPerMin = newDpPerMin
                        // Rescroll so the centroid-minute stays under the
                        // user's fingers at the new scale.
                        val newPxPerMin = newDpPerMin.dp.toPx()
                        pendingScrollPx =
                            (centroidMinute * newPxPerMin - centroid.y)
                                .toInt()
                                .coerceAtLeast(0)
                    }
                }
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(timelineHeightDp)
            ) {
                HourLabels(hourHeightDp = hourHeightDp)
                Spacer(Modifier.width(6.dp))
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(end = 12.dp)
                ) {
                    // Hour grid lines
                    for (h in 0..23) {
                        Box(
                            modifier = Modifier
                                .offset(y = hourHeightDp * h)
                                .fillMaxWidth()
                                .height(1.dp)
                                .background(MaterialTheme.colorScheme.outline.copy(alpha = 0.12f))
                        )
                    }
                    // Event blocks
                    blocks.forEach { b ->
                        TimelineBlockBox(
                            block = b,
                            dpPerMin = dpPerMin,
                            onClick = { selected = b }
                        )
                    }
                    // "Now" line
                    val nowOffsetMin = ((nowMs - startOfDayMs).coerceAtLeast(0) / 60_000f)
                    Box(
                        modifier = Modifier
                            .offset(y = (nowOffsetMin * dpPerMin).dp)
                            .fillMaxWidth()
                            .height(2.dp)
                            .background(Color(0xFFEF4444))
                    )
                }
            }
        }
    }

    // Details sheet
    selected?.let { block ->
        val sheetState = rememberModalBottomSheetState()
        ModalBottomSheet(
            onDismissRequest = { selected = null },
            sheetState = sheetState,
            dragHandle = { BottomSheetDefaults.DragHandle() }
        ) {
            BlockDetails(block = block)
            Spacer(Modifier.height(32.dp))
        }
    }
}

@Composable
private fun HourLabels(hourHeightDp: androidx.compose.ui.unit.Dp) {
    Column(
        modifier = Modifier
            .width(HOUR_LABEL_WIDTH)
            .fillMaxSize()
    ) {
        for (h in 0..23) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(hourHeightDp),
                contentAlignment = Alignment.TopEnd
            ) {
                Text(
                    text = formatHour(h),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(end = 6.dp)
                )
            }
        }
    }
}

@Composable
private fun TimelineBlockBox(
    block: TimelineBlock,
    dpPerMin: Float,
    onClick: () -> Unit
) {
    val topDp = (block.startOfDayOffsetMinutes * dpPerMin).dp
    val heightDp = (block.durationMinutes * dpPerMin).dp.coerceAtLeast(2.dp)

    Box(
        modifier = Modifier
            .offset(y = topDp)
            .fillMaxWidth()
            .height(heightDp)
            .padding(vertical = 0.5.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(block.color)
            .clickable(onClick = onClick)
    ) {
        if (heightDp >= 14.dp) {
            Text(
                text = block.label,
                style = MaterialTheme.typography.labelSmall,
                color = block.textColor,
                modifier = Modifier
                    .padding(horizontal = 6.dp, vertical = 1.dp),
                maxLines = 1,
                fontWeight = FontWeight.Medium
            )
        }
    }
}

@Composable
private fun BlockDetails(block: TimelineBlock) {
    val (icon, _) = AppIconCache.rememberAppInfo(block.pkg)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (icon != null) {
            Image(
                bitmap = icon,
                contentDescription = null,
                modifier = Modifier.size(36.dp).clip(RoundedCornerShape(8.dp)),
                contentScale = ContentScale.Crop
            )
        } else {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .background(block.color, RoundedCornerShape(8.dp))
            )
        }
        Spacer(Modifier.width(16.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = block.label,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = block.pkg,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        DetailLine(label = "Start", value = formatTimeOfDay(block.startMs))
        DetailLine(label = "End", value = formatTimeOfDay(block.endMs))
        DetailLine(label = "Duration", value = humanDuration(block.durationMinutes * 60.0))
    }
}

@Composable
private fun DetailLine(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(100.dp)
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium
        )
    }
}

// ------- data model + builder -------

private data class TimelineBlock(
    val pkg: String,
    val label: String,
    val startMs: Long,
    val endMs: Long,
    val startOfDayOffsetMinutes: Float,
    val durationMinutes: Float,
    val color: Color,
    val textColor: Color
)

private fun buildBlocks(
    events: List<EventRow>,
    startOfDayMs: Long,
    nowMs: Long
): List<TimelineBlock> {
    val endOfDayMs = startOfDayMs + DAY_MS
    val out = mutableListOf<TimelineBlock>()
    for (e in events) {
        val pkg = EventFilter.extractApp(e.dataJson) ?: continue
        if (!EventFilter.isSignalApp(pkg)) continue
        val rawStart = try { Instant.parse(e.timestampUtc).toEpochMilli() }
            catch (_: Throwable) { continue }
        val rawEnd = rawStart + (e.durationS * 1000).toLong()
        val clipStart = maxOf(rawStart, startOfDayMs)
        val clipEnd = minOf(rawEnd, minOf(endOfDayMs, nowMs))
        if (clipEnd <= clipStart) continue
        val color = colorForPackage(pkg)
        out.add(
            TimelineBlock(
                pkg = pkg,
                label = humanizePackage(pkg),
                startMs = clipStart,
                endMs = clipEnd,
                startOfDayOffsetMinutes = (clipStart - startOfDayMs) / 60_000f,
                durationMinutes = (clipEnd - clipStart) / 60_000f,
                color = color,
                textColor = readableOn(color)
            )
        )
    }
    return out
}

private fun colorForPackage(pkg: String): Color {
    var h = 0
    for (c in pkg) h = (h * 31 + c.code) and 0x7FFFFFFF
    val hue = (h % 360).toFloat()
    return hslToColor(hue, sat = 0.55f, light = 0.55f)
}

private fun hslToColor(h: Float, sat: Float, light: Float): Color {
    val c = (1f - kotlin.math.abs(2f * light - 1f)) * sat
    val hp = h / 60f
    val x = c * (1f - kotlin.math.abs(hp % 2f - 1f))
    val (r1, g1, b1) = when {
        hp < 1f -> Triple(c, x, 0f)
        hp < 2f -> Triple(x, c, 0f)
        hp < 3f -> Triple(0f, c, x)
        hp < 4f -> Triple(0f, x, c)
        hp < 5f -> Triple(x, 0f, c)
        else -> Triple(c, 0f, x)
    }
    val m = light - c / 2f
    return Color(r1 + m, g1 + m, b1 + m, 1f)
}

private fun readableOn(bg: Color): Color {
    val luminance = 0.299f * bg.red + 0.587f * bg.green + 0.114f * bg.blue
    return if (luminance > 0.55f) Color(0xDE000000) else Color(0xFFFFFFFF)
}

private fun humanizePackage(pkg: String): String {
    val last = pkg.substringAfterLast('.')
    return last.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
}

private fun formatHour(h: Int): String {
    return when {
        h == 0 -> "12a"
        h < 12 -> "${h}a"
        h == 12 -> "12p"
        else -> "${h - 12}p"
    }
}

private fun formatTimeOfDay(ms: Long): String {
    return DateTimeFormatter.ofPattern("HH:mm:ss")
        .withZone(ZoneId.systemDefault())
        .format(Instant.ofEpochMilli(ms))
}
