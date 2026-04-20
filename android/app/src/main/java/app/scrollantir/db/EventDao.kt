package app.scrollantir.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface EventDao {

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(event: EventRow)

    // --- Outgoing queue: unforwarded events ---

    @Query("SELECT * FROM events WHERE forwarded_at IS NULL ORDER BY timestamp_utc ASC LIMIT :limit")
    suspend fun nextBatch(limit: Int): List<EventRow>

    @Query("UPDATE events SET forwarded_at = :nowIso WHERE id IN (:ids)")
    suspend fun markForwarded(ids: List<String>, nowIso: String)

    @Query("SELECT COUNT(*) FROM events WHERE forwarded_at IS NULL")
    suspend fun pendingCount(): Int

    @Query("SELECT COUNT(*) FROM events WHERE forwarded_at IS NULL")
    fun pendingCountFlow(): Flow<Int>

    // --- Debug / timeline views ---

    @Query("SELECT * FROM events ORDER BY timestamp_utc DESC LIMIT :limit")
    fun recentFlow(limit: Int): Flow<List<EventRow>>

    // --- Aggregates for Today dashboard ---

    /**
     * Raw foreground sessions that *might* overlap with the [lookbackIso ..]
     * window. Returns events whose (start + duration) is still after the
     * window start — i.e., any session that contributes any time to today.
     * Kotlin-side clips each session to the day boundary before summing.
     *
     * SQLite string comparison works because timestamps are ISO-8601 UTC
     * (lexicographically ordered). Duration is added by comparing the
     * start of the session plus its seconds against the window.
     */
    @Query("""
        SELECT * FROM events
        WHERE source = 'system.foreground'
          AND timestamp_utc >= :lookbackIso
    """)
    fun foregroundEventsSince(lookbackIso: String): Flow<List<EventRow>>

    @Query("""
        SELECT * FROM events
        WHERE (source LIKE 'youtube.%' OR source LIKE 'instagram.%' OR source LIKE 'tiktok.%')
          AND duration_s > 0
          AND timestamp_utc >= :lookbackIso
    """)
    fun contentModeEventsSince(lookbackIso: String): Flow<List<EventRow>>

    @Query("SELECT COUNT(*) FROM events WHERE source = 'system.unlock' AND timestamp_utc >= :sinceIso")
    fun unlockCountSince(sinceIso: String): Flow<Int>

    // --- Cleanup ---

    @Query("DELETE FROM events WHERE forwarded_at IS NOT NULL AND forwarded_at < :cutoffIso")
    suspend fun deleteForwardedBefore(cutoffIso: String): Int
}

data class AppTotal(
    val app: String,
    val totalS: Double,
    val sessionCount: Int
)

data class ModeTotal(
    val source: String,
    val totalS: Double
)
