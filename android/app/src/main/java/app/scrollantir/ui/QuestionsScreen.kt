package app.scrollantir.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.scrollantir.net.Prompt
import app.scrollantir.net.PromptsRepository
import app.scrollantir.net.SubmitResult
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

private const val POLL_INTERVAL_MS = 30_000L

@Composable
fun QuestionsScreen(
    onBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val prompts by PromptsRepository.prompts.collectAsState()
    val lastError by PromptsRepository.lastError.collectAsState()
    val lastRefreshAt by PromptsRepository.lastRefreshAt.collectAsState()
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        while (true) {
            refreshing = true
            PromptsRepository.refresh(context)
            refreshing = false
            delay(POLL_INTERVAL_MS)
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Back"
                )
            }
            Spacer(Modifier.width(4.dp))
            Text(
                text = "Questions",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f)
            )
            if (refreshing) {
                CircularProgressIndicator(
                    modifier = Modifier.width(20.dp),
                    strokeWidth = 2.dp
                )
            }
        }

        StatusLine(
            count = prompts.size,
            lastRefreshAt = lastRefreshAt,
            error = lastError
        )

        if (prompts.isEmpty() && lastError == null) {
            EmptyState()
        } else {
            prompts.forEach { prompt ->
                PromptCard(
                    prompt = prompt,
                    onSubmit = { data, onResult ->
                        scope.launch {
                            val result = PromptsRepository.submit(context, prompt, data)
                            onResult(result)
                        }
                    }
                )
            }
        }
    }
}

@Composable
private fun StatusLine(count: Int, lastRefreshAt: java.time.Instant?, error: String?) {
    val text = when {
        error != null -> error
        lastRefreshAt == null -> "Fetching…"
        count == 0 -> "No unanswered questions · refreshed ${humanAgo(lastRefreshAt)}"
        count == 1 -> "1 question pending · refreshed ${humanAgo(lastRefreshAt)}"
        else -> "$count questions pending · refreshed ${humanAgo(lastRefreshAt)}"
    }
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = if (error != null) MaterialTheme.colorScheme.error
        else MaterialTheme.colorScheme.onSurfaceVariant
    )
}

@Composable
private fun EmptyState() {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainer
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text(
                text = "Nothing to answer right now.",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Medium
            )
            Text(
                text = "When the agent asks you something — a sleep-latency " +
                    "check-in, a mood note, a follow-up on a report — it " +
                    "shows up here. Polls every 30 s while this screen is open.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun PromptCard(
    prompt: Prompt,
    onSubmit: (JSONObject, (SubmitResult) -> Unit) -> Unit
) {
    var submission by remember { mutableStateOf<SubmissionState>(SubmissionState.Idle) }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerHigh
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = prompt.question.ifBlank { "(no question text)" },
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Medium
            )
            if (prompt.kind.isNotBlank()) {
                Text(
                    text = "kind: ${prompt.kind}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            prompt.context?.let { ctx ->
                Text(
                    text = ctx.toString(2),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            AnswerInput(
                prompt = prompt,
                enabled = submission !is SubmissionState.Submitting,
                onSubmit = { data ->
                    submission = SubmissionState.Submitting
                    onSubmit(data) { result ->
                        submission = when (result) {
                            is SubmitResult.Success -> SubmissionState.Done
                            is SubmitResult.AlreadyAnswered ->
                                SubmissionState.Error("Already answered — removed from inbox.")
                            is SubmitResult.Error ->
                                SubmissionState.Error("HTTP ${result.code}: ${result.message}")
                        }
                    }
                }
            )

            when (val s = submission) {
                is SubmissionState.Error -> Text(
                    text = s.message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error
                )
                SubmissionState.Submitting -> Text(
                    text = "Submitting…",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                else -> Unit
            }
        }
    }
}

private sealed class SubmissionState {
    object Idle : SubmissionState()
    object Submitting : SubmissionState()
    object Done : SubmissionState()
    data class Error(val message: String) : SubmissionState()
}

@Composable
private fun AnswerInput(
    prompt: Prompt,
    enabled: Boolean,
    onSubmit: (JSONObject) -> Unit
) {
    val type = prompt.answerSchema.optString("type")
    when (type) {
        "number" -> NumberAnswer(prompt = prompt, enabled = enabled, onSubmit = onSubmit)
        "choice" -> ChoiceAnswer(prompt = prompt, enabled = enabled, onSubmit = onSubmit)
        "string" -> StringAnswer(prompt = prompt, enabled = enabled, onSubmit = onSubmit)
        else -> StringAnswer(
            prompt = prompt,
            enabled = enabled,
            onSubmit = onSubmit,
            fallbackLabel = "Answer (schema \"$type\" — free text fallback)"
        )
    }
}

@Composable
private fun NumberAnswer(
    prompt: Prompt,
    enabled: Boolean,
    onSubmit: (JSONObject) -> Unit
) {
    val unit = prompt.answerSchema.optString("unit").takeIf { it.isNotBlank() }
    var text by remember { mutableStateOf("") }
    val valid = text.toDoubleOrNull() != null

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it.filter { ch -> ch.isDigit() || ch == '.' || ch == '-' } },
            label = { Text(unit?.let { "Value ($it)" } ?: "Value") },
            singleLine = true,
            enabled = enabled,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth()
        )
        Button(
            onClick = {
                val data = JSONObject().put("value", text.toDouble())
                if (unit != null) data.put("unit", unit)
                onSubmit(data)
            },
            enabled = enabled && valid,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Submit")
        }
    }
}

@Composable
private fun StringAnswer(
    prompt: Prompt,
    enabled: Boolean,
    onSubmit: (JSONObject) -> Unit,
    fallbackLabel: String? = null
) {
    var text by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            label = { Text(fallbackLabel ?: "Answer") },
            enabled = enabled,
            modifier = Modifier.fillMaxWidth()
        )
        Button(
            onClick = { onSubmit(JSONObject().put("value", text)) },
            enabled = enabled && text.isNotBlank(),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Submit")
        }
    }
}

@Composable
private fun ChoiceAnswer(
    prompt: Prompt,
    enabled: Boolean,
    onSubmit: (JSONObject) -> Unit
) {
    val options = remember(prompt.id) {
        val arr: JSONArray? = prompt.answerSchema.optJSONArray("options")
        buildList<String> {
            if (arr == null) return@buildList
            for (i in 0 until arr.length()) arr.optString(i).let { if (it.isNotBlank()) add(it) }
        }
    }
    var selected by remember { mutableStateOf<String?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (options.isEmpty()) {
            Text(
                text = "Malformed choice schema (missing options) — falling back to free text.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error
            )
            StringAnswer(prompt = prompt, enabled = enabled, onSubmit = onSubmit)
            return
        }
        options.forEach { opt ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .selectable(
                        selected = selected == opt,
                        enabled = enabled,
                        onClick = { selected = opt }
                    )
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                RadioButton(
                    selected = selected == opt,
                    enabled = enabled,
                    onClick = { selected = opt }
                )
                Spacer(Modifier.width(8.dp))
                Text(opt, style = MaterialTheme.typography.bodyLarge)
            }
        }
        Button(
            onClick = { onSubmit(JSONObject().put("value", selected)) },
            enabled = enabled && selected != null,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Submit")
        }
    }
}
