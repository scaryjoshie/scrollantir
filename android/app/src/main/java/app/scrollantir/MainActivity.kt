package app.scrollantir

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import app.scrollantir.net.DeviceId
import app.scrollantir.ui.LocationScreen
import app.scrollantir.ui.OnboardScanScreen
import app.scrollantir.ui.QuestionsScreen
import app.scrollantir.ui.SettingsScreen
import app.scrollantir.ui.TimelineScreen
import app.scrollantir.ui.TodayScreen
import app.scrollantir.ui.theme.ScrollantirTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DeviceId.prime(applicationContext)
        enableEdgeToEdge()
        setContent {
            ScrollantirTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    AppRoot(modifier = Modifier.padding(innerPadding))
                }
            }
        }
    }
}

private enum class Screen { TODAY, SETTINGS, TIMELINE, LOCATION, ONBOARD_SCAN, QUESTIONS }

@Composable
private fun AppRoot(modifier: Modifier = Modifier) {
    var current by rememberSaveable { mutableStateOf(Screen.TODAY) }

    AnimatedContent(
        targetState = current,
        transitionSpec = {
            fadeIn(tween(180)) togetherWith fadeOut(tween(180))
        },
        modifier = modifier,
        label = "screen"
    ) { screen ->
        when (screen) {
            Screen.TODAY -> TodayScreen(
                onOpenSettings = { current = Screen.SETTINGS },
                onOpenTimeline = { current = Screen.TIMELINE },
                onOpenLocation = { current = Screen.LOCATION },
                onOpenQuestions = { current = Screen.QUESTIONS }
            )
            Screen.SETTINGS -> SettingsScreen(
                onBack = { current = Screen.TODAY },
                onOpenOnboardScan = { current = Screen.ONBOARD_SCAN }
            )
            Screen.TIMELINE -> TimelineScreen(
                onBack = { current = Screen.TODAY }
            )
            Screen.LOCATION -> LocationScreen(
                onBack = { current = Screen.TODAY }
            )
            Screen.ONBOARD_SCAN -> OnboardScanScreen(
                onBack = { current = Screen.SETTINGS },
                onDone = { current = Screen.SETTINGS }
            )
            Screen.QUESTIONS -> QuestionsScreen(
                onBack = { current = Screen.TODAY }
            )
        }
    }
}
