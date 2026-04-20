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

    @Query("SELECT * FROM events ORDER BY timestamp_utc ASC LIMIT :limit")
    suspend fun nextBatch(limit: Int): List<EventRow>

    @Query("DELETE FROM events WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>)

    @Query("SELECT COUNT(*) FROM events")
    suspend fun count(): Int

    @Query("SELECT COUNT(*) FROM events")
    fun countFlow(): Flow<Int>

    @Query("SELECT * FROM events ORDER BY timestamp_utc DESC LIMIT :limit")
    fun recentFlow(limit: Int): Flow<List<EventRow>>
}
