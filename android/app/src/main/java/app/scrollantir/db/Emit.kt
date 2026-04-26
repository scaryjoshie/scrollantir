package app.scrollantir.db

import app.scrollantir.net.DeviceId
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

suspend fun emit(
    dao: EventDao,
    source: String,
    start: Instant = Instant.now(),
    durationS: Double = 0.0,
    data: Map<String, Any> = emptyMap()
) {
    val json = JSONObject().apply { data.forEach { (k, v) -> put(k, v) } }
    dao.insert(
        EventRow(
            id = UUID.randomUUID().toString(),
            device = DeviceId.current(),
            source = source,
            timestampUtc = start.toString(),
            durationS = durationS,
            dataJson = json.toString()
        )
    )
}
