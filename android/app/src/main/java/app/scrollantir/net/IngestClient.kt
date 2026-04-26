package app.scrollantir.net

import app.scrollantir.db.EventRow
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class IngestClient(
    private val ingestUrl: String,
    private val token: String
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * POSTs a batch. Returns the HTTP status code. Throws IOException on
     * network failure (caller treats as retryable transport error).
     */
    fun postBatch(batch: List<EventRow>): Int {
        val json = JSONArray().apply {
            batch.forEach { row ->
                put(
                    JSONObject().apply {
                        put("id", row.id)
                        put("device", row.device)
                        put("source", row.source)
                        put("timestamp", row.timestampUtc)
                        put("duration_s", row.durationS)
                        // data_json is already a JSON string; parse so it serializes as object
                        put("data", parseDataJson(row.dataJson))
                    }
                )
            }
        }

        val body = json.toString().toRequestBody("application/json".toMediaType())

        // URL is stored as the full POST target (e.g. the Supabase
        // `/functions/v1/ingest` endpoint from the QR payload, or a LAN
        // stub ending in `/ingest`). No suffix mangling here.
        val request = Request.Builder()
            .url(ingestUrl)
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()

        client.newCall(request).execute().use { response ->
            return response.code
        }
    }

    /**
     * Defensive parse: malformed data JSON degrades to `{}` rather than
     * throwing and failing the whole batch POST. No egress transforms today
     * — coordinates and other fields ship as recorded.
     */
    private fun parseDataJson(dataJson: String): JSONObject {
        return try {
            JSONObject(dataJson)
        } catch (_: Throwable) {
            JSONObject()
        }
    }
}
