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
    val lastDisconnect by vm.app.lastDisconnect.collectAsState()
    DisposableEffect(owner) {
        val observer=LifecycleEventObserver {_,event -> if(event==Lifecycle.Event.ON_RESUME) unrestricted=power.isIgnoringBatteryOptimizations(context.packageName)}
        owner.lifecycle.addObserver(observer)
        onDispose {owner.lifecycle.removeObserver(observer)}
    }
    ResourceDetail("后台连接",if(active) "连接服务正在运行" else "有连接时启用保活") {
        DetailRow("前台服务",if(active) "运行中" else "未运行")
        DetailRow("系统电池优化",if(unrestricted) "已豁免" else "尚未豁免（掉线的常见原因）")
        DetailRow("最近一次断开诊断",lastDisconnect?.ifBlank { "暂无记录" } ?: "暂无记录")
        Hint("诊断含义：显示“连接服务仍在运行”说明是网络/锁屏休眠导致；显示“应用进程可能已被系统终止”说明需要下面的豁免。")
        if(!unrestricted) QuietAction({
            runCatching {
                context.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")).setPackage(context.packageName))
            }.onFailure {
                context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
            }
        }) {ActionLabel("请求忽略电池优化")}
        QuietAction({runCatching {context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:${context.packageName}")))}.onFailure {vm.error=it.message}}) {ActionLabel("打开本应用系统设置")}
        Hint("建议：忽略电池优化；电池设置中本应用“不限制”；锁屏后保持WiFi常亮；允许自启动；不要使用“强行停止”。SSH每10秒发送保活探测，连续5次无响应即判定断开。")
        Hint("厂商清理、网络切换仍可能断线；不保证永久在线。长任务建议在VPS中使用tmux。不会自动重新执行未完成的命令。")
        QuietAction({vm.app.closeAll();vm.app.stopService(Intent(vm.app,dev.vpsdeck.ssh.ConnectionService::class.java))}) {ActionLabel("断开全部 SSH 连接",color=MaterialTheme.colorScheme.error)}
    }
}
