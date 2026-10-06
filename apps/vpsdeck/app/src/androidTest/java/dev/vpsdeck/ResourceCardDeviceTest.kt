package dev.vpsdeck

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.vpsdeck.panel.Resource
import dev.vpsdeck.ui.ResourceCard
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ResourceCardDeviceTest {
    @get:Rule val ui = createComposeRule()
    @Test fun resourceCardSelectsExistingObjectWithoutTypingAnId() {
        var opened = false
        ui.setContent { MaterialTheme { ResourceCard(Resource("fixture.service", "Fixture worker", "active", enabled = "enabled"), true) { opened = true } } }
        ui.onNodeWithText("Fixture worker").assertIsDisplayed().performClick()
        ui.runOnIdle { assertTrue(opened) }
    }
    @Test fun busyResourceCardCannotBeSubmittedAgain() {
        var opened = false
        ui.setContent { MaterialTheme { ResourceCard(Resource("fixture.service", "Busy worker", "active"), false) { opened = true } } }
        ui.onNodeWithText("Busy worker").assertIsNotEnabled()
        ui.runOnIdle { assertFalse(opened) }
    }
}
