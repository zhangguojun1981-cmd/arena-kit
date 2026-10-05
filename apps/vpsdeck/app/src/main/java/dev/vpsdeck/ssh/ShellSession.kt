package dev.vpsdeck.ssh

import com.jcraft.jsch.ChannelShell
import com.termux.terminal.*
import dev.vpsdeck.data.Server
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import java.util.UUID

class ShellSession(val server: Server, private val pool: SshPool, private val scope: CoroutineScope) {
    val id = UUID.randomUUID().toString()
    val state = MutableStateFlow("连接中")
    private val writes = Channel<ByteArray>(64)
    private var channel: ChannelShell? = null
    private var job: Job? = null
    var onChanged: (() -> Unit)? = null
    val emulator = TerminalEmulator(object : TerminalOutput() {
        override fun write(data: ByteArray, offset: Int, count: Int) { writeBytes(data.copyOfRange(offset, offset + count)) }
        override fun titleChanged(oldTitle: String?, newTitle: String?) = Unit
        // Remote OSC52 must not silently read or change the phone clipboard.
        override fun onCopyTextToClipboard(text: String?) = Unit
        override fun onPasteTextFromClipboard() = Unit
        override fun onBell() = Unit
        override fun onColorsChanged() { onChanged?.invoke() }
    }, 80, 24, 2000, object : TerminalSessionClient {
        override fun onTextChanged(s: TerminalSession?) = Unit
        override fun onTitleChanged(s: TerminalSession?) = Unit
        override fun onSessionFinished(s: TerminalSession?) = Unit
        override fun onCopyTextToClipboard(s: TerminalSession?, text: String?) = Unit
        override fun onPasteTextFromClipboard(s: TerminalSession?) = Unit
        override fun onBell(s: TerminalSession?) = Unit
        override fun onColorsChanged(s: TerminalSession?) = Unit
        override fun onTerminalCursorStateChange(state: Boolean) = Unit
        override fun getTerminalCursorStyle() = 0
        override fun logError(tag: String?, message: String?) = Unit
        override fun logWarn(tag: String?, message: String?) = Unit
        override fun logInfo(tag: String?, message: String?) = Unit
        override fun logDebug(tag: String?, message: String?) = Unit
        override fun logVerbose(tag: String?, message: String?) = Unit
        override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) = Unit
        override fun logStackTrace(tag: String?, e: Exception?) = Unit
    })
    fun open() {
        job = scope.launch(Dispatchers.IO) {
            var writer: Job? = null
            try {
                val shell = pool.requireSession(server.id).openChannel("shell") as ChannelShell
                channel = shell; shell.setPty(true); shell.setPtyType("xterm-256color", emulator.mColumns, emulator.mRows, 0, 0)
                val input = shell.inputStream; val output = shell.outputStream
                shell.connect(10_000); state.value = "已连接"
                writer = launch(Dispatchers.IO) { for(bytes in writes) { output.write(bytes); output.flush() } }
                val buffer = ByteArray(8192)
                while(isActive && shell.isConnected) {
                    val n = input.read(buffer); if(n < 0) break
                    val bytes = buffer.copyOf(n)
                    withContext(Dispatchers.Main.immediate) { emulator.append(bytes, bytes.size); onChanged?.invoke() }
                }
                state.value = "已结束 · exit ${shell.exitStatus}"
            } catch(e: Exception) { state.value = if(e is CancellationException) "已关闭" else "连接中断；未重放命令" }
            finally { channel?.disconnect(); writer?.cancel(); writes.close() }
        }
    }
    fun writeBytes(bytes: ByteArray) { if(state.value == "已连接" && !writes.trySend(bytes).isSuccess) state.value = "输入队列已满，请新建终端" }
    fun write(text: String) = writeBytes(text.toByteArray())
    fun resize(columns: Int, rows: Int) { scope.launch(Dispatchers.IO) { runCatching { channel?.setPtySize(columns, rows, 0, 0) } } }
    fun paste(text: String) { require(text.length <= 64_000) { "单次粘贴最多 64000 字符" }; emulator.paste(text) }
    fun close() { channel?.disconnect(); writes.close(); job?.cancel(); onChanged = null; state.value = "已关闭" }
}
