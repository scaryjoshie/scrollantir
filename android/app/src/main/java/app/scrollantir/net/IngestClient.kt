package app.scrollantir.net

import app.scrollantir.db.EventRow
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Client for the self-hosted runtime stack's PostgREST-fronted ingest
 * RPCs. Single-event POSTs to `<baseUrl>/rpc/accept_event`.
 *
 * Wire shape:
 *   POST <baseUrl>/rpc/accept_event
 *   Content-Type:    application/json
 *   Content-Profile: ingest_api      (PostgREST schema selector)
 *
 *   { "p_token": "...", "p_id": "...", "p_source": "phone....",
 *     "p_start_ts": "...", "p_duration_s": 0.0, "p_data": {...} }
 *
 * No Authorization header — the bearer is now a body parameter
 * (p_token), validated by `ingest_api.accept_event` SECURITY DEFINER.
 *
 * `baseUrl` is the QR-scanned origin (e.g. `https://api.scrollantir.example`)
 * with no path. This client appends `/rpc/<func>` itself.
 */
class IngestClient(
    private val baseUrl: String,
    private val token: String
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * POST one event. Returns a coarse outcome the forwarder uses to
     * decide queue/retry semantics. Throws [IOException] on network /
     * transport failures so the caller can treat those as retryable
     * separately from server-returned permanent errors.
     */
    @Throws(IOException::class)
    fun postEvent(row: EventRow): IngestResult {
        val payload = JSONObject().apply {
            put("p_token", token)
            put("p_id", row.id)
            put("p_source", canonicalSource(row.source))
            put("p_start_ts", row.timestampUtc)
            put("p_duration_s", row.durationS)
            put("p_data", parseDataJson(row.dataJson))
        }
        val body = payload.toString().toRequestBody(JSON)
        val request = Request.Builder()
            .url(rpcUrl("accept_event"))
            .header("Content-Type", "application/json")
            .header("Content-Profile", "ingest_api")
            .post(body)
            .build()

        client.newCall(request).execute().use { response ->
            val code = response.code
            val bodyText = response.body?.string().orEmpty()
            return classifyResponse(code, bodyText)
        }
    }

    private fun rpcUrl(fn: String): String {
        val trimmed = baseUrl.trim().trimEnd('/')
        return "$trimmed/rpc/$fn"
    }

    /**
     * Defensive parse: malformed local data JSON degrades to `{}`
     * rather than failing the whole POST.
     */
    private fun parseDataJson(dataJson: String): JSONObject {
        return try {
            JSONObject(dataJson)
        } catch (_: Throwable) {
            JSONObject()
        }
    }

    companion object {
        private val JSON = "application/json".toMediaType()

        /**
         * Prepend `phone.` to the source if it isn't already in
         * `<device>.<...>` form for our device. The runtime requires
         * `events.source` to start with the device name (the generated
         * `device` column FKs to `public.devices`). Local sources like
         * `phone.location.reading` and `phone.activity.state` are
         * already canonical — leave those alone.
         *
         * The check is "does it already start with `phone.`" rather
         * than "does it have a dotted prefix" because our local
         * collectors emit two-segment values (`system.foreground`,
         * `youtube.shorts`) that need the prefix; we never emit a
         * different device name from the phone.
         */
        fun canonicalSource(source: String): String =
            if (source.startsWith("phone.")) source else "phone.$source"

        /**
         * Map an HTTP code + (truncated) body into our retry policy.
         * PostgREST returns the SQLSTATE in the JSON body's `code`
         * field; the SQLSTATEs we care about:
         *   - 28000  (invalid token / source-device mismatch) → permanent
         *   - 54000  (rate limit)                              → transient
         *   - P0001  (function-level errors, e.g. negative dur)→ permanent
         */
        internal fun classifyResponse(code: Int, body: String): IngestResult {
            return when {
                code in 200..299 -> IngestResult.Ok
                code == 408 || code == 429 -> IngestResult.Transient(code, body.take(400))
                code in 500..599 -> {
                    // 54000 sometimes surfaces as 5xx via PostgREST; either
                    // way, 5xx is transient by convention.
                    IngestResult.Transient(code, body.take(400))
                }
                code == 401 || code == 403 -> IngestResult.Permanent(code, body.take(400))
                code in 400..499 -> {
                    // Inspect the SQLSTATE the function raised. 54000 is
                    // surfaced as a 4xx by PostgREST's mapping for
                    // ERRCODE-tagged exceptions; treat as transient.
                    val sqlState = extractSqlState(body)
                    if (sqlState == "54000") {
                        IngestResult.Transient(code, body.take(400))
                    } else {
                        IngestResult.Permanent(code, body.take(400))
                    }
                }
                else -> IngestResult.Permanent(code, body.take(400))
            }
        }

        private fun extractSqlState(body: String): String? {
            return try {
                JSONObject(body).optString("code", "").takeIf { it.isNotBlank() }
            } catch (_: Throwable) {
                null
            }
        }
    }
}

/**
 * Outcome of a single POST. Network/IO errors are surfaced as
 * thrown IOExceptions; this enum captures what the *server* said.
 */
sealed class IngestResult {
    object Ok : IngestResult()
    /** Retry later (5xx, 408, 429, SQLSTATE 54000). */
    data class Transient(val httpCode: Int, val body: String) : IngestResult()
    /** Don't retry — drop and log (4xx other than the above). */
    data class Permanent(val httpCode: Int, val body: String) : IngestResult()
}
