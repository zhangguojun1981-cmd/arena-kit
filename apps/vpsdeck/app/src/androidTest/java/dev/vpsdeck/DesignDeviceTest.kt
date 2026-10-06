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
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.vpsdeck.ui.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class DesignDeviceTest {
    @get:Rule val ui=createComposeRule()
    private fun screenshot(name: String) {
        val app=ApplicationProvider.getApplicationContext<android.content.Context>()
        val file=File(app.getExternalFilesDir(null),"ui-preview/$name.png")
        file.parentFile!!.mkdirs()
        file.outputStream().use {ui.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG,100,it)}
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
