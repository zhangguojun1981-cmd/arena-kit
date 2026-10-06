package dev.vpsdeck.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// All application typography is 11–14sp; system accessibility scaling stays enabled.
private fun deckType(size: Int, weight: FontWeight = FontWeight.Normal) =
    androidx.compose.ui.text.TextStyle(fontSize = size.sp, lineHeight = (size + 6).sp, fontWeight = weight)
val DeckTypography = Typography(
    displayLarge=deckType(14,FontWeight.Bold), displayMedium=deckType(14,FontWeight.Bold), displaySmall=deckType(14,FontWeight.Bold),
    headlineLarge=deckType(14,FontWeight.Bold), headlineMedium=deckType(14,FontWeight.Bold), headlineSmall=deckType(14,FontWeight.Bold),
    titleLarge=deckType(14,FontWeight.SemiBold), titleMedium=deckType(14,FontWeight.SemiBold), titleSmall=deckType(13,FontWeight.SemiBold),
    bodyLarge=deckType(13), bodyMedium=deckType(12), bodySmall=deckType(11),
    labelLarge=deckType(12,FontWeight.Medium), labelMedium=deckType(11,FontWeight.Medium), labelSmall=deckType(11)
)
val DeckBlue = Color(0xFF9AB8EC)
val DeckGreen = Color(0xFF83C5AF)
val DeckDark = darkColorScheme(
    primary=DeckBlue, onPrimary=Color(0xFF15233A), primaryContainer=Color(0xFF23344D), onPrimaryContainer=Color(0xFFDCE7FA),
    secondary=DeckGreen, onSecondary=Color(0xFF122F27), secondaryContainer=Color(0xFF213C33), onSecondaryContainer=Color(0xFFB5DEC9),
    background=Color(0xFF101318), surface=Color(0xFF191E25), surfaceVariant=Color(0xFF242B35),
    onBackground=Color(0xFFE5E9F0), onSurface=Color(0xFFE5E9F0), onSurfaceVariant=Color(0xFFAAB4C3),
    outline=Color(0xFF657083), outlineVariant=Color(0xFF303844), error=Color(0xFFEEA29E)
)
val DeckLight = lightColorScheme(
    primary=Color(0xFF365E91), onPrimary=Color.White, primaryContainer=Color(0xFFE2EAF5), onPrimaryContainer=Color(0xFF203D63),
    secondary=Color(0xFF286851), onSecondary=Color.White, secondaryContainer=Color(0xFFE2EEE8), onSecondaryContainer=Color(0xFF214D3C),
    background=Color(0xFFF1F3F6), surface=Color(0xFFFFFFFF), surfaceVariant=Color(0xFFE8ECF1),
    onBackground=Color(0xFF1D2939), onSurface=Color(0xFF1D2939), onSurfaceVariant=Color(0xFF566477),
    outline=Color(0xFF7A8798), outlineVariant=Color(0xFFD9DFE7), error=Color(0xFFAD3838)
)
@Composable fun Panel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier=modifier.fillMaxWidth(), shape=RoundedCornerShape(14.dp),
        color=MaterialTheme.colorScheme.surface, border=androidx.compose.foundation.BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant)) {
        Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(10.dp),content=content)
    }
}
@Composable fun SectionTitle(title: String, subtitle: String? = null) {
    Column(verticalArrangement=Arrangement.spacedBy(4.dp)) {
        Text(title,style=MaterialTheme.typography.titleMedium)
        if(subtitle!=null) Hint(subtitle)
    }
}
@Composable fun Hint(text: String) { Text(text,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant) }
@Composable fun StatusBadge(label: String, positive: Boolean = false, danger: Boolean = false) {
    val color=if(danger) MaterialTheme.colorScheme.error else if(positive) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.onSurfaceVariant
    Surface(color=color.copy(alpha=0.10f),shape=RoundedCornerShape(6.dp)) {
        Text(label,Modifier.padding(horizontal=8.dp,vertical=4.dp),color=color,style=MaterialTheme.typography.labelSmall)
    }
}
@Composable fun DetailRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(12.dp)) {
        Text(label,Modifier.weight(0.34f),color=MaterialTheme.colorScheme.onSurfaceVariant,style=MaterialTheme.typography.bodySmall)
        Text(value,Modifier.weight(0.66f),style=MaterialTheme.typography.bodyMedium)
    }
}
fun bytes(value: Long?): String {
    if(value == null) return "—"
    val labels = arrayOf("B", "KB", "MB", "GB", "TB"); var size = value.toDouble(); var i = 0
    while(size >= 1024 && i < labels.lastIndex) { size /= 1024; i++ }
    return if(i == 0) "$value B" else String.format(Locale.ROOT, "%.1f %s", size, labels[i])
}
fun time(value: Long) = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault()).format(Date(value))

@Composable fun HelpDisclosure(text: String, title: String = "说明与边界") {
    var open by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    Column {
        TextButton(onClick={open=!open}) { Text(if(open) "$title · 收起" else "$title · 展开") }
        if(open) Hint(text)
    }
}
@Composable fun PrivilegeControl(value: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    var open by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    Column {
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=androidx.compose.ui.Alignment.CenterVertically) {
            StatusBadge(if(value) "sudo -n 已启用" else "当前 SSH 身份",positive=false)
            TextButton(onClick={open=!open},enabled=enabled) {Text("执行权限")}
        }
        if(open) Row(verticalAlignment=androidx.compose.ui.Alignment.CenterVertically) {
            Switch(value,onChange,enabled=enabled)
            Column(Modifier.weight(1f)) {Text("明确使用 sudo -n");Hint("只使用已有免密授权，不提交密码")}
        }
    }
}
