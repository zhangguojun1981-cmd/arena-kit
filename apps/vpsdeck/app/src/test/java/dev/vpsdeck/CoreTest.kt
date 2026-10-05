package dev.vpsdeck

import dev.vpsdeck.ops.*
import org.junit.Assert.*
import org.junit.Test

class CoreTest {
    @Test fun shellQuotesMetacharacters() { assertEquals("'a'\"'\"'b;\$(id)'", Shell.quote("a'b;\$(id)")) }
    @Test fun emptyQuote() { assertEquals("''", Shell.quote("")) }
    @Test(expected = IllegalArgumentException::class) fun rejectsNul() { Shell.quote("a\u0000b") }
    @Test(expected = IllegalArgumentException::class) fun rejectsInjectedService() { Operations.service("nginx;reboot", "启动") }
    @Test(expected = IllegalArgumentException::class) fun rejectsOptionService() { Operations.service("--root", "停止") }
    @Test(expected = IllegalArgumentException::class) fun rejectsRelativeComposePath() { Operations.compose("../opt", "应用配置") }
    @Test(expected = IllegalArgumentException::class) fun rejectsInvalidContainer() { Operations.container("a && whoami", "重启") }
    @Test(expected = IllegalArgumentException::class) fun rejectsDatabaseInjection() { Operations.database("MySQL", "x;id", "/tmp/out", false) }
    @Test fun backupNoClobberAndNoPasswordArg() { val op = Operations.database("MySQL", "app", "/tmp/a b.sql", false); assertTrue(op.command.contains("set -C")); assertTrue(op.command.contains("'/tmp/a b.sql'")); assertFalse(op.command.contains("password=")) }
    @Test fun reloadIsValidated() { assertEquals("nginx -t && systemctl reload nginx", Operations.nginxReload.command) }
    @Test fun composeDoesNotDeleteVolumes() { assertFalse(Operations.compose("/opt/a", "移除服务").command.contains("-v")) }
    @Test fun sudoUsesNonInteractiveFixedShell() { assertTrue(Operations.services.privileged(true).command.startsWith("sudo -n -- sh -c '")) }
    @Test fun missingMetricsAreNotInvented() { val s = Metrics.parse("OS=Debian", 1000); assertNull(s.cpuPercent); assertNull(s.memoryUsedPercent); assertNull(s.diskUsedPercent) }
    @Test fun computesDeltas() { val first = Metrics.parse("CPU=100 50\nNET=1000 2000\nMEM=25\nDISK=40", 1000); val second = Metrics.parse("CPU=200 75\nNET=3000 4000\nMEM=25\nDISK=40", 3000, first); assertEquals(75f, second.cpuPercent!!, 0.01f); assertEquals(1000L, second.rxPerSecond); assertEquals(25f, second.memoryUsedPercent!!, 0.01f) }
    @Test fun resetCountersAreUnknown() { val a = Metrics.parse("CPU=100 50\nNET=500 500", 1000); val b = Metrics.parse("CPU=10 5\nNET=20 20", 2000, a); assertNull(b.cpuPercent); assertNull(b.rxPerSecond) }
    @Test(expected = IllegalArgumentException::class) fun rejectsPathTraversalFilename() { Shell.filename("../secret") }
}
