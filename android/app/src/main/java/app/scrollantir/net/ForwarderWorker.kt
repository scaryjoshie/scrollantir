package app.scrollantir.net

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.scrollantir.db.AppDatabase
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Periodic forwarder.
 *
 * The runtime's `ingest_api.accept_event` is a single-event RPC, so
 * instead of one batch POST per run we loop over the batch and POST
 * each event individually. One bad event (e.g. a malformed source the
 * server rejects with 4xx) MUST NOT poison the rest of the batch — we
 * mark it forwarded anyway and move on. The whole point of the
 * forwarder is to keep the queue draining; permanently-bad rows that
 * loop forever waste battery and network.
 *
 * Categories per row, in priority:
 *   - 2xx                            → mark forwarded
 *   - permanent (4xx, 401/403)       → mark forwarded, log loudly
 *   - transient (5xx, 408, 429, IO)  → leave queued, return Result.retry()
 */
class ForwarderWorker(
    ctx: Context,
    params: WorkerParameters
) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val prefs = SecurePrefs.get(applicationContext)
        val baseUrl = prefs.getString(SecurePrefs.KEY_SERVER_URL, null)
        val token = prefs.getString(SecurePrefs.KEY_TOKEN, null)

        if (baseUrl.isNullOrBlank() || token.isNullOrBlank()) {
            Log.i(TAG, "skipping: server URL or token not configured")
            return Result.success()
        }

        val dao = AppDatabase.get(applicationContext).events()
        val batch = dao.nextBatch(BATCH_SIZE)

        if (batch.isEmpty()) {
            Log.i(TAG, "no events to forward")
            updateStatus(success = true, count = 0, error = null)
            return Result.success()
        }

        Log.i(TAG, "forwarding ${batch.size} events to $baseUrl (one-by-one)")

        val client = IngestClient(baseUrl, token)
        val forwardedIds = ArrayList<String>(batch.size)
        var transientCount = 0
        var permanentCount = 0
        var lastTransientCode: Int? = null
        var lastPermanentCode: Int? = null

        for (row in batch) {
            val outcome = try {
                client.postEvent(row)
            } catch (t: IOException) {
                // Pure network/IO — transient. Stop the run; WorkManager
                // will back off and re-drain the queue.
                Log.w(TAG, "IO failure on event ${row.id} — bailing", t)
                updateStatus(
                    success = false,
                    count = forwardedIds.size,
                    error = t.message ?: "io error"
                )
                if (forwardedIds.isNotEmpty()) {
                    val nowIso = Instant.now().toString()
                    dao.markForwarded(forwardedIds, nowIso)
                }
                return Result.retry()
            } catch (t: Throwable) {
                // Anything else (programmer error, OkHttp blowing up).
                // Treat as transient — better to retry than to silently
                // skip rows that may be valid.
                Log.e(TAG, "unexpected throw on event ${row.id}", t)
                updateStatus(
                    success = false,
                    count = forwardedIds.size,
                    error = t.message ?: "unknown"
                )
                if (forwardedIds.isNotEmpty()) {
                    val nowIso = Instant.now().toString()
                    dao.markForwarded(forwardedIds, nowIso)
                }
                return Result.retry()
            }

            when (outcome) {
                is IngestResult.Ok -> forwardedIds.add(row.id)
                is IngestResult.Permanent -> {
                    Log.e(
                        TAG,
                        "PERMANENT ${outcome.httpCode} on event id=${row.id} " +
                            "source=${row.source} — dropping. body=${outcome.body}"
                    )
                    // Mark forwarded so we don't retry this row forever.
                    forwardedIds.add(row.id)
                    permanentCount += 1
                    lastPermanentCode = outcome.httpCode
                }
                is IngestResult.Transient -> {
                    // Stop draining; let backoff retry. Future runs
                    // re-pick this row off the queue.
                    Log.w(
                        TAG,
                        "transient ${outcome.httpCode} on event ${row.id} — " +
                            "stopping batch. body=${outcome.body}"
                    )
                    transientCount += 1
                    lastTransientCode = outcome.httpCode
                    break
                }
            }
        }

        // Flush whatever we managed to send.
        if (forwardedIds.isNotEmpty()) {
            val nowIso = Instant.now().toString()
            dao.markForwarded(forwardedIds, nowIso)
            Log.i(
                TAG,
                "forwarded ${forwardedIds.size}/${batch.size} events at $nowIso " +
                    "(perm-drop=$permanentCount, transient=$transientCount)"
            )
        }

        return if (transientCount > 0) {
            updateStatus(
                success = false,
                count = forwardedIds.size,
                error = "HTTP $lastTransientCode (transient)"
            )
            Result.retry()
        } else {
            // Everything either landed or was a permanent skip. Note
            // that a fully-permanent run returns "success" so
            // WorkManager doesn't escalate backoff — there's no point
            // retrying rows the server already rejected.
            val errorMsg = if (permanentCount > 0)
                "HTTP $lastPermanentCode on $permanentCount row(s) — dropped"
            else null
            updateStatus(
                success = permanentCount == 0,
                count = forwardedIds.size,
                error = errorMsg
            )
            Result.success()
        }
    }

    private fun updateStatus(success: Boolean, count: Int, error: String?) {
        val now = Instant.now()
        val prefs = SecurePrefs.get(applicationContext)
        prefs.edit()
            .putString(SecurePrefs.KEY_LAST_SYNC_AT, now.toString())
            .putString(SecurePrefs.KEY_LAST_SYNC_RESULT, if (success) "ok" else "error")
            .putInt(SecurePrefs.KEY_LAST_SYNC_COUNT, count)
            .apply()

        _status.value = SyncStatus(
            lastAttempt = now,
            lastSuccess = if (success) now else _status.value.lastSuccess,
            lastError = error,
            lastBatchSize = count
        )
    }

    data class SyncStatus(
        val lastAttempt: Instant? = null,
        val lastSuccess: Instant? = null,
        val lastError: String? = null,
        val lastBatchSize: Int = 0
    )

    companion object {
        const val TAG = "ScrollantirFwd"
        private const val BATCH_SIZE = 500
        private const val PERIODIC_NAME = "scrollantir-forwarder-periodic"
        private const val ONESHOT_NAME = "scrollantir-forwarder-oneshot"

        private val _status = MutableStateFlow(SyncStatus())
        val status: StateFlow<SyncStatus> = _status.asStateFlow()

        fun enqueuePeriodic(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val request = PeriodicWorkRequestBuilder<ForwarderWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
        }

        fun syncNow(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val request = OneTimeWorkRequestBuilder<ForwarderWorker>()
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                ONESHOT_NAME,
                ExistingWorkPolicy.REPLACE,
                request
            )
        }
    }
}
