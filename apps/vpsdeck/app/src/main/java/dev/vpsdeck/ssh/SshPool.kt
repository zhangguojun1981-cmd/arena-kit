package dev.vpsdeck.ssh

import com.jcraft.jsch.*
import dev.vpsdeck.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

class HostChallenge(val server: Server, val observed: String, val algorithm: String, val changed: Boolean) : Exception(if(changed) "服务器主机密钥已变化，连接被拒绝" else "首次连接需要核对 SSH 主机指纹")
data class ExecResult(val code: Int, val output: String, val truncated: Boolean = false)

class SshPool(private val vault: CredentialReader) {
    private val sessions = ConcurrentHashMap<String, Session>()
    private val generations = ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicLong>()
    private val locks = ConcurrentHashMap<String, Mutex>()
    private val _connected = MutableStateFlow<Set<String>>(emptySet())
    val connected = _connected.asStateFlow()
    @Synchronized private fun publish() { _connected.value = sessions.filterValues { it.isConnected }.keys.toSet() }
    suspend fun connect(server: Server): Session = withContext(Dispatchers.IO) {
        locks.computeIfAbsent(server.id) { Mutex() }.withLock {
            sessions[server.id]?.takeIf { it.isConnected }?.let { return@withLock it }
            val generation=generations.computeIfAbsent(server.id) {java.util.concurrent.atomic.AtomicLong()}
            val epoch=generation.get()
            val credentials = vault.get(server.id)
            val jsch = JSch()
            var observed: HostChallenge? = null
            jsch.setHostKeyRepository(object : HostKeyRepository {
                override fun check(host: String, key: ByteArray): Int {
                    val fp = "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(key))
                    val type = HostKey(host, key).type
                    if(server.fingerprint == fp) return HostKeyRepository.OK
                    observed = HostChallenge(server, fp, type, server.fingerprint.isNotEmpty())
                    return if(server.fingerprint.isEmpty()) HostKeyRepository.NOT_INCLUDED else HostKeyRepository.CHANGED
                }
                override fun add(hostkey: HostKey, ui: UserInfo?) = Unit
                override fun remove(host: String, type: String?) = Unit
                override fun remove(host: String, type: String?, key: ByteArray?) = Unit
                override fun getKnownHostsRepositoryID() = "VPS Deck pinned host keys"
                override fun getHostKey(): Array<HostKey> = emptyArray()
                override fun getHostKey(host: String?, type: String?): Array<HostKey> = emptyArray()
            })
            if(server.auth == "key") {
                require(credentials.privateKey.isNotBlank()) { "没有保存 SSH 私钥，请编辑服务器后导入" }
                val key = credentials.privateKey.toByteArray(); val pass = credentials.passphrase.toByteArray()
                try { jsch.addIdentity(server.id, key, null, pass) } finally { key.fill(0); pass.fill(0) }
            }
            val session = jsch.getSession(server.username, server.host, server.port)
            session.setConfig("StrictHostKeyChecking", "yes")
            session.setConfig("PreferredAuthentications", if(server.auth == "key") "publickey" else "password")
            // Never auto-negotiate deprecated SHA1 ssh-rsa/DSS/MD5 algorithms.
            if(server.auth != "key") session.setPassword(credentials.password)
            session.serverAliveInterval = 20_000; session.serverAliveCountMax = 3
            session.timeout = 30_000
            try { session.connect(15_000)
                val context=currentCoroutineContext()
                synchronized(this@SshPool) {
                    context.ensureActive()
                    check(generation.get()==epoch) {"连接请求已取消"}
                    sessions[server.id] = session; publish()
                }
                session
            }
            catch(e: Exception) { session.disconnect(); publish(); throw observed ?: e }
            finally { jsch.removeAllIdentity() }
        }
    }
    @Synchronized fun disconnect(id: String) { generations.computeIfAbsent(id) {java.util.concurrent.atomic.AtomicLong()}.incrementAndGet(); sessions.remove(id)?.disconnect(); publish() }
    fun disconnectAll() { (sessions.keys+generations.keys).toSet().forEach(::disconnect) }
    fun isConnected(id: String): Boolean { publish(); return sessions[id]?.isConnected == true }
    /** Privileged/action requests never reconnect implicitly. */
    fun requireSession(id: String): Session = sessions[id]?.takeIf { it.isConnected } ?: throw IllegalStateException("连接已断开，请手动重连；操作未自动重放")
    suspend fun exec(server: Server, command: String, timeoutSeconds: Int = 45, input: ByteArray? = null): ExecResult = withContext(Dispatchers.IO) {
        require((input?.size ?: 0) <= 1024 * 1024) { "结构化请求不能超过1MiB，文件请用SFTP" }
        val channel = requireSession(server.id).openChannel("exec") as ChannelExec
        channel.setCommand("export LC_ALL=C; PATH=\"\$PATH:/usr/sbin:/sbin\"; export PATH; $command")
        // Future database/container credentials travel on SSH stdin, never in process argv.
        // The caller retains ownership of the original array; only this working copy is cleared.
        val requestBytes = input?.copyOf()
        channel.setInputStream(requestBytes?.inputStream())
        val output = channel.inputStream; val error = channel.errStream
        coroutineScope {
            try {
                channel.connect(10_000)
                val a = async(Dispatchers.IO) { readLimited(output) }; val b = async(Dispatchers.IO) { readLimited(error) }
                withTimeout(timeoutSeconds * 1000L) { while(!channel.isClosed) delay(60) }
                val stdout = a.await(); val stderr = b.await()
                ExecResult(channel.exitStatus, stdout.first + if(stderr.first.isNotBlank()) "\n[stderr]\n" + stderr.first else "", stdout.second || stderr.second)
            } finally { channel.disconnect(); requestBytes?.fill(0); publish() }
        }
    }
    private fun readLimited(input: InputStream): Pair<String, Boolean> {
        val out = ByteArrayOutputStream(); val buffer = ByteArray(8192); var truncated = false
        while(true) { val n = input.read(buffer); if(n < 0) break; val available = (256 * 1024 - out.size()).coerceAtLeast(0)
            if(n > available) truncated = true; if(available > 0) out.write(buffer, 0, minOf(n, available)) }
        return out.toString("UTF-8") to truncated
    }
    suspend fun <T> sftp(server: Server, action: (ChannelSftp) -> T): T = withContext(Dispatchers.IO) {
        val channel = requireSession(server.id).openChannel("sftp") as ChannelSftp
        try { channel.connect(10_000); action(channel) } finally { channel.disconnect(); publish() }
    }
}
