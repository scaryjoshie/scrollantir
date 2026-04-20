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
    private val serverUrl: String,
    private val token: String
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * POSTs a batch and returns true on 200, false otherwise.
     * Throws IOException on network failure (caller treats as retryable).
     */
    fun postBatch(batch: List<EventRow>): Boolean {
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
                        put("data", JSONObject(row.dataJson))
                    }
                )
            }
        }

        val body = json.toString().toRequestBody("application/json".toMediaType())

        val url = serverUrl.trimEnd('/') + "/ingest"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()

        client.newCall(request).execute().use { response ->
            return response.isSuccessful
        }
    }
}
