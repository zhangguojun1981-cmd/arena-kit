package dev.vpsdeck

import com.jcraft.jsch.HostKey
import dev.vpsdeck.data.*
import dev.vpsdeck.ssh.*
import kotlinx.coroutines.runBlocking
import org.apache.sshd.common.file.virtualfs.VirtualFileSystemFactory
import org.apache.sshd.common.keyprovider.KeyPairProvider
import org.apache.sshd.server.SshServer
import org.apache.sshd.server.Environment
import org.apache.sshd.server.ExitCallback
import org.apache.sshd.server.channel.ChannelSession
import org.apache.sshd.server.command.Command
import org.apache.sshd.server.command.CommandFactory
import org.apache.sshd.sftp.server.SftpSubsystemFactory
import org.junit.*
import org.junit.Assert.*
import java.io.*
import java.nio.file.Files
import java.security.KeyPairGenerator
import java.util.concurrent.atomic.AtomicInteger

/** Disposable loopback fixture, never connects to a user's VPS. */
class SshIntegrationTest {
    private lateinit var fixture: SshServer
    private lateinit var profile: Server
    private lateinit var pool: SshPool
    private val authCalls = AtomicInteger()
    private val root = Files.createTempDirectory("vpsdeck-sshd-").toFile()
    @Before fun setup() {
        val key = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        fixture = SshServer.setUpDefaultServer().apply {
            host = "127.0.0.1"; port = 0; keyPairProvider = KeyPairProvider.wrap(key)
            passwordAuthenticator = org.apache.sshd.server.auth.password.PasswordAuthenticator { user, pass, _ -> authCalls.incrementAndGet(); user == "fixture" && pass == "test-only-password" }
            subsystemFactories = listOf(SftpSubsystemFactory.Builder().build())
            fileSystemFactory = VirtualFileSystemFactory(root.toPath())
            commandFactory = CommandFactory { _, command -> FixtureCommand(command) }
        }
        fixture.start()
        profile = Server(name = "Loopback fixture", host = "127.0.0.1", port = fixture.port, username = "fixture")
        pool = SshPool(CredentialReader { Credentials(password = "test-only-password") })
    }
    @After fun teardown() { pool.disconnectAll(); fixture.stop(true); root.deleteRecursively() }
    private suspend fun pinned(): Server {
        try { pool.connect(profile); error("Untrusted host must not connect") }
        catch(c: HostChallenge) { assertFalse(c.changed); return profile.copy(fingerprint = c.observed) }
    }
    @Test fun firstContactRequiresTrustBeforeAuthentication() = runBlocking {
        val trusted = pinned(); assertTrue(trusted.fingerprint.startsWith("SHA256:")); assertEquals(0, authCalls.get())
        pool.connect(trusted); assertTrue(pool.isConnected(trusted.id)); assertTrue(authCalls.get() > 0)
    }
    @Test fun changedHostKeyRejectedBeforeAuthentication() = runBlocking {
        try { pool.connect(profile.copy(fingerprint = "SHA256:wrong-key")); fail("Must reject") }
        catch(c: HostChallenge) { assertTrue(c.changed); assertEquals(0, authCalls.get()) }
    }
    @Test fun wrongPasswordDoesNotConnect() = runBlocking {
        val trusted = pinned(); val bad = SshPool(CredentialReader { Credentials(password = "wrong") })
        try { bad.connect(trusted); fail("Must reject wrong password") } catch(e: Exception) { assertFalse(e is HostChallenge) } finally { bad.disconnectAll() }
    }
    @Test fun execPreservesOutputAndExitCode() = runBlocking {
        val trusted = pinned(); pool.connect(trusted)
        val success = pool.exec(trusted, "fixture-ok"); assertEquals(0, success.code); assertTrue(success.output.contains("fixture stdout"))
        val failure = pool.exec(trusted, "fixture-error"); assertEquals(7, failure.code); assertTrue(failure.output.contains("fixture stderr"))
    }
    @Test fun outputIsBoundedAndStillDrained() = runBlocking {
        val trusted = pinned(); pool.connect(trusted); val result = pool.exec(trusted, "fixture-large")
        assertTrue(result.truncated); assertEquals(0, result.code); assertTrue(result.output.length <= 262144)
    }
    @Test fun sftpRoundTripAndDirectories() = runBlocking {
        val trusted = pinned(); pool.connect(trusted)
        pool.sftp(trusted) { s -> s.mkdir("/sample"); s.put("hello world".byteInputStream(), "/sample/test.txt"); assertEquals("hello world", s.get("/sample/test.txt").bufferedReader().use { it.readText() }); s.rename("/sample/test.txt", "/sample/renamed.txt"); s.rm("/sample/renamed.txt"); s.rmdir("/sample") }
    }
    @Test fun disconnectedActionsDoNotReconnectOrReplay() = runBlocking {
        val trusted = pinned(); pool.connect(trusted); pool.disconnect(trusted.id); val before = authCalls.get()
        try { pool.exec(trusted, "fixture-ok"); fail("Must not auto-connect") } catch(e: IllegalStateException) { assertEquals(before, authCalls.get()) }
    }
    private class FixtureCommand(private val command: String) : Command {
        private lateinit var out: OutputStream; private lateinit var err: OutputStream; private lateinit var callback: ExitCallback
        private var worker: Thread? = null
        override fun setInputStream(input: InputStream) = Unit
        override fun setOutputStream(output: OutputStream) { out = output }
        override fun setErrorStream(error: OutputStream) { err = error }
        override fun setExitCallback(exitCallback: ExitCallback) { callback = exitCallback }
        override fun start(channel: ChannelSession, env: Environment) {
            worker = Thread {
                try {
                    if(command.contains("fixture-large")) out.write(ByteArray(400000) { 65 }) else out.write("fixture stdout".toByteArray())
                    if(command.contains("fixture-error")) err.write("fixture stderr".toByteArray())
                    out.flush(); err.flush(); callback.onExit(if(command.contains("fixture-error")) 7 else 0)
                } catch(_: IOException) { callback.onExit(1) }
            }.apply { isDaemon = true; start() }
        }
        override fun destroy(channel: ChannelSession) { worker?.interrupt() }
    }
}
