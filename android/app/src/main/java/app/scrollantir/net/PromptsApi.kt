package app.scrollantir.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Client for the Supabase edge functions `/pending-prompts` (GET) and
 * `/prompt-answer` (POST). Derives its base URL from the stored ingest
 * URL by stripping the trailing `/ingest` segment — the three edge
 * functions are siblings under `/functions/v1/`.
 *
 * Prompts are a Supabase-only feature; the LAN stub server doesn't
 * implement them. Callers should surface a "configure ingest URL"
 * message to the user if [fromIngestUrl] returns null.
 */
class PromptsApi(
    private val functionsBaseUrl: String,
    private val token: String
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    suspend fun pendingPrompts(): PendingPromptsResult = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$functionsBaseUrl/pending-prompts")
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        client.newCall(request).execute().use { response ->
            val bodyText = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                return@withContext PendingPromptsResult.Error(response.code, bodyText.take(200))
            }
            val parsed = runCatching { JSONObject(bodyText).getJSONArray("prompts") }
                .getOrElse {
                    return@withContext PendingPromptsResult.Error(
                        response.code, "bad JSON: ${bodyText.take(200)}"
                    )
                }
            PendingPromptsResult.Success(parsePrompts(parsed))
        }
    }

    suspend fun submitAnswer(
        promptId: String,
        answerEventId: String,
        data: JSONObject
    ): SubmitResult = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("prompt_id", promptId)
            .put("answer_event_id", answerEventId)
            .put("data", data)
            .toString()
            .toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url("$functionsBaseUrl/prompt-answer")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()
        client.newCall(request).execute().use { response ->
            val bodyText = response.body?.string().orEmpty()
            when (response.code) {
                in 200..299 -> SubmitResult.Success
                409 -> SubmitResult.AlreadyAnswered(bodyText.take(200))
                else -> SubmitResult.Error(response.code, bodyText.take(200))
            }
        }
    }

    companion object {
        /**
         * Derive the functions base URL from the stored ingest URL. Returns
         * null when the URL doesn't end in `/ingest` — typically means the
         * device is pointing at the LAN stub, which doesn't ship prompts.
         */
        fun fromIngestUrl(ingestUrl: String, token: String): PromptsApi? {
            val trimmed = ingestUrl.trim().trimEnd('/')
            val base = trimmed.removeSuffix("/ingest")
            if (base == trimmed) return null
            return PromptsApi(base, token)
        }

        private fun parsePrompts(arr: JSONArray): List<Prompt> = buildList {
            for (i in 0 until arr.length()) {
                val row = arr.optJSONObject(i) ?: continue
                add(
                    Prompt(
                        id = row.optString("id").takeIf { it.isNotBlank() } ?: continue,
                        kind = row.optString("kind"),
                        question = row.optString("question"),
                        context = row.optJSONObject("context"),
                        answerSchema = row.optJSONObject("answer_schema") ?: JSONObject(),
                        createdAt = row.optString("created_at"),
                        expiresAt = row.optString("expires_at").takeIf { it.isNotBlank() }
                    )
                )
            }
        }
    }
}

data class Prompt(
    val id: String,
    val kind: String,
    val question: String,
    val context: JSONObject?,
    val answerSchema: JSONObject,
    val createdAt: String,
    val expiresAt: String?
)

sealed class PendingPromptsResult {
    data class Success(val prompts: List<Prompt>) : PendingPromptsResult()
    data class Error(val code: Int, val message: String) : PendingPromptsResult()
}

sealed class SubmitResult {
    object Success : SubmitResult()
    data class AlreadyAnswered(val message: String) : SubmitResult()
    data class Error(val code: Int, val message: String) : SubmitResult()
}
