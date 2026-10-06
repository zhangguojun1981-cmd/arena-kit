package dev.vpsdeck.data

import android.content.Context
import androidx.room.*
import kotlinx.coroutines.flow.Flow
import java.util.UUID

@Entity(tableName = "servers")
data class Server(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    val name: String, val host: String, val port: Int = 22, val username: String = "root",
    val auth: String = "password", val group: String = "默认", val production: Boolean = false,
    val fingerprint: String = "", val favorite: Boolean = false
) { val endpoint: String get() = "$username@$host:$port" }

@Entity(tableName = "tasks")
data class TaskRecord(@PrimaryKey val id: String = UUID.randomUUID().toString(), val serverId: String,
    val serverName: String, val label: String, val started: Long = System.currentTimeMillis(),
    val state: String = "运行中", val exitCode: Int? = null, val detail: String = "")

@Dao
interface DeckDao {
    @Query("SELECT * FROM servers ORDER BY favorite DESC, name COLLATE NOCASE") fun servers(): Flow<List<Server>>
    @Query("SELECT * FROM servers WHERE id = :id") suspend fun server(id: String): Server?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun save(server: Server)
    @Query("DELETE FROM servers WHERE id = :id") suspend fun delete(id: String)
    @Query("SELECT * FROM tasks ORDER BY started DESC LIMIT 200") fun tasks(): Flow<List<TaskRecord>>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun task(task: TaskRecord)
    @Query("UPDATE tasks SET state = '中断', detail = '应用进程已结束；执行结果未知，请核对远端状态。' WHERE state = '运行中'") suspend fun recoverTasks()
    @Query("DELETE FROM tasks WHERE id NOT IN (SELECT id FROM tasks ORDER BY started DESC LIMIT 200)") suspend fun trimTasks()
    @Query("DELETE FROM tasks WHERE state NOT IN ('运行中', '远端排队', '远端执行中', '提交待确认')") suspend fun clearTasks()
}

@Database(entities = [Server::class, TaskRecord::class], version = 1, exportSchema = false)
abstract class DeckDatabase : RoomDatabase() {
    abstract fun dao(): DeckDao
    companion object { fun open(context: Context) = Room.databaseBuilder(context, DeckDatabase::class.java, "deck.db").build() }
}
