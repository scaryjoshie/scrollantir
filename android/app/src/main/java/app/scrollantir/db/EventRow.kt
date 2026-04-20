package app.scrollantir.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "events")
data class EventRow(
    @PrimaryKey val id: String,
    val device: String,
    val source: String,
    @ColumnInfo(name = "timestamp_utc") val timestampUtc: String,
    @ColumnInfo(name = "duration_s") val durationS: Double,
    @ColumnInfo(name = "data_json") val dataJson: String,
    /**
     * ISO-8601 instant (UTC, trailing Z) when the server acknowledged this
     * event. Null means still in the outgoing queue. Events are kept locally
     * for [RETENTION_HOURS] after forwarding so the Today dashboard can show
     * per-app totals even across server outages.
     */
    @ColumnInfo(name = "forwarded_at") val forwardedAt: String? = null
)
