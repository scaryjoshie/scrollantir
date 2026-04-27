package app.scrollantir.net

import android.content.Context
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

/**
 * Process-wide cache of the user's pending prompts. The Questions screen
 * polls through [refresh] every 30 s while foregrounded; TodayScreen's
 * badge subscribes to [prompts] and optionally triggers a one-shot
 * refresh on resume. The server is the source of truth — we keep no
 * local SQLite for prompts.
 */
object PromptsRepository {

    private val _prompts = MutableStateFlow<List<Prompt>>(emptyList())
    val prompts: StateFlow<List<Prompt>> = _prompts.asStateFlow()

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    private val _lastRefreshAt = MutableStateFlow<Instant?>(null)
    val lastRefreshAt: StateFlow<Instant?> = _lastRefreshAt.asStateFlow()

    private val refreshMutex = Mutex()

    /**
     * Refresh from `ingest_api.pending_prompts`. Safe to call
     * concurrently — the mutex coalesces overlapping refreshes so a
     * LaunchedEffect + a manual "pull to refresh" never fire parallel
     * requests.
     *
     * Returns true on success (whether or not the list changed), false
     * on any error (network, non-2xx, unparseable body, or the device
     * isn't configured yet).
     */
    suspend fun refresh(context: Context): Boolean = refreshMutex.withLock {
        val api = buildApi(context) ?: run {
            _lastError.value = "Scan the onboarding QR first to configure the runtime URL + token."
            return@withLock false
        }
        when (val result = api.pendingPrompts()) {
            is PendingPromptsResult.Success -> {
                _prompts.value = result.prompts
                _lastError.value = null
                _lastRefreshAt.value = Instant.now()
                true
            }
            is PendingPromptsResult.Error -> {
                Log.w(TAG, "pending-prompts HTTP ${result.code}: ${result.message}")
                _lastError.value = "HTTP ${result.code}: ${result.message}"
                false
            }
        }
    }

    /**
     * Submit an answer. On success, the prompt is removed from the
     * in-memory cache so the UI updates immediately without waiting for
     * the next refresh tick.
     */
    suspend fun submit(
        context: Context,
        prompt: Prompt,
        data: JSONObject
    ): SubmitResult {
        val api = buildApi(context)
            ?: return SubmitResult.Error(0, "Not configured. Scan the onboarding QR.")
        val answerEventId = UUID.randomUUID().toString()
        val result = api.submitAnswer(prompt.id, answerEventId, data)
        if (result is SubmitResult.Success || result is SubmitResult.AlreadyAnswered) {
            _prompts.value = _prompts.value.filterNot { it.id == prompt.id }
        }
        return result
    }

    private fun buildApi(context: Context): PromptsApi? {
        val prefs = SecurePrefs.get(context)
        val url = prefs.getString(SecurePrefs.KEY_SERVER_URL, null)
        val token = prefs.getString(SecurePrefs.KEY_TOKEN, null)
        return PromptsApi.fromBaseUrl(url, token)
    }

    private const val TAG = "ScrollantirPrompts"
}
