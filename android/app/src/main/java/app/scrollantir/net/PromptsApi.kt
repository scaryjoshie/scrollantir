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
 * Client for the runtime stack's prompt RPCs:
 *
 *   POST <baseUrl>/rpc/pending_prompts          → list unanswered prompts
 *   POST <baseUrl>/rpc/accept_prompt_answer     → submit a prompt answer
 *
 * Both go through PostgREST with `Content-Profile: ingest_api`. The
 * bearer token is a body parameter (`p_token`), not an Authorization
 * header — same convention as `accept_event`.
 *
 * Note: `pending_prompts` is a SELECT-shaped function; PostgREST
 * accepts POST for it because the token argument can't safely live in
 * the URL.
 */
class PromptsApi(
    private val baseUrl: String,
    private val token: String
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    suspend fun pendingPrompts(): PendingPromptsResult = withContext(Dispatchers.IO) {
        val payload = JSONObject().put("p_token", token).toString()
        val request = buildPostRequest("pending_prompts", payload)
        client.newCall(request).execute().use { response ->
            val bodyText = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                return@withContext PendingPromptsResult.Error(response.code, bodyText.take(400))
            }
            // PostgREST returns a JSON array of rows for setof functions.
            val parsed = runCatching { JSONArray(bodyText) }
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
        val payload = JSONObject()
            .put("p_token", token)
            .put("p_prompt_id", promptId)
            .put("p_answer_event_id", answerEventId)
            .put("p_data", data)
            .toString()
        val request = buildPostRequest("accept_prompt_answer", payload)
        client.newCall(request).execute().use { response ->
            val bodyText = response.body?.string().orEmpty()
            when (response.code) {
                in 200..299 -> SubmitResult.Success
                // The function raises plain (no ERRCODE) exceptions for
                // "not answerable"; PostgREST surfaces those as 400. Treat
                // 400/409 as "already answered or expired" since both end
                // up the same way for the UI: clear the prompt.
                400, 409 -> SubmitResult.AlreadyAnswered(bodyText.take(400))
                else -> SubmitResult.Error(response.code, bodyText.take(400))
            }
        }
    }

    private fun buildPostRequest(fn: String, jsonBody: String): Request {
        val body = jsonBody.toRequestBody(JSON)
        val trimmed = baseUrl.trim().trimEnd('/')
        return Request.Builder()
            .url("$trimmed/rpc/$fn")
            .header("Content-Type", "application/json")
            .header("Content-Profile", "ingest_api")
            .post(body)
            .build()
    }

    companion object {
        private val JSON = "application/json".toMediaType()

        /**
         * Build a PromptsApi from the SecurePrefs-stored base URL +
         * token. Returns null if either is missing — the UI should
         * tell the user to scan the QR.
         */
        fun fromBaseUrl(baseUrl: String?, token: String?): PromptsApi? {
            val u = baseUrl?.trim().orEmpty()
            val t = token?.trim().orEmpty()
            if (u.isBlank() || t.isBlank()) return null
            return PromptsApi(u, t)
        }

        private fun parsePrompts(arr: JSONArray): List<Prompt> = buildList {
            for (i in 0 until arr.length()) {
                val row = arr.optJSONObject(i) ?: continue
                add(
                    Prompt(
                        id = row.optString("id").takeIf { it.isNotBlank() } ?: continue,
                        kind = row.optString("kind"),
                        question = row.optString("question"),
                        // Schema column is `ctx` (not `context`).
                        context = row.optJSONObject("ctx"),
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
