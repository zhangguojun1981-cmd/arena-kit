package dev.vpsdeck.ui

import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.vpsdeck.DeckViewModel
import dev.vpsdeck.data.Server
import dev.vpsdeck.panel.ProjectState
import kotlinx.coroutines.delay
import org.json.JSONObject

/** Only queries. Never resubmits a mutation, even after disconnect or process recreation. */
@Composable fun RemoteTaskRefresh(vm: DeckViewModel, server: Server, sudo: Boolean, settled: () -> Unit) {
    val all by vm.app.projects.states.collectAsStateWithLifecycle()
    val state=all[server.id] ?: ProjectState()
    val connections by vm.connected.collectAsStateWithLifecycle()
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsState()
    val foreground=lifecycleState.isAtLeast(Lifecycle.State.STARTED)
    val online=server.id in connections
    val active=state.jobs.any { JSONObject(it).optString("state") in listOf("queued","running") }
    val current by rememberUpdatedState(state)
    val refresh by rememberUpdatedState(settled)
    var wasActive by remember(server.id,sudo) { mutableStateOf(false) }
    LaunchedEffect(server.id,online,sudo,active,foreground) {
        if(!online || !foreground) return@LaunchedEffect
        if(active) {
            wasActive=true
            while(true) {
                delay(4000)
                if(!current.busy) vm.app.projects.load(server,sudo,true)
            }
        } else if(wasActive) {
            wasActive=false
            delay(300)
            if(!current.busy) refresh()
        }
    }
}
