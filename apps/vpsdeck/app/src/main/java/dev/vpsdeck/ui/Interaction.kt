@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.vpsdeck.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Action text never wraps. Long resource identities belong outside the button. */
@Composable fun ActionLabel(text: String, color: Color = Color.Unspecified) {
    Text(text,color=color,maxLines=1,softWrap=false,overflow=TextOverflow.Ellipsis)
}
@Composable fun ActionGroup(content: @Composable () -> Unit) {
    FlowRow(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp),
        verticalArrangement=Arrangement.spacedBy(4.dp)) {content()}
}
@Composable fun ManagementHeading(title: String, subtitle: String) {
    Column(Modifier.fillMaxWidth().padding(vertical=12.dp),verticalArrangement=Arrangement.spacedBy(4.dp)) {
        Text(title,style=MaterialTheme.typography.titleMedium)
        Hint(subtitle)
    }
}
@Composable fun ResourceHeading(name: String, status: String, summary: String = "") {
    Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
        Text(name,style=MaterialTheme.typography.titleMedium)
        StatusBadge(status)
        if(summary.isNotBlank()) Text(summary,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
fun clipboardChunks(text: String): List<String> {
    val chunks=mutableListOf<String>();var start=0
    while(start<text.length) {
        var end=minOf(start+64000,text.length)
        if(end<text.length && text[end-1].isHighSurrogate() && text[end].isLowSurrogate()) end--
        chunks+=text.substring(start,end);start=end
    }
    return chunks
}
@Composable fun CopyButton(text: String, label: String = "复制输出", readText: (() -> String)? = null) {
    val context=LocalContext.current
    var copied by remember(text) {mutableStateOf(false)}
    var captured by remember(text) {mutableStateOf(text)}
    LaunchedEffect(copied) {if(copied) {kotlinx.coroutines.delay(1800);copied=false}}
    var choose by remember(text) {mutableStateOf(false)}
    var error by remember(text) {mutableStateOf<String?>(null)}
    fun copy(value: String) {
        runCatching {
            val clip=ClipData.newPlainText("VPS Deck · $label",value)
            if(android.os.Build.VERSION.SDK_INT>=33) clip.description.extras=android.os.PersistableBundle().apply {putBoolean("android.content.extra.IS_SENSITIVE",true)}
            (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(clip)
        }.onSuccess {copied=true;error=null}.onFailure {error="复制失败，请重试"}
    }
    TextButton(enabled=text.isNotEmpty() || readText!=null,onClick={captured=readText?.invoke() ?: text;if(captured.isEmpty()) error="暂无可复制内容" else if(captured.length>64000) choose=true else copy(captured)}) {ActionLabel(if(copied && captured.length<=64000) "已复制" else label)}
    if(choose) AlertDialog(onDismissRequest={choose=false},title={Text("分段复制")},text={
        Column(Modifier.heightIn(max=320.dp).verticalScroll(rememberScrollState())) {
            Hint("内容较长，为避免系统剪贴板限制请按顺序复制；不会丢弃尾部内容。")
            val chunks=remember(captured) {clipboardChunks(captured)}
            var last by remember {mutableIntStateOf(-1)}
            chunks.forEachIndexed {i,chunk -> TextButton(onClick={copy(chunk);if(error==null) last=i}) {ActionLabel(if(last==i) "第 ${i+1} 段已复制" else "复制第 ${i+1} / ${chunks.size} 段")} }
            error?.let { CopyableOutput(it,"错误详情",error=true) }
        }
    },confirmButton={TextButton(onClick={choose=false}) {ActionLabel("关闭")}})
    else error?.let { CopyableOutput(it,"错误详情",error=true) }
}
/** Copy includes all retained output, not just the visible or collapsed preview. */
@Composable fun CopyableOutput(text: String, title: String = "命令输出", error: Boolean = false, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(4.dp)) {
        ActionGroup {
            Text(title,Modifier.padding(vertical=12.dp),style=MaterialTheme.typography.labelMedium)
            CopyButton(text)
        }
        SelectionContainer {
            Text(text.ifEmpty {"（没有输出）"},Modifier.fillMaxWidth().heightIn(max=240.dp).verticalScroll(rememberScrollState()),
                style=MaterialTheme.typography.bodySmall,fontFamily=FontFamily.Monospace,
                color=if(error) MaterialTheme.colorScheme.error else Color.Unspecified)
        }
    }
}

/** Only presentation fields: never copy original requests, authentication or environment values. */
fun previewReport(info: org.json.JSONObject): String = buildString {
    listOf("warning","previousImageID","newImageID","binding","volumePath").forEach {key ->
        if(info.has(key) && !info.isNull(key)) appendLine("$key: ${info.optString(key)}")
    }
    val services=info.optJSONArray("services")
    if(services!=null) for(i in 0 until services.length()) {
        val service=services.optJSONObject(i) ?: continue
        appendLine(listOf("name","image","privileged","mounts","ports").filter {service.has(it)}.joinToString(" · ") {"$it: ${service.optString(it)}"})
    }
}
