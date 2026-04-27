package app.scrollantir.db

import app.scrollantir.net.DeviceId
import org.json.JSONArray
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
    dao.insert(
        EventRow(
            id = UUID.randomUUID().toString(),
            device = DeviceId.current(),
            source = source,
            timestampUtc = start.toString(),
            durationS = durationS,
            dataJson = toJsonObject(data).toString()
        )
    )
}

/**
 * Recursively wrap Kotlin Lists/Maps as JSONArray/JSONObject so they
 * serialise as real JSON structures instead of `Object.toString()`
 * fallbacks. Without this, a `Map(view_ids -> List<String>)` ends up
 * stored as `{"view_ids":"[a, b, c]"}` (a string) instead of
 * `{"view_ids":["a","b","c"]}` — which silently broke
 * `data->'view_ids'` JSON queries against the events table.
 */
private fun toJsonObject(map: Map<String, Any>): JSONObject {
    val obj = JSONObject()
    for ((k, v) in map) obj.put(k, jsonify(v))
    return obj
}

private fun jsonify(value: Any?): Any {
    return when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> {
            val obj = JSONObject()
            for ((k, v) in value) obj.put(k.toString(), jsonify(v))
            obj
        }
        is List<*> -> {
            val arr = JSONArray()
            for (item in value) arr.put(jsonify(item))
            arr
        }
        is Array<*> -> {
            val arr = JSONArray()
            for (item in value) arr.put(jsonify(item))
            arr
        }
        else -> value
    }
}
