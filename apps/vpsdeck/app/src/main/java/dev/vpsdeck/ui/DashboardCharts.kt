package dev.vpsdeck.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import java.util.Locale

/** Nulls and interrupted sampling split the line; no interpolation across missing data. */
data class ChartPoint(val x: Float, val y: Float, val startsSegment: Boolean)
fun chartPoints(samples: List<Pair<Long, Float?>>, ceiling: Float = 100f): List<ChartPoint> {
    if(samples.isEmpty() || !ceiling.isFinite() || ceiling<=0f) return emptyList()
    val start=samples.first().first
    val span=(samples.last().first-start).coerceAtLeast(1).toFloat()
    var previous: Long?=null
    return samples.mapNotNull { (time,value) ->
        if(value==null || !value.isFinite()) {previous=null;null}
        else {
            val begins=previous==null || time-previous!!>45_000 || time<=previous!!
            previous=time
            ChartPoint(((time-start)/span).coerceIn(0f,1f),1f-(value/ceiling).coerceIn(0f,1f),begins)
        }
    }
}
@Composable fun TrendChart(title: String, samples: List<Pair<Long,Float?>>, color: Color,
                          ceiling: Float = 100f, modifier: Modifier = Modifier) {
    val points=chartPoints(samples,ceiling)
    val grid=MaterialTheme.colorScheme.outlineVariant
    Canvas(modifier.fillMaxWidth().height(76.dp).semantics {
        contentDescription="$title：${points.size} 个有效采样；缺测断线"
    }) {
        val pad=4.dp.toPx();val w=(size.width-2*pad).coerceAtLeast(0f);val h=(size.height-2*pad).coerceAtLeast(0f)
        listOf(0f,0.5f,1f).forEach { y -> drawLine(grid,Offset(pad,pad+h*y),Offset(pad+w,pad+h*y),1.dp.toPx()) }
        var previous: Offset?=null
        points.forEach { p ->
            val position=Offset(pad+p.x*w,pad+p.y*h)
            if(!p.startsSegment && previous!=null) drawLine(color,previous!!,position,2.dp.toPx(),StrokeCap.Round)
            drawCircle(color,2.dp.toPx(),position)
            previous=position
        }
    }
}
@Composable fun MetricTrendCard(title: String, value: Float?, samples: List<Pair<Long,Float?>>, modifier: Modifier=Modifier) {
    val tint=if((value ?: 0f)>85f) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    Panel(modifier) {
        Hint(title)
        Text(value?.let {String.format(Locale.ROOT,"%.1f%%",it)} ?: "—",style=MaterialTheme.typography.titleLarge)
        TrendChart(title,samples,tint)
        Hint(if(value==null) "等待有效采样" else "占用率 · 0–100%")
    }
}
@Composable fun DiskRing(value: Float?, modifier: Modifier=Modifier) {
    val track=MaterialTheme.colorScheme.outlineVariant
    val color=if((value ?: 0f)>85f) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.secondary
    Box(modifier.size(76.dp),contentAlignment=Alignment.Center) {
        Canvas(Modifier.fillMaxSize().semantics {contentDescription=if(value==null) "磁盘占用未知" else "磁盘占用 $value%"}) {
            val stroke=Stroke(6.dp.toPx(),cap=StrokeCap.Round)
            val inset=6.dp.toPx()
            val bounds=androidx.compose.ui.geometry.Size(size.width-2*inset,size.height-2*inset)
            drawArc(track,-90f,360f,false,Offset(inset,inset),bounds,style=stroke)
            if(value!=null && value.isFinite()) drawArc(color,-90f,value.coerceIn(0f,100f)*3.6f,false,Offset(inset,inset),bounds,style=stroke)
        }
        Text(value?.let {String.format(Locale.ROOT,"%.0f%%",it)} ?: "—",style=MaterialTheme.typography.titleMedium)
    }
}
