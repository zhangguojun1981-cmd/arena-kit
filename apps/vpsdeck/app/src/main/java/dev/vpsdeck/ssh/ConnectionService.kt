package dev.vpsdeck.ssh

import android.app.*
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import dev.vpsdeck.*
import kotlinx.coroutines.*

class ConnectionService : Service() {
    private var monitor: Job? = null
    private var wake: android.os.PowerManager.WakeLock? = null
    private var renewedAt = 0L
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("ssh", "SSH 活动连接", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if(intent?.action == "disconnect") { (application as DeckApp).closeAll(); stopSelf(); return START_NOT_STICKY }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val close = PendingIntent.getService(this, 1, Intent(this, ConnectionService::class.java).setAction("disconnect"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        startForeground(101, NotificationCompat.Builder(this, "ssh").setSmallIcon(R.drawable.ic_deck).setContentTitle("VPS Deck · SSH 连接")
            .setContentText("终端与传输可在后台运行；点击返回，或断开全部连接。").setContentIntent(open).setOngoing(true).addAction(0, "断开全部", close).build())
        (application as DeckApp).connectionServiceActive.value=true
        if(wake==null) wake=getSystemService(android.os.PowerManager::class.java).newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK,"VPSDeck:activeSSH").apply {setReferenceCounted(false)}
        renewWakeLock()
        if(monitor?.isActive != true) monitor = (application as DeckApp).appScope.launch {
            while(isActive) {
                delay(5000)
                val pool = (application as DeckApp).ssh
                pool.connected.value.toList().forEach { pool.isConnected(it) }
                if(pool.connected.value.isEmpty() && (application as DeckApp).connecting.value.isEmpty()) { stopSelf(); break }
                renewWakeLock()
            }
        }
        return START_NOT_STICKY
    }
    private fun renewWakeLock() {
        val now=android.os.SystemClock.elapsedRealtime()
        if(wake?.isHeld!=true || now-renewedAt>=5*60*1000) {wake?.acquire(10*60*1000L);renewedAt=now}
    }
    override fun onDestroy() { (application as DeckApp).connectionServiceActive.value=false; monitor?.cancel(); wake?.let {if(it.isHeld) it.release()};wake=null; (application as DeckApp).closeAll(); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
}
