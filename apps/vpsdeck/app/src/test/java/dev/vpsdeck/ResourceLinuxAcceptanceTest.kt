package dev.vpsdeck

import dev.vpsdeck.panel.*
import dev.vpsdeck.ssh.ExecResult
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Opt-in only on the disposable CI runner, never on a user's VPS. */
class ResourceLinuxAcceptanceTest {
    private fun exec(command: String): ExecResult {
        val output = File.createTempFile("vpsdeck-ci-", ".log")
        try {
            val p = ProcessBuilder("env", "LC_ALL=C", "sh", "-c", command).redirectErrorStream(true).redirectOutput(output).start()
            if(!p.waitFor(180, TimeUnit.SECONDS)) { p.destroyForcibly(); error("CI command timed out") }
            return ExecResult(p.exitValue(), output.readText())
        } finally { output.delete() }
    }
    private fun checked(command: String): String { val r = exec(command); check(r.code == 0) { r.output }; return r.output }
    @Test fun realDisposableSystemdServiceLifecycle() = runBlocking {
        assumeTrue(System.getenv("VPSDECK_LINUX_ACCEPTANCE") == "1")
        val id = "vpsdeck-ci-${UUID.randomUUID()}.service"
        val path = "/etc/systemd/system/$id"
        val body = "[Unit]\nDescription=VPS Deck disposable CI acceptance\n[Service]\nExecStart=/bin/sleep 600\n[Install]\nWantedBy=multi-user.target\n"
        val repo = ResourceRepository { exec(it) }
        try {
            checked("printf %s ${dev.vpsdeck.ops.Shell.quote(body)} | sudo tee $path >/dev/null")
            checked("sudo systemctl daemon-reload")
            var row = repo.detail(ResourceKind.SERVICE, Resource(id,id,"inactive"))
            for(action in listOf(ResourceAction.START,ResourceAction.RESTART,ResourceAction.ENABLE,ResourceAction.DISABLE,ResourceAction.STOP)) {
                val (before, result) = repo.act(ResourceKind.SERVICE,row,action,true) { }
                assertEquals(result.output,0,result.code)
                row = repo.detail(ResourceKind.SERVICE,row)
                assertTrue("${action.title}: $row", ResourceProtocol.verified(ResourceKind.SERVICE,action,before,row))
            }
            assertTrue(repo.list(ResourceKind.SERVICE).any { it.id == id })
        } finally {
            exec("sudo systemctl stop $id; sudo systemctl disable $id; sudo rm -f -- $path; sudo systemctl daemon-reload")
        }
    }
    @Test fun realDisposableDockerLifecycle() = runBlocking {
        assumeTrue(System.getenv("VPSDECK_LINUX_ACCEPTANCE") == "1")
        val name = "vpsdeck-ci-${UUID.randomUUID()}"
        val repo = ResourceRepository { exec(it) }
        try {
            checked("docker create --name $name alpine:3.20 sleep 600")
            var row = repo.detail(ResourceKind.CONTAINER,repo.list(ResourceKind.CONTAINER).single { it.name == name })
            for(action in listOf(ResourceAction.START,ResourceAction.RESTART,ResourceAction.STOP)) {
                val (before,result) = repo.act(ResourceKind.CONTAINER,row,action,false) { }
                assertEquals(result.output,0,result.code)
                row = repo.detail(ResourceKind.CONTAINER,row)
                assertTrue("${action.title}: $row",ResourceProtocol.verified(ResourceKind.CONTAINER,action,before,row))
            }
        } finally { exec("docker rm -f -- $name") }
    }
}
