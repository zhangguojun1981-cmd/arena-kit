package dev.vpsdeck.ui

import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.vpsdeck.DeckViewModel

@Composable fun BackgroundConnectionSettings(vm: DeckViewModel) {
    val context=LocalContext.current
    val owner=LocalLifecycleOwner.current
    val power=context.getSystemService(PowerManager::class.java)
    var unrestricted by remember {mutableStateOf(power.isIgnoringBatteryOptimizations(context.packageName))}
    val active by vm.app.connectionServiceActive.collectAsState()
    DisposableEffect(owner) {
        val observer=LifecycleEventObserver {_,event -> if(event==Lifecycle.Event.ON_RESUME) unrestricted=power.isIgnoringBatteryOptimizations(context.packageName)}
        owner.lifecycle.addObserver(observer)
        onDispose {owner.lifecycle.removeObserver(observer)}
    }
    ResourceDetail("后台连接",if(active) "连接服务正在运行" else "有连接时启用保活") {
        DetailRow("前台服务",if(active) "运行中" else "未运行")
        DetailRow("系统电池优化",if(unrestricted) "已豁免" else "尚未豁免")
        Hint("连接前启动前台服务，活动会话期间持有可续期CPU锁。请允许通知，并在系统电池设置中为本应用选择不限制后台。保持连接会增加耗电。")
        Hint("厂商清理、强行停止、系统后台时限、网络切换仍可断线；不保证永久在线。长任务建议在VPS中使用tmux。不会自动重新执行未完成的命令。")
        QuietAction({runCatching {context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:${context.packageName}")))}.onFailure {vm.error=it.message}}) {ActionLabel("打开本应用系统设置")}
        QuietAction({vm.app.closeAll();vm.app.stopService(Intent(vm.app,dev.vpsdeck.ssh.ConnectionService::class.java))}) {ActionLabel("断开全部 SSH 连接",color=MaterialTheme.colorScheme.error)}
    }
}
