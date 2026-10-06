package dev.vpsdeck

import dev.vpsdeck.panel.WebsiteProtocol
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class WebsiteProtocolTest {
    @Test fun freshWebsiteHasUniqueIdAndSafeDirectory() {
        val a=JSONObject(WebsiteProtocol.fresh());val b=JSONObject(WebsiteProtocol.fresh())
        assertNotEquals(a.getString("id"),b.getString("id"))
        assertTrue(a.getString("id").matches(Regex("[a-f0-9]{32}")))
        assertEquals("/var/www/vpsdeck/"+a.getString("id"),a.getString("root"))
        assertFalse(a.getBoolean("tls"));assertEquals(80,a.getInt("port"))
    }
    @Test fun requestCannotInjectShellSyntax() {
        val command=WebsiteProtocol.command("print('hello')",JSONObject().put("domain","x'; reboot; #"),false)
        assertFalse(command.contains("reboot"));assertTrue(command.startsWith("python3 -c "))
        assertTrue(command.contains("'\"'\"'"))
    }
    @Test fun elevationIsExplicit() {
        val j=JSONObject().put("op","list")
        assertFalse(WebsiteProtocol.command("x",j,false).startsWith("sudo"))
        assertTrue(WebsiteProtocol.command("x",j,true).startsWith("sudo -n -- python3"))
    }
    @Test fun missingOptionalDiscoveryListIsEmpty() {assertTrue(WebsiteProtocol.strings(JSONObject(),"phpSockets").isEmpty())}
}
