package dev.vpsdeck

import dev.vpsdeck.ui.clipboardChunks
import dev.vpsdeck.ui.terminalCommandBytes
import org.junit.Assert.*
import org.junit.Test

class InteractionContractTest {
    @Test fun previewCopyDoesNotIncludeCredentialsOrEnvironment() {
        val data=org.json.JSONObject().put("warning","explicit confirmation").put("auth",org.json.JSONObject().put("password","secret-fixture"))
            .put("services",org.json.JSONArray().put(org.json.JSONObject().put("name","web").put("image","fixture:1").put("environment","private-fixture")))
        val report=dev.vpsdeck.ui.previewReport(data)
        assertTrue(report.contains("explicit confirmation") && report.contains("fixture:1"))
        assertFalse(report.contains("secret-fixture") || report.contains("private-fixture"))
    }
    @Test fun commandIsUtf8WithOneExplicitPtyEnter() {
        assertArrayEquals("echo 中文\r".toByteArray(Charsets.UTF_8),terminalCommandBytes("echo 中文"))
    }
    @Test fun pastedControlCharactersCannotSubmitAdditionalCommands() {
        listOf("", " ","pwd\nid", "pwd\rid", "\u001b[A", "x\u0003", "x".repeat(64001)).forEach {
            assertTrue(runCatching {terminalCommandBytes(it)}.isFailure)
        }
    }
    @Test fun largeClipboardCopiesRetainEveryCharacterAndSurrogatePair() {
        val original="a".repeat(63999)+"🚀"+"中文".repeat(90000)
        val chunks=clipboardChunks(original)
        assertEquals(original,chunks.joinToString(""))
        assertTrue(chunks.all {it.length<=64000 && !it.last().isHighSurrogate() && !it.first().isLowSurrogate()})
    }
}
