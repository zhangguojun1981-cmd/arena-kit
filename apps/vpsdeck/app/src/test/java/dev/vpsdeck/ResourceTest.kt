package dev.vpsdeck

import dev.vpsdeck.panel.*
import dev.vpsdeck.ssh.ExecResult
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class ResourceTest {
    @Test fun onlyStoppedContainersCanBeRemovedWithoutForceOrVolumeDeletion() {
        val row=Resource("a".repeat(64),"demo","exited")
        assertTrue(ResourceAction.REMOVE in ResourceProtocol.actions(ResourceKind.CONTAINER,row))
        assertFalse(ResourceAction.REMOVE in ResourceProtocol.actions(ResourceKind.CONTAINER,row.copy(state="running")))
        val command=ResourceProtocol.action(ResourceKind.CONTAINER,row,ResourceAction.REMOVE)
        assertTrue(command.startsWith("docker rm -- "))
        assertFalse(command.contains("--force"));assertFalse(command.contains(" -v"))
        assertTrue(ResourceProtocol.verified(ResourceKind.CONTAINER,ResourceAction.REMOVE,row,row.copy(state="removed")))
    }
    @Test fun deletionVerificationRequiresCompleteSuccessfulInventory() = runBlocking {
        val row=Resource("a".repeat(64),"demo","exited")
        val repo=ResourceRepository { ExecResult(0,"",false) }
        assertEquals("removed",repo.after(ResourceKind.CONTAINER,ResourceAction.REMOVE,row).state)
        val failed=ResourceRepository { ExecResult(1,"",false) }
        try { failed.after(ResourceKind.CONTAINER,ResourceAction.REMOVE,row); fail("must not infer absence from failure") } catch(_:IllegalStateException) {}
    }
    private val id = "a".repeat(64)
    private fun service(active: String = "active", invocation: String = "first") = "Id=demo.service\nLoadState=loaded\nActiveState=$active\nSubState=running\nDescription=Demo worker\nUnitFileState=enabled\nInvocationID=$invocation\nMainPID=12\nFragmentPath=/etc/systemd/system/demo.service\n"
    @Test fun mergesInstalledAndLoadedServices() {
        val rows = ResourceProtocol.services("demo.service loaded active running Demo worker\n", "demo.service enabled enabled\nidle.service disabled enabled\n")
        assertEquals(2, rows.size); assertEquals("enabled", rows.first().enabled); assertEquals("未载入", rows.last().state)
    }
    @Test fun rejectsMalformedList() { assertThrows(IllegalArgumentException::class.java) { ResourceProtocol.services("permission denied", "") } }
    @Test fun parsesDockerMachineRows() {
        val r = ResourceProtocol.containers("""{"ID":"$id","Names":"web","State":"running","Status":"Up 3 minutes","Image":"nginx:stable","Ports":"127.0.0.1:8080->80/tcp"}""").single()
        assertEquals(id, r.id); assertEquals("nginx:stable", r.facts["镜像"])
    }
    @Test fun rejectsContainerIdInjection() { assertThrows(IllegalArgumentException::class.java) { ResourceProtocol.detail(ResourceKind.CONTAINER, "x;reboot") } }
    @Test fun excludesCoreServiceActions() {
        for(name in listOf("ssh.service", "sshd.service", "systemd-networkd.service", "dbus.service", "ssh@client.service")) {
            assertTrue(ResourceProtocol.actions(ResourceKind.SERVICE, Resource(name, name, "active", enabled = "enabled")).isEmpty())
        }
    }
    @Test fun doesNotEnableStaticUnits() { assertFalse(ResourceAction.ENABLE in ResourceProtocol.actions(ResourceKind.SERVICE, Resource("x.service", "x", "inactive", enabled = "static"))) }
    @Test fun templateCannotBeStartedWithoutInstance() { assertTrue(ResourceProtocol.actions(ResourceKind.SERVICE, Resource("x@.service", "x", "inactive")).isEmpty()) }
    @Test fun verifiesRestartIdentityNotJustRunning() {
        val before = ResourceProtocol.serviceDetail(service())
        assertFalse(ResourceProtocol.verified(ResourceKind.SERVICE, ResourceAction.RESTART, before, before))
        assertTrue(ResourceProtocol.verified(ResourceKind.SERVICE, ResourceAction.RESTART, before, before.copy(version = "second")))
    }
    @Test fun failedStartIsNotSuccess() {
        val before = Resource("demo.service", "demo", "inactive")
        assertFalse(ResourceProtocol.verified(ResourceKind.SERVICE, ResourceAction.START, before, before.copy(state = "failed")))
    }
    @Test fun disabledMustBeVerified() {
        val before = Resource("demo.service", "demo", "active", enabled = "enabled")
        assertFalse(ResourceProtocol.verified(ResourceKind.SERVICE, ResourceAction.DISABLE, before, before))
        assertTrue(ResourceProtocol.verified(ResourceKind.SERVICE, ResourceAction.DISABLE, before, before.copy(enabled = "disabled")))
    }
    @Test fun refusesWrongIdentity() {
        assertFalse(ResourceProtocol.verified(ResourceKind.CONTAINER, ResourceAction.START, Resource(id,"web","created"), Resource("b".repeat(64),"web","running")))
    }
    @Test fun containerDetailOnlyShowsSafeStateFields() {
        val row = Resource(id,"web","running")
        val r = ResourceProtocol.containerDetail(row,"""{"Status":"running","StartedAt":"2026-10-06T00:00:00Z","ExitCode":0,"Health":{"Status":"healthy"}}""")
        assertEquals("healthy", r.facts["健康状态"]); assertTrue(r.version.isNotBlank())
        assertFalse(ResourceProtocol.detail(ResourceKind.CONTAINER,id).contains(".Config"))
    }
    @Test fun staleConfirmationDoesNotExecute() = runBlocking {
        var submitted = false; var calls = 0
        val repo = ResourceRepository { calls++; ExecResult(0, service("inactive")) }
        try { repo.act(ResourceKind.SERVICE, ResourceProtocol.serviceDetail(service()), ResourceAction.STOP, false) { submitted = true }; fail("expected conflict") } catch(_: IllegalStateException) { }
        assertFalse(submitted); assertEquals(1,calls)
    }
    @Test fun truncatedListIsNotDisplayed() = runBlocking {
        val repo = ResourceRepository { ExecResult(0,"demo.service loaded active running demo",true) }
        try { repo.list(ResourceKind.SERVICE); fail("expected truncation rejection") } catch(_: IllegalStateException) { }
    }
    @Test fun sudoIsExplicitAndPreservesNonzeroExit() = runBlocking {
        val commands = mutableListOf<String>(); var submitted = false
        val repo = ResourceRepository { command -> commands += command; if(commands.size == 1) ExecResult(0, service()) else ExecResult(5,"denied") }
        val (_, result) = repo.act(ResourceKind.SERVICE,ResourceProtocol.serviceDetail(service()),ResourceAction.STOP,true) { submitted = true }
        assertTrue(submitted); assertEquals(5,result.code); assertTrue(commands.last().startsWith("sudo -n -- sh -c ")); assertTrue(commands.last().contains("stop"))
    }
    @Test fun unsupportedDockerStatesHaveNoUnsafeControls() { assertTrue(ResourceProtocol.actions(ResourceKind.CONTAINER,Resource(id,"web","paused")).isEmpty()) }
}
