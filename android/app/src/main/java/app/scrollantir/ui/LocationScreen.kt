package app.scrollantir.ui

import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.BottomSheetScaffold
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberBottomSheetScaffoldState
import androidx.compose.material3.rememberStandardBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.scrollantir.R
import app.scrollantir.db.AppDatabase
import app.scrollantir.db.EventRow
import app.scrollantir.tracker.ActivityState
import app.scrollantir.tracker.ActivityWatcher
import app.scrollantir.tracker.LocationWatcher
import com.google.android.gms.maps.model.BitmapDescriptor
import com.google.android.gms.maps.model.BitmapDescriptorFactory
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.Dash
import com.google.android.gms.maps.model.Gap
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.LatLngBounds
import com.google.android.gms.maps.model.MapStyleOptions
import com.google.maps.android.compose.CameraPositionState
import com.google.maps.android.compose.GoogleMap
import com.google.maps.android.compose.MapProperties
import com.google.maps.android.compose.MapType
import com.google.maps.android.compose.MapUiSettings
import com.google.maps.android.compose.Marker
import com.google.maps.android.compose.MarkerState
import com.google.maps.android.compose.Polyline
import com.google.maps.android.compose.rememberCameraPositionState
import org.json.JSONObject
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.content.Context
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LocationScreen(
    onBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val dao = remember { AppDatabase.get(context).events() }
    val zone = remember { ZoneId.systemDefault() }

    var selectedDate by remember { mutableStateOf(LocalDate.now(zone)) }
    val dayStartMs = remember(selectedDate, zone) {
        selectedDate.atStartOfDay(zone).toInstant().toEpochMilli()
    }
    val dayEndMs = remember(selectedDate, zone) {
        selectedDate.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
    }
    val startIso = remember(dayStartMs) { Instant.ofEpochMilli(dayStartMs).toString() }
    val endIso = remember(dayEndMs) { Instant.ofEpochMilli(dayEndMs).toString() }
    // 24h lookback for duration rows — catches spans that started before
    // midnight and crossed into this day. Kotlin-side we clip to the
    // [dayStart, dayEnd] window when computing durations / rendering.
    val lookbackIso = remember(dayStartMs) {
        Instant.ofEpochMilli(dayStartMs - 24L * 3600_000L).toString()
    }

    val readings by dao.locationReadingsBetween(startIso, endIso)
        .collectAsState(initial = emptyList())
    val activities by dao.activityStatesSince(lookbackIso, endIso)
        .collectAsState(initial = emptyList())
    val usage by dao.usageOverlappingSince(lookbackIso, endIso)
        .collectAsState(initial = emptyList())
    val inFlight by ActivityWatcher.inFlight.collectAsState()

    // Tick every 30s so the in-flight row's "→ now" duration updates
    // without having to wait for a state change.
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    androidx.compose.runtime.LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(30_000)
            nowMs = System.currentTimeMillis()
        }
    }

    val points = remember(readings) { readings.mapNotNull { it.toLatLngPoint() } }

    val cameraState = rememberCameraPositionState {
        position = CameraPosition.fromLatLngZoom(DEFAULT_CAMERA, 3f)
    }

    // Auto-frame the day's points, but only when the date changes or we get
    // our very first data for a date. Avoids yanking the camera around
    // whenever a single new reading lands on today's list.
    var lastFramedForDate by remember { mutableStateOf<LocalDate?>(null) }
    androidx.compose.runtime.LaunchedEffect(selectedDate, points.isNotEmpty()) {
        if (points.isNotEmpty() && lastFramedForDate != selectedDate) {
            val bounds = buildBounds(points.map { it.latLng })
            val center = LatLng(
                (bounds.northeast.latitude + bounds.southwest.latitude) / 2,
                (bounds.northeast.longitude + bounds.southwest.longitude) / 2
            )
            cameraState.position = CameraPosition.fromLatLngZoom(
                center,
                zoomForBounds(bounds)
            )
            lastFramedForDate = selectedDate
        }
    }

    val sheetState = rememberStandardBottomSheetState(
        initialValue = SheetValue.PartiallyExpanded,
        skipHiddenState = true
    )
    val scaffoldState = rememberBottomSheetScaffoldState(bottomSheetState = sheetState)

    val fineLocGranted = remember {
        LocationWatcher.hasFineLocationPermission(context)
    }

    BottomSheetScaffold(
        scaffoldState = scaffoldState,
        sheetPeekHeight = 260.dp,
        sheetContent = {
            EventSheet(
                date = selectedDate,
                zone = zone,
                activities = activities,
                readings = readings,
                usage = usage,
                inFlight = inFlight,
                nowMs = nowMs,
                isToday = selectedDate == LocalDate.now(zone),
                dayStartMs = dayStartMs,
                dayEndMs = dayEndMs
            )
        },
        topBar = {
            DayNavBar(
                date = selectedDate,
                zone = zone,
                onPrev = { selectedDate = selectedDate.minusDays(1) },
                onNext = { selectedDate = selectedDate.plusDays(1) },
                onBack = onBack
            )
        },
        modifier = modifier.fillMaxSize()
    ) { innerPadding ->
        Box(modifier = Modifier.fillMaxSize().padding(innerPadding)) {
            MapView(
                cameraState = cameraState,
                readings = readings,
                activities = activities,
                zone = zone,
                fineLocGranted = fineLocGranted
            )
            if (points.isEmpty()) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.85f)),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "No readings yet ${if (selectedDate == LocalDate.now(zone)) "today" else "this day"}.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

@Composable
private fun DayNavBar(
    date: LocalDate,
    zone: ZoneId,
    onPrev: () -> Unit,
    onNext: () -> Unit,
    onBack: () -> Unit
) {
    val label = remember(date, zone) {
        val today = LocalDate.now(zone)
        when (date) {
            today -> "Today"
            today.minusDays(1) -> "Yesterday"
            else -> DateTimeFormatter.ofPattern("EEE, MMM d").format(date)
        }
    }
    val canGoNext = date.isBefore(LocalDate.now(zone))

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        IconButton(onClick = onBack) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back"
            )
        }
        Spacer(Modifier.weight(1f))
        IconButton(onClick = onPrev) {
            Icon(Icons.Filled.ChevronLeft, contentDescription = "Previous day")
        }
        Text(
            text = label,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Medium
        )
        IconButton(onClick = onNext, enabled = canGoNext) {
            Icon(Icons.Filled.ChevronRight, contentDescription = "Next day")
        }
        Spacer(Modifier.weight(1f))
        // Balance the back-button width so the date label stays centered.
        Spacer(Modifier.width(48.dp))
    }
}

@Composable
private fun MapView(
    cameraState: CameraPositionState,
    readings: List<EventRow>,
    activities: List<EventRow>,
    zone: ZoneId,
    fineLocGranted: Boolean
) {
    val context = LocalContext.current
    val density = LocalDensity.current

    val uiSettings = remember {
        MapUiSettings(
            zoomControlsEnabled = false,
            compassEnabled = true,
            myLocationButtonEnabled = false,
            mapToolbarEnabled = false
        )
    }

    // Always dark — resource styling applied via MapStyleOptions. Ignoring
    // system theme per Josh's preference.
    val mapProperties = remember(fineLocGranted) {
        MapProperties(
            mapType = MapType.NORMAL,
            mapStyleOptions = runCatching {
                MapStyleOptions.loadRawResourceStyle(context, R.raw.maps_night)
            }.getOrNull(),
            isMyLocationEnabled = fineLocGranted
        )
    }

    // One small colored dot per activity state, cached.
    val dotFor = remember(density) {
        val cache = mutableMapOf<ActivityState, BitmapDescriptor>()
        val dotPx = with(density) { 14.dp.toPx() }.toInt().coerceAtLeast(8);
        ({ state: ActivityState ->
            cache.getOrPut(state) { buildDotIcon(colorFor(state), dotPx) }
        })
    }

    val points = readings.mapNotNull { it.toLatLngPoint() }

    // Cluster readings into ~10m cells so you don't see 20 dots stacked at
    // your dorm and, with Tier 2 enabled, readings that are within 10m get
    // visually coalesced. Display-only — full precision is preserved in
    // the underlying readings and on the wire.
    val clusters = remember(points, activities) { clusterByCoords(points, activities) }

    GoogleMap(
        modifier = Modifier.fillMaxSize(),
        cameraPositionState = cameraState,
        uiSettings = uiSettings,
        properties = mapProperties
    ) {
        for (i in 0 until points.size - 1) {
            val a = points[i]
            val b = points[i + 1]
            if (a.latLng == b.latLng) continue // skip zero-length segments
            val midMs = (a.timeMs + b.timeMs) / 2
            val state = activityAt(activities, midMs)
            Polyline(
                points = listOf(a.latLng, b.latLng),
                color = colorFor(state),
                width = 8f,
                pattern = listOf(Dash(20f), Gap(15f))
            )
        }

        clusters.forEach { cluster ->
            val snippet = if (cluster.count > 1) {
                "${cluster.state.wireName} · ${cluster.count} readings · ±${cluster.accuracyM}m"
            } else {
                "${cluster.state.wireName} · ±${cluster.accuracyM}m"
            }
            Marker(
                state = MarkerState(position = cluster.latLng),
                icon = dotFor(cluster.state),
                anchor = androidx.compose.ui.geometry.Offset(0.5f, 0.5f),
                title = formatClock(cluster.lastMs, zone),
                snippet = snippet
            )
        }
    }
}

@Composable
private fun EventSheet(
    date: LocalDate,
    zone: ZoneId,
    activities: List<EventRow>,
    readings: List<EventRow>,
    usage: List<EventRow>,
    inFlight: ActivityWatcher.Companion.InFlight?,
    nowMs: Long,
    isToday: Boolean,
    dayStartMs: Long,
    dayEndMs: Long
) {
    val items = remember(activities, inFlight, nowMs, isToday, dayStartMs, dayEndMs) {
        buildItems(activities, inFlight, nowMs, isToday, dayStartMs, dayEndMs)
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
    ) {
        ActivityLegend()
        Spacer(Modifier.height(10.dp))
        Text(
            text = "Events · ${items.size}",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(8.dp))

        if (items.isEmpty()) {
            Text(
                text = "Nothing recorded.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            return@Column
        }

        LazyColumn {
            items(items = items, key = { it.key }) { item ->
                SheetRow(item = item, zone = zone, usage = usage)
            }
        }
    }
}

@Composable
private fun SheetRow(item: SheetItem, zone: ZoneId, usage: List<EventRow>) {
    var expanded by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded }
            .padding(vertical = 8.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(10.dp)
                    .clip(CircleShape)
                    .background(item.dotColor)
            )
            Spacer(Modifier.width(10.dp))
            Text(
                text = item.title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.weight(1f)
            )
            Text(
                text = item.timeLabel(zone),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        item.subtitle?.let {
            Spacer(Modifier.height(2.dp))
            Text(
                text = it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 20.dp)
            )
        }
        AnimatedVisibility(expanded) {
            val overlapping = remember(item.key, usage) {
                item.overlappingUsage(usage)
            }
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 20.dp, top = 6.dp, bottom = 2.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp)
            ) {
                if (overlapping.isEmpty()) {
                    Text(
                        text = "No app usage during this window.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                } else {
                    overlapping.take(12).forEach { u ->
                        Text(
                            text = formatUsageLine(u, zone),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    if (overlapping.size > 12) {
                        Text(
                            text = "+${overlapping.size - 12} more",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ActivityLegend() {
    val entries = listOf(
        ActivityState.STILL to "Still",
        ActivityState.WALKING to "Walk",
        ActivityState.RUNNING to "Run",
        ActivityState.ON_BICYCLE to "Bike",
        ActivityState.IN_VEHICLE to "Vehicle",
        ActivityState.UNKNOWN to "Unknown"
    )
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        entries.forEach { (state, label) ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(colorFor(state))
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

// --- Data shaping ---

private data class MapCluster(
    val latLng: LatLng,
    val state: ActivityState,
    val count: Int,
    val lastMs: Long,
    val accuracyM: Int
)

private fun clusterByCoords(
    points: List<LatLngPoint>,
    activities: List<EventRow>
): List<MapCluster> {
    if (points.isEmpty()) return emptyList()
    // Group by lat/lng snapped to 4 decimals (~10m cells). Points themselves
    // remain at raw precision for marker placement accuracy; only the
    // grouping key is snapped.
    fun snap(v: Double): Double = kotlin.math.round(v * 10_000.0) / 10_000.0
    val byCell = points.groupBy { snap(it.latLng.latitude) to snap(it.latLng.longitude) }
    return byCell.map { (_, list) ->
        val sorted = list.sortedBy { it.timeMs }
        val last = sorted.last()
        val state = activityAt(activities, last.timeMs)
        MapCluster(
            latLng = last.latLng,
            state = state,
            count = list.size,
            lastMs = last.timeMs,
            accuracyM = list.minOf { it.accuracyM.coerceAtLeast(0) }
        )
    }
}

private fun buildDotIcon(color: Color, sizePx: Int): BitmapDescriptor {
    val bitmap = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val fill = Paint().apply {
        isAntiAlias = true
        style = Paint.Style.FILL
        this.color = color.toArgb()
    }
    val stroke = Paint().apply {
        isAntiAlias = true
        style = Paint.Style.STROKE
        strokeWidth = 2f
        this.color = android.graphics.Color.WHITE
    }
    val r = sizePx / 2f
    canvas.drawCircle(r, r, r - 1.5f, fill)
    canvas.drawCircle(r, r, r - 1.5f, stroke)
    return BitmapDescriptorFactory.fromBitmap(bitmap)
}


private data class LatLngPoint(
    val latLng: LatLng,
    val timeMs: Long,
    val accuracyM: Int
)

private fun EventRow.toLatLngPoint(): LatLngPoint? {
    return try {
        val obj = JSONObject(dataJson)
        val lat = obj.getDouble("lat")
        val lng = obj.getDouble("lng")
        val acc = obj.optInt("accuracy_m", -1)
        LatLngPoint(
            latLng = LatLng(lat, lng),
            timeMs = Instant.parse(timestampUtc).toEpochMilli(),
            accuracyM = acc
        )
    } catch (_: Throwable) {
        null
    }
}

private data class SheetItem(
    val key: String,
    val title: String,
    val subtitle: String?,
    val startMs: Long,
    val endMs: Long,
    val dotColor: Color
) {
    fun timeLabel(zone: ZoneId): String {
        val startStr = formatClock(startMs, zone)
        return if (endMs > startMs) "$startStr – ${formatClock(endMs, zone)}" else startStr
    }

    fun overlappingUsage(usage: List<EventRow>): List<EventRow> {
        return usage.filter { row ->
            val rowStart = Instant.parse(row.timestampUtc).toEpochMilli()
            val rowEnd = rowStart + (row.durationS * 1000).toLong()
            rowEnd > startMs && rowStart < endMs
        }
    }
}

private fun buildItems(
    activities: List<EventRow>,
    inFlight: ActivityWatcher.Companion.InFlight?,
    nowMs: Long,
    isToday: Boolean,
    dayStartMs: Long,
    dayEndMs: Long
): List<SheetItem> {
    // Location readings are raw GPS samples triggered at activity
    // transitions. They carry no narrative the activity rows don't already
    // show, so we keep them on the map (as dots) and off the event list.
    // Activity rows are fetched with a 24h lookback — we clip each row's
    // visible span to the day window and drop anything that ended before
    // day start.
    val completed = activities.mapNotNull { row ->
        val rawStart = Instant.parse(row.timestampUtc).toEpochMilli()
        val rawEnd = rawStart + (row.durationS * 1000).toLong()
        if (rawEnd <= dayStartMs) return@mapNotNull null
        if (rawStart >= dayEndMs) return@mapNotNull null
        val clippedStart = maxOf(rawStart, dayStartMs)
        val clippedEnd = minOf(rawEnd, dayEndMs)
        val state = try {
            ActivityState.fromWireName(JSONObject(row.dataJson).optString("state"))
        } catch (_: Throwable) {
            ActivityState.UNKNOWN
        }
        SheetItem(
            key = "a-${row.id}",
            title = titleFor(state),
            subtitle = durationLabel(clippedEnd - clippedStart),
            startMs = clippedStart,
            endMs = clippedEnd,
            dotColor = colorFor(state)
        )
    }

    // Prepend an in-flight row when we're looking at today and have an
    // active span. "→ now" with a live duration that refreshes on tick.
    val live = if (isToday && inFlight != null) {
        val dur = durationLabel(nowMs - inFlight.startedAtMs) ?: "just now"
        SheetItem(
            key = "inflight-${inFlight.startedAtMs}",
            title = "${titleFor(inFlight.state)} · now",
            subtitle = "$dur so far",
            startMs = inFlight.startedAtMs,
            endMs = nowMs,
            dotColor = colorFor(inFlight.state)
        )
    } else null

    val all = completed.toMutableList()
    if (live != null) all += live
    return all.sortedByDescending { it.startMs }
}

private fun titleFor(state: ActivityState): String = when (state) {
    ActivityState.STILL -> "Still"
    ActivityState.WALKING -> "Walking"
    ActivityState.RUNNING -> "Running"
    ActivityState.ON_BICYCLE -> "Bicycle"
    ActivityState.IN_VEHICLE -> "In vehicle"
    ActivityState.UNKNOWN -> "Unknown"
}

// Stable palette for activity states.
private fun colorFor(state: ActivityState): Color = when (state) {
    ActivityState.STILL -> Color(0xFF9CA3AF)     // gray-400
    ActivityState.WALKING -> Color(0xFF22C55E)   // green-500
    ActivityState.RUNNING -> Color(0xFF16A34A)   // green-600
    ActivityState.ON_BICYCLE -> Color(0xFF3B82F6) // blue-500
    ActivityState.IN_VEHICLE -> Color(0xFFF97316) // orange-500
    ActivityState.UNKNOWN -> Color(0xFFD1D5DB)   // gray-300
}

private fun activityAt(activities: List<EventRow>, atMs: Long): ActivityState {
    // Most-recent activity-state row whose [start, start+dur] straddles atMs,
    // or whose start ≤ atMs (accepting that the span might have closed just
    // before atMs if it's the last row we have).
    val row = activities.lastOrNull { row ->
        val start = Instant.parse(row.timestampUtc).toEpochMilli()
        val end = start + (row.durationS * 1000).toLong()
        start <= atMs && atMs <= end + 60_000 // 1min grace past span close
    } ?: return ActivityState.UNKNOWN
    return try {
        ActivityState.fromWireName(JSONObject(row.dataJson).optString("state"))
    } catch (_: Throwable) {
        ActivityState.UNKNOWN
    }
}

private fun durationLabel(millis: Long): String? {
    if (millis <= 0) return null
    val s = millis / 1000
    return when {
        s < 60 -> "${s}s"
        s < 3600 -> "${s / 60}m"
        else -> "${s / 3600}h ${(s % 3600) / 60}m"
    }
}

private fun formatClock(ms: Long, zone: ZoneId): String {
    // 12-hour with AM/PM, no leading zero on the hour (e.g., "2:35 PM").
    return DateTimeFormatter.ofPattern("h:mm a")
        .withZone(zone)
        .format(Instant.ofEpochMilli(ms))
}

private fun formatUsageLine(row: EventRow, zone: ZoneId): String {
    val start = Instant.parse(row.timestampUtc).toEpochMilli()
    val clock = formatClock(start, zone)
    val label = try {
        val obj = JSONObject(row.dataJson)
        when {
            row.source == "system.foreground" -> obj.optString("app_label")
                .ifBlank { obj.optString("app") }
            else -> row.source
        }
    } catch (_: Throwable) {
        row.source
    }
    val durLabel = durationLabel((row.durationS * 1000).toLong())?.let { " · $it" } ?: ""
    return "$clock  $label$durLabel"
}

private fun buildBounds(points: List<LatLng>): LatLngBounds {
    val builder = LatLngBounds.Builder()
    points.forEach { builder.include(it) }
    return builder.build()
}

private fun zoomForBounds(bounds: LatLngBounds): Float {
    // Rough estimate; Google's FitToBounds would be exact, but we can't invoke
    // it from a Composable side-effect without a MapView handle. Span-based
    // heuristic is close enough for initial framing.
    val latSpan = bounds.northeast.latitude - bounds.southwest.latitude
    val lngSpan = bounds.northeast.longitude - bounds.southwest.longitude
    val span = maxOf(latSpan, lngSpan)
    return when {
        span < 0.005 -> 16f
        span < 0.02 -> 14f
        span < 0.1 -> 12f
        span < 0.5 -> 10f
        span < 2.0 -> 8f
        else -> 5f
    }
}

private val DEFAULT_CAMERA = LatLng(0.0, 0.0)
