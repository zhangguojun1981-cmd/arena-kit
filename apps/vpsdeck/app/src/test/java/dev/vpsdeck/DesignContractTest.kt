package dev.vpsdeck

import dev.vpsdeck.ui.*
import org.junit.Assert.*
import org.junit.Test

class DesignContractTest {
    @Test fun everyTypographyRoleFitsRequestedRange() {
        val t=DeckTypography
        val styles=listOf(t.displayLarge,t.displayMedium,t.displaySmall,t.headlineLarge,t.headlineMedium,t.headlineSmall,
            t.titleLarge,t.titleMedium,t.titleSmall,t.bodyLarge,t.bodyMedium,t.bodySmall,t.labelLarge,t.labelMedium,t.labelSmall)
        assertTrue(styles.all {it.fontSize.value in 11f..14f})
        assertTrue(styles.all {it.lineHeight.value>it.fontSize.value})
    }
    @Test fun missingDataIsNotZeroAndGapsAreNotConnected() {
        val points=chartPoints(listOf(0L to 0f,15_000L to null,30_000L to 50f,45_000L to 60f,100_000L to 70f))
        assertEquals(4,points.size)
        assertEquals(listOf(true,true,false,true),points.map {it.startsSegment})
        assertEquals(1f,points.first().y,0.001f)
        assertTrue(chartPoints(listOf(0L to null)).isEmpty())
        assertTrue(chartPoints(listOf(0L to Float.NaN)).isEmpty())
    }
    @Test fun chartUsesActualElapsedTimeAndBounds() {
        val points=chartPoints(listOf(0L to -5f,15_000L to 50f,60_000L to 120f))
        assertEquals(0.25f,points[1].x,0.001f)
        assertEquals(0f,points.last().y,0.001f)
    }
}
