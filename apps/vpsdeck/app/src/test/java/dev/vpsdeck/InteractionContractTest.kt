package dev.vpsdeck

import dev.vpsdeck.ui.clipboardChunks
import dev.vpsdeck.ops.FileIndex
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class InteractionContractTest {
    @Test fun previewCopyDoesNotIncludeCredentialsOrEnvironment() {
        val data=JSONObject().put("warning","explicit confirmation").put("auth",JSONObject().put("password","secret-fixture"))
            .put("services",org.json.JSONArray().put(JSONObject().put("name","web").put("image","fixture:1").put("environment","private-fixture")))
        val report=dev.vpsdeck.ui.previewReport(data)
        assertTrue(report.contains("explicit confirmation") && report.contains("fixture:1"))
        assertFalse(report.contains("secret-fixture") || report.contains("private-fixture"))
    }
    @Test fun largeClipboardCopiesRetainEveryCharacterAndSurrogatePair() {
        val original="a".repeat(63999)+"🚀"+"中文".repeat(90000)
        val chunks=clipboardChunks(original)
        assertEquals(original,chunks.joinToString(""))
        assertTrue(chunks.all {it.length<=64000 && !it.last().isHighSurrogate() && !it.first().isLowSurrogate()})
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
    @Test fun fileSnapshotCommandsAreQuotedAndBounded() {
        val build=FileIndex.buildCommand("/data/my site",1000)
        assertTrue(build.contains("find '/data/my site' -xdev"))
        assertTrue(build.contains("head -n 1000"))
        listOf("/proc","/sys","/dev","/run","/snap").forEach {assertTrue(build.contains("-path $it"))}
        assertTrue(build.contains("/var/lib/vpsdeck-private/filesnap"))
        assertTrue(build.contains("-printf"))
        val search=FileIndex.searchCommand("-rf *",true)
        assertTrue(search.contains("grep -F -i -m 500 -- '-rf *'"))
        assertTrue(runCatching{FileIndex.searchCommand("",false)}.isFailure)
        assertTrue(runCatching{FileIndex.searchCommand(" ".repeat(5),false)}.isFailure)
        assertTrue(runCatching{FileIndex.searchCommand("x".repeat(401),false)}.isFailure)
        assertTrue(runCatching{FileIndex.searchCommand("a\u0000b",false)}.isFailure)
        assertEquals(1000,FileIndex.maxEntries("1000"))
        assertTrue(runCatching{FileIndex.maxEntries("9")}.isFailure)
        assertTrue(runCatching{FileIndex.maxEntries("9999999")}.isFailure)
        assertTrue(runCatching{FileIndex.maxEntries("nope")}.isFailure)
    }
    @Test fun fileIndexLinesParseWithTabsAndLimits() {
        val out=dev.vpsdeck.ssh.ExecResult(0,"f\t644\t100\t1696540800.5\t/tmp/ok file\nd\t755\t0\t1696540801\t/tmp/dir\nl\t777\t0\t1696540802\t/tmp/link\nbadline\n")
        val hits=FileIndex.parseHits(out)
        assertEquals(3,hits.size)
        assertEquals("/tmp/ok file",hits[0].path); assertEquals("ok file",hits[0].name)
        assertTrue(hits[1].directory && !hits[2].directory)
        assertEquals(420,hits[0].permissions)
        assertEquals(1696540800000L,hits[0].modifiedMs)
    }
    @Test fun searchWithoutSnapshotFailsWithActionableMessage() {
        val e=runCatching{FileIndex.parseHits(dev.vpsdeck.ssh.ExecResult(FileIndex.NO_SNAPSHOT_EXIT,""))}
        assertTrue(e.isFailure && e.exceptionOrNull()!!.message!!.contains("快照"))
        val e2=runCatching{FileIndex.parseHits(dev.vpsdeck.ssh.ExecResult(12,"boom"))}
        assertTrue(e2.isFailure)
        val meta=FileIndex.parseMeta("noise\n/var/log\t123\t1696540800",200000)
        assertNotNull(meta); assertEquals("/var/log",meta!!.root); assertEquals(123L,meta.entries); assertFalse(meta.truncated)
        val meta2=FileIndex.parseMeta("/data\t200000\t1696540800",200000)
        assertTrue(meta2!!.truncated)
        assertTrue(FileIndex.parseMeta("BUILT 3",200000)==null)
    }
}
