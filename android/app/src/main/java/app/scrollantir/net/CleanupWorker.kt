package app.scrollantir.net

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.scrollantir.db.AppDatabase
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.TimeUnit

/**
 * Periodic cleanup of forwarded events older than RETENTION_HOURS. Keeps the
 * local events table bounded while still allowing the Today dashboard to
 * aggregate across the retention window even after server ack.
 */
class CleanupWorker(
    ctx: Context,
    params: WorkerParameters
) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val dao = AppDatabase.get(applicationContext).events()
        val forwardedCutoff = Instant.now()
            .minus(AppDatabase.RETENTION_HOURS, ChronoUnit.HOURS)
            .toString()
        val localOnlyCutoff = Instant.now()
            .minus(LOCAL_ONLY_RETENTION_DAYS, ChronoUnit.DAYS)
            .toString()

        val deletedForwarded = dao.deleteForwardedBefore(forwardedCutoff)
        val deletedLocal = dao.deleteLocalOnlyBefore(localOnlyCutoff)

        Log.i(
            TAG,
            "cleaned $deletedForwarded forwarded (< $forwardedCutoff) + " +
                "$deletedLocal local-only (< $localOnlyCutoff)"
        )
        return Result.success()
    }

    companion object {
        const val TAG = "ScrollantirCleanup"
        private const val UNIQUE_NAME = "scrollantir-cleanup-periodic"
        // 14 weeks ≈ one academic quarter; retains enough history for the
        // LocationScreen's date nav without unbounded growth.
        private const val LOCAL_ONLY_RETENTION_DAYS = 98L

        fun enqueuePeriodic(context: Context) {
            val request = PeriodicWorkRequestBuilder<CleanupWorker>(6, TimeUnit.HOURS).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
        }
    }
}
