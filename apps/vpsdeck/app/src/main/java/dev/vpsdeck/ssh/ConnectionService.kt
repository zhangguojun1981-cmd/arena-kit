package dev.vpsdeck.ssh

import android.app.*
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import dev.vpsdeck.*

class ConnectionService : Service() {
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
        return START_NOT_STICKY
    }
    override fun onDestroy() { (application as DeckApp).closeAll(); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
}
