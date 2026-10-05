package dev.vpsdeck

import android.app.Application
import dev.vpsdeck.data.*
import dev.vpsdeck.ssh.*
import kotlinx.coroutines.*

class DeckApp : Application() {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    lateinit var database: DeckDatabase; private set
    lateinit var vault: SecretStore; private set
    lateinit var ssh: SshPool; private set
    val terminals = linkedMapOf<String, ShellSession>()
    override fun onCreate() {
        super.onCreate(); database = DeckDatabase.open(this); vault = SecretStore(this); ssh = SshPool(vault)
        appScope.launch { database.dao().recoverTasks() }
    }
    fun closeServer(id: String) {
        terminals.filterValues { it.server.id == id }.keys.toList().forEach { terminals.remove(it)?.close() }
        ssh.disconnect(id)
    }
    fun closeAll() { terminals.values.forEach { it.close() }; terminals.clear(); ssh.disconnectAll() }
}
