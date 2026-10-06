package dev.vpsdeck

import dev.vpsdeck.panel.JobProtocol
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class JobProtocolTest {
    @Test fun privilegeIsExplicitAndBootstrapNeverContainsPayload() {
        assertTrue(JobProtocol.command(false).startsWith("python3 -c "))
        assertTrue(JobProtocol.command(true).startsWith("sudo -n -- python3 -c "))
        assertTrue(JobProtocol.command(false).contains("sys.stdin"))
        assertFalse(JobProtocol.command(false).contains("password="))
    }
    @Test fun unknownRemoteStatesAreNeverSuccess() {
        assertEquals("结果未知",JobProtocol.state("disconnected"))
        assertEquals("需核查",JobProtocol.state("needs_review"))
        assertEquals("远端执行中",JobProtocol.state("running"))
        assertEquals("成功",JobProtocol.state("succeeded"))
    }
    @Test fun absentTaskListIsEmpty() { assertTrue(JobProtocol.rows(JSONObject(),"jobs").isEmpty()) }
}
