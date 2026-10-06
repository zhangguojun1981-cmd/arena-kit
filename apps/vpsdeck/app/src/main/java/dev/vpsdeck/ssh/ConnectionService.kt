package dev.vpsdeck.ssh

import android.app.*
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import dev.vpsdeck.*
import kotlinx.coroutines.*

class ConnectionService : Service() {
    private var monitor: Job? = null
    private var cleanStop=false
    private var latestStartId=0
    private var wake: android.os.PowerManager.WakeLock? = null
    private var renewedAt = 0L
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("ssh", "SSH 活动连接", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        latestStartId=startId
        cleanStop=false
        if(intent?.action == "disconnect") { (application as DeckApp).closeAll(); cleanStop=true;stopSelf(); return START_NOT_STICKY }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val close = PendingIntent.getService(this, 1, Intent(this, ConnectionService::class.java).setAction("disconnect"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val battery = PendingIntent.getActivity(this, 2, Intent(android.content.Intent.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, android.net.Uri.parse("package:$packageName")).setPackage(packageName), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        startForeground(101, NotificationCompat.Builder(this, "ssh").setSmallIcon(R.drawable.ic_deck).setContentTitle("VPS Deck · SSH 连接")
            .setContentText("终端与传输可在后台运行；点击返回，或断开全部连接。").setContentIntent(open).setOngoing(true)
            .addAction(0, "电池设置", battery).addAction(0, "断开全部", close).build())
        (application as DeckApp).connectionServiceActive.value=true
        if(wake==null) wake=getSystemService(android.os.PowerManager::class.java).newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK,"VPSDeck:activeSSH").apply {setReferenceCounted(false)}
        renewWakeLock()
        if(monitor?.isActive != true) monitor = (application as DeckApp).appScope.launch {
            while(isActive) {
                delay(5000)
                val app=(application as DeckApp)
                val pool = app.ssh
                val before=pool.connected.value
                val after=before.toList().filter { pool.isConnected(it) }.toSet()
                if(after!=before) {
                    val names=before-after
                    app.recordDisconnect(java.text.SimpleDateFormat("MM-dd HH:mm:ss",java.util.Locale.ROOT).format(java.util.Date())+
                        " "+names.joinToString(","){ (app.database.dao().server(it)?.name ?: it) }+" SSH断开（当时：连接服务仍在运行）——多为网络/锁屏休眠，见设置中“后台连接”建议")
                }
                if(after.isEmpty() && app.connecting.value.isEmpty()) {
                    cleanStop=true
                    if(stopSelfResult(latestStartId)) break
                    cleanStop=false
                }
                renewWakeLock()
            }
        }
        return START_NOT_STICKY
    }
    private fun renewWakeLock() {
        val now=android.os.SystemClock.elapsedRealtime()
        if(wake?.isHeld!=true || now-renewedAt>=5*60*1000) {wake?.acquire(10*60*1000L);renewedAt=now}
    }
    override fun onDestroy() {
        val app=(application as DeckApp)
        if(!cleanStop && app.ssh.connected.value.isNotEmpty()) {
            app.recordDisconnect(java.text.SimpleDateFormat("MM-dd HH:mm:ss",java.util.Locale.ROOT).format(java.util.Date())+
                " 连接服务被停止且仍有活动连接——应用进程可能已被系统终止（见“后台连接”中的豁免请求）")
        }
        app.connectionServiceActive.value=false; monitor?.cancel(); wake?.let {if(it.isHeld) it.release()};wake=null
        if(!cleanStop) app.closeAll(); super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
