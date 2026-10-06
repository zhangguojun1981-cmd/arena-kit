package dev.vpsdeck.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.vpsdeck.panel.JobProtocol
import org.json.JSONObject

/** Query-only display. Unknown/review messages stay visible, never hidden as a successful task. */
@Composable fun RemoteJobCard(raw: String) {
    val job=JSONObject(raw)
    val state=job.optString("state")
    val attention=state !in setOf("succeeded","running","queued")
    var expanded by remember(job.getString("id")) {mutableStateOf(false)}
    Panel {
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp),verticalAlignment=Alignment.CenterVertically) {
            Text(job.optString("project"),Modifier.weight(1f),style=MaterialTheme.typography.titleSmall,maxLines=2,overflow=TextOverflow.Ellipsis)
            StatusBadge(JobProtocol.state(state),positive=state=="succeeded",danger=attention)
        }
        Hint(JobProtocol.action(job.optString("action")))
        Text(job.optString("message"),style=MaterialTheme.typography.bodySmall,
            maxLines=if(attention || expanded) Int.MAX_VALUE else 2,overflow=TextOverflow.Ellipsis,
            color=if(attention) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick={expanded=!expanded},contentPadding=PaddingValues(0.dp)) {ActionLabel(if(expanded) "收起任务详情" else "查看任务详情")}
        CopyButton(listOf(job.optString("project"),"ID：${job.getString("id")}",JobProtocol.action(job.optString("action")),JobProtocol.state(state),job.optString("message"),job.optJSONArray("resources")?.toString(2).orEmpty()).joinToString("\n"),"复制任务结果")
        if(expanded) {
            Hint("复制服务端返回的任务摘要，不代表未返回的完整进程输出。")
            Hint("ID：${job.getString("id")}")
            JobProtocol.rows(job,"resources").forEach {value ->
                val item=JSONObject(value)
                DetailRow(item.optString("service"),"${item.optString("state")} ${item.optString("health")}")
            }
        }
    }
}
