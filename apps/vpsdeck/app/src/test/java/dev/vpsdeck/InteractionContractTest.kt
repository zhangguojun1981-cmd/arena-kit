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
        listOf("", " ", "pwd\tid", "\u001b[A", "x\u0003", "x".repeat(64001)).forEach {
            assertTrue(runCatching {terminalCommandBytes(it)}.isFailure)
        }
    }
    @Test fun multilinePreservesScriptsAndNormalizesLineEndings() {
        assertArrayEquals("pwd\rid\r".toByteArray(),terminalCommandBytes("pwd\r\nid\n"))
        assertArrayEquals("for x in a b; do\r  echo 中文\rdone\r".toByteArray(Charsets.UTF_8),terminalCommandBytes("for x in a b; do\n  echo 中文\ndone"))
    }
    @Test fun selectionAndSnapshotChecksRejectChangedRemoteObjects() {
        val f=RemoteFile("a","/a",false,false,12,"-rw-------",384,1000)
        val selected=dev.vpsdeck.ui.toggleFileSelection(emptySet(),f.path)
        assertEquals(setOf("/a"),selected)
        assertTrue(dev.vpsdeck.ui.toggleFileSelection(selected,f.path).isEmpty())
        assertTrue(dev.vpsdeck.ui.matchesFileSnapshot(f,false,false,12,1000,384))
        assertFalse(dev.vpsdeck.ui.matchesFileSnapshot(f,false,true,12,1000,384))
        assertFalse(dev.vpsdeck.ui.matchesFileSnapshot(f,false,false,13,1000,384))
        assertFalse(dev.vpsdeck.ui.matchesFileSnapshot(f,false,false,12,2000,384))
    }
    @Test fun largeClipboardCopiesRetainEveryCharacterAndSurrogatePair() {
        val original="a".repeat(63999)+"🚀"+"中文".repeat(90000)
        val chunks=clipboardChunks(original)
        assertEquals(original,chunks.joinToString(""))
        assertTrue(chunks.all {it.length<=64000 && !it.last().isHighSurrogate() && !it.first().isLowSurrogate()})
    }
}
