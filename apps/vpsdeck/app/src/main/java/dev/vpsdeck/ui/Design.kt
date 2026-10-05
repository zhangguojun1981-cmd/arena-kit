package dev.vpsdeck.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

val DeckBlue = Color(0xFF89AEFF)
val DeckGreen = Color(0xFF6DD6B2)
val DeckDark = darkColorScheme(primary = DeckBlue, onPrimary = Color(0xFF092454), secondary = DeckGreen,
    background = Color(0xFF0C111B), surface = Color(0xFF131C29), surfaceVariant = Color(0xFF1D293B),
    onSurface = Color(0xFFE9EEF8), onSurfaceVariant = Color(0xFFA5B2C9), outline = Color(0xFF3D4B63))
val DeckLight = lightColorScheme(primary = Color(0xFF285BC0), secondary = Color(0xFF157657),
    background = Color(0xFFF3F6FC), surface = Color.White, surfaceVariant = Color(0xFFE8EEF8))

@Composable fun Panel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier = modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface, tonalElevation = 1.dp) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}
@Composable fun SectionTitle(title: String, subtitle: String? = null) {
    Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
    if(subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
@Composable fun Hint(text: String) { Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
fun bytes(value: Long?): String {
    if(value == null) return "—"
    val labels = arrayOf("B", "KB", "MB", "GB", "TB"); var size = value.toDouble(); var i = 0
    while(size >= 1024 && i < labels.lastIndex) { size /= 1024; i++ }
    return if(i == 0) "$value B" else String.format(Locale.ROOT, "%.1f %s", size, labels[i])
}
fun time(value: Long) = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault()).format(Date(value))
