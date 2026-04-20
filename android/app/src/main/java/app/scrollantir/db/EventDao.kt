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

    @Query("""
        SELECT
            json_extract(data_json, '$.app') AS app,
            SUM(duration_s) AS totalS,
            COUNT(*) AS sessionCount
        FROM events
        WHERE source = 'system.foreground'
          AND timestamp_utc >= :sinceIso
          AND json_extract(data_json, '$.app') IS NOT NULL
        GROUP BY json_extract(data_json, '$.app')
        ORDER BY totalS DESC
    """)
    fun foregroundTotalsSince(sinceIso: String): Flow<List<AppTotal>>

    @Query("""
        SELECT source AS source, SUM(duration_s) AS totalS
        FROM events
        WHERE timestamp_utc >= :sinceIso
          AND (source LIKE 'youtube.%' OR source LIKE 'instagram.%' OR source LIKE 'tiktok.%')
          AND duration_s > 0
        GROUP BY source
        ORDER BY totalS DESC
    """)
    fun contentModeTotalsSince(sinceIso: String): Flow<List<ModeTotal>>

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
