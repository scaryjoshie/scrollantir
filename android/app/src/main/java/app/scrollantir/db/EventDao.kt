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
    //
    // All sources flow to Supabase. Location/activity rows were previously
    // held local-only (see docs/concepts/location.md) while the ingest target was a
    // LAN stub over plaintext HTTP; now that we POST to Supabase over TLS,
    // that blocker is gone. Coordinates ship at full device precision —
    // the prior 4-decimal egress snap was removed since this is a
    // self-hosted single-user setup and ~sub-meter fidelity is wanted for
    // the place-matching layer.

    @Query("""
        SELECT * FROM events
        WHERE forwarded_at IS NULL
        ORDER BY timestamp_utc ASC LIMIT :limit
    """)
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

    // --- Location / activity (local-only, never forwarded) ---

    @Query("""
        SELECT * FROM events
        WHERE source = 'phone.location.reading'
          AND timestamp_utc >= :sinceIso
          AND timestamp_utc < :untilIso
        ORDER BY timestamp_utc ASC
    """)
    fun locationReadingsBetween(sinceIso: String, untilIso: String): Flow<List<EventRow>>

    // Activity states and usage rows are duration events; a row starting
    // before :sinceIso can still overlap the day window. We fetch with a
    // 24h lookback and the caller clips in Kotlin. Mirrors the pattern
    // used by foregroundEventsSince for the Today dashboard.

    @Query("""
        SELECT * FROM events
        WHERE source = 'phone.activity.state'
          AND timestamp_utc >= :lookbackIso
          AND timestamp_utc < :untilIso
        ORDER BY timestamp_utc ASC
    """)
    fun activityStatesSince(lookbackIso: String, untilIso: String): Flow<List<EventRow>>

    @Query("""
        SELECT * FROM events
        WHERE timestamp_utc >= :lookbackIso
          AND timestamp_utc < :untilIso
          AND source IN ('system.foreground', 'youtube.shorts', 'instagram.reels',
                         'instagram.stories', 'tiktok.feed')
        ORDER BY timestamp_utc ASC
    """)
    fun usageOverlappingSince(lookbackIso: String, untilIso: String): Flow<List<EventRow>>

    // --- Cleanup ---
    //
    // Location and activity rows are kept locally for ~98 days regardless of
    // forward status so the on-phone LocationScreen can page back through
    // prior days without refetching from Supabase. Everything else is dropped
    // 48h after server ACK.

    @Query("""
        DELETE FROM events
        WHERE forwarded_at IS NOT NULL
          AND forwarded_at < :cutoffIso
          AND source NOT LIKE 'phone.location.%'
          AND source NOT LIKE 'phone.activity.%'
    """)
    suspend fun deleteForwardedBefore(cutoffIso: String): Int

    /**
     * Full wipe — for the "reset all local data" button in Settings. Deletes
     * every row including unforwarded ones. Destructive; UI must confirm.
     */
    @Query("DELETE FROM events")
    suspend fun deleteAll(): Int

    /**
     * Delete old local-only rows that will never be forwarded (location +
     * activity). Tier-1 volume is low (~70/day) so a generous retention is
     * fine; we keep ~14 weeks so the LocationScreen can page back through
     * the past quarter without hitting a wall.
     */
    @Query("""
        DELETE FROM events
        WHERE (source LIKE 'phone.location.%' OR source LIKE 'phone.activity.%')
          AND timestamp_utc < :cutoffIso
    """)
    suspend fun deleteLocalOnlyBefore(cutoffIso: String): Int
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
