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
    @ColumnInfo(name = "data_json") val dataJson: String
)
