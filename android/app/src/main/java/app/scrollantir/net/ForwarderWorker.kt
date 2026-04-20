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
import java.time.Instant
import java.util.concurrent.TimeUnit

class ForwarderWorker(
    ctx: Context,
    params: WorkerParameters
) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val prefs = SecurePrefs.get(applicationContext)
        val serverUrl = prefs.getString(SecurePrefs.KEY_SERVER_URL, null)
        val token = prefs.getString(SecurePrefs.KEY_TOKEN, null)

        if (serverUrl.isNullOrBlank() || token.isNullOrBlank()) {
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

        Log.i(TAG, "forwarding ${batch.size} events to $serverUrl")

        return try {
            val client = IngestClient(serverUrl, token)
            val ok = client.postBatch(batch)
            if (ok) {
                dao.deleteByIds(batch.map { it.id })
                Log.i(TAG, "forwarded ${batch.size} events; deleted from queue")
                updateStatus(success = true, count = batch.size, error = null)
                Result.success()
            } else {
                Log.w(TAG, "server returned non-2xx; will retry")
                updateStatus(success = false, count = batch.size, error = "non-2xx response")
                Result.retry()
            }
        } catch (t: Throwable) {
            Log.e(TAG, "forward failed", t)
            updateStatus(success = false, count = batch.size, error = t.message ?: "unknown")
            Result.retry()
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
