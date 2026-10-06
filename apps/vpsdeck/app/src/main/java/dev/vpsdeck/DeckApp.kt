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
    internal val operationLocks = mutableMapOf<String, kotlinx.coroutines.sync.Mutex>()
    val projects by lazy { dev.vpsdeck.panel.ProjectController(this) }
    val websites by lazy { dev.vpsdeck.panel.WebsiteController(this) }
    val panel by lazy { dev.vpsdeck.panel.PanelController(this) }
    val connectionServiceActive = kotlinx.coroutines.flow.MutableStateFlow(false)
    val connecting = kotlinx.coroutines.flow.MutableStateFlow<Set<String>>(emptySet())
    val connectionAttempts = mutableMapOf<String, Job>()
    val terminals = linkedMapOf<String, ShellSession>()
    override fun onCreate() {
        super.onCreate(); database = DeckDatabase.open(this); vault = SecretStore(this); ssh = SshPool(vault)
        appScope.launch { database.dao().recoverTasks() }
    }
    fun closeServer(id: String) {
        connectionAttempts.remove(id)?.cancel(); connecting.value = connecting.value - id
        terminals.filterValues { it.server.id == id }.keys.toList().forEach { terminals.remove(it)?.close() }
        ssh.disconnect(id)
    }
    fun closeAll() { connectionAttempts.values.toList().forEach {it.cancel()}; connectionAttempts.clear(); connecting.value=emptySet(); terminals.values.forEach { it.close() }; terminals.clear(); ssh.disconnectAll() }
}
