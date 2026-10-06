package dev.vpsdeck

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.vpsdeck.ui.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@androidx.test.filters.SdkSuppress(minSdkVersion=31)
@RunWith(AndroidJUnit4::class)
class DesignDeviceTest {
    @get:Rule val ui=createComposeRule()
    private fun shellOutput(command: String): String {
        val descriptor=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
        return android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use {it.readText()}
    }
    @android.annotation.SuppressLint("NewApi") // Screenshot suite runs on the API 34 CI emulator.
    private fun screenshot(name: String, node: SemanticsNodeInteraction = ui.onRoot()) {
        val bytes=java.io.ByteArrayOutputStream().use {stream ->
            assertTrue(node.captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG,100,stream))
            stream.toByteArray()
        }
        val path="/data/local/tmp/vpsdeck-ui-preview/$name.png"
        shellOutput("mkdir -p /data/local/tmp/vpsdeck-ui-preview")
        // UiAutomation starts an executable directly: do not use shell operators or redirection.
        val pipes=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommandRw("dd of=$path")
        android.os.ParcelFileDescriptor.AutoCloseOutputStream(pipes[1]).use {it.write(bytes)}
        android.os.ParcelFileDescriptor.AutoCloseInputStream(pipes[0]).use {it.copyTo(java.io.ByteArrayOutputStream())}
        assertEquals("Screenshot size",bytes.size.toString(),shellOutput("stat -c %s $path").trim())
    }
    @Test fun managementCardsOnlySelectACategory() {
        var selected=-1
        ui.setContent {MaterialTheme(colorScheme=DeckDark,typography=DeckTypography) {
            Surface {ManagementHub {selected=it}}
        }}
        ui.onNodeWithText("数据库").performScrollTo().assertIsDisplayed().performClick()
        ui.runOnIdle {assertEquals(4,selected)}
        screenshot("management-dark")
    }
    @Test fun resourceFirstListAndDetailRenderWithoutAnActionWall() {
        ui.setContent {MaterialTheme(colorScheme=DeckDark,typography=DeckTypography) {
            Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                ManagementHeading("网站管理","原生布局测试样例 · 非真实服务器数据")
                CollectionToolbar(3,"新建",{}, {}) {PrivilegeControl(false) {}}
                OutlinedTextField("",{},Modifier.fillMaxWidth(),label={Text("搜索域名")},singleLine=true)
                ResourceDetail("www.example.invalid","静态网站 · HTTPS · :443","启用") {
                    SectionTitle("站点配置","布局演示，不执行远端命令")
                    DetailRow("目录","/var/www/example")
                    DetailRow("协议","HTTPS")
                    ResourceActions(listOf(ResourceMenuAction("编辑网站") {},ResourceMenuAction("停用网站") {}))
                    HorizontalDivider();SectionTitle("HTTPS与证书")
                    DetailRow("证书","已配置 · 演示状态")
                    ResourceActions(listOf(ResourceMenuAction("配置 HTTPS") {},ResourceMenuAction("启用自动续期") {}))
                    HorizontalDivider();SectionTitle("配置备份")
                    Hint("备份与恢复在详情中查看，不堆叠在资源列表。")
                }
                ResourceIndexRow("api.example.invalid","反向代理 · HTTP · :80","停用") {}
                ResourceIndexRow("docs.example.invalid","静态网站 · HTTPS · :443","启用") {}
                Hint("点击资源查看详情；变更需预览与确认。")
            }
        }}
        ui.onNodeWithText("停用网站").assertDoesNotExist()
        screenshot("resource-list-dark-demo")
        ui.onNodeWithText("www.example.invalid").performClick()
        ui.onNodeWithText("编辑网站").assertIsDisplayed()
        screenshot("resource-detail-dark-demo",ui.onNode(isDialog()))
    }
    @Test fun backNavigationReturnsThroughCategoryAndOverview() {
        val app=androidx.test.core.app.ApplicationProvider.getApplicationContext<DeckApp>()
        val vm=DeckViewModel(app)
        val store=androidx.lifecycle.ViewModelStore();store.put("navigation",vm)
        try {
            ui.runOnUiThread {vm.choose(dev.vpsdeck.data.Server(name="UI navigation fixture",host="example.invalid"));vm.page=3}
            ui.setContent {DeckRoot(vm)}
            ui.onNodeWithText("数据库").performClick()
            ui.onNodeWithText("数据库与账号").assertIsDisplayed()
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
            ui.onNodeWithText("管理中心").assertIsDisplayed()
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
            ui.onNodeWithText("运行概览").assertIsDisplayed()
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
            ui.onNodeWithText("服务器资产").assertIsDisplayed()
        } finally {ui.runOnIdle {store.clear()}}
    }
    @Test fun unknownMeasurementsAreNotDisplayedAsZero() {
        ui.setContent {MaterialTheme(colorScheme=DeckLight,typography=DeckTypography) {
            MetricTrendCard("CPU",null,emptyList())
        }}
        ui.onNodeWithText("—").assertIsDisplayed()
        ui.onNodeWithText("等待有效采样").assertIsDisplayed()
        ui.onNodeWithText("0.0%").assertDoesNotExist()
    }
    @Test fun chartComponentsRenderWithExplicitDemonstrationData() {
        val data=listOf(22f,32f,26f,41f,35f,28f,37f,29f).mapIndexed {i,v -> i*15_000L to v}
        ui.setContent {MaterialTheme(colorScheme=DeckDark,typography=DeckTypography) {
            Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                SectionTitle("VPS Deck · 设计预览","自动化测试演示数据，非真实服务器")
                Row(horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                    MetricTrendCard("CPU",29f,data,Modifier.weight(1f))
                    MetricTrendCard("内存",48f,data.map {it.first to it.second?.plus(19f)},Modifier.weight(1f))
                }
                Panel {Row(horizontalArrangement=Arrangement.spacedBy(16.dp)) {DiskRing(42f);SectionTitle("根分区磁盘","资源图表与文字状态并存")}}
                Panel {SectionTitle("系统信息");DetailRow("系统","Debian GNU/Linux 12");DetailRow("状态","演示预览 · 不连接服务器")}
            }
        }}
        ui.onNodeWithContentDescription("CPU：8 个有效采样；缺测断线").assertIsDisplayed()
        screenshot("dashboard-dark-demo")
    }
}
