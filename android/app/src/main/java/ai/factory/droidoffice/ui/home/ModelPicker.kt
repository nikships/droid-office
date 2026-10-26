package ai.factory.droidoffice.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.Availability
import ai.factory.droidoffice.core.ModelAvailability
import ai.factory.droidoffice.core.ModelBrand
import ai.factory.droidoffice.core.ModelSearch
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.net.ModelCatalogue
import ai.factory.droidoffice.net.ModelOption
import ai.factory.droidoffice.net.nameOf
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.BrandLogo
import ai.factory.droidoffice.ui.components.Chip
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.ModelLogo
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.launch

private fun ModelOption.pick() = ModelSearch.Model(id, displayName.ifBlank { ai.factory.droidoffice.core.Models.displayName(id) }, custom, legacy, provider, if (custom) null else tokenMultiplier, listOfNotNull(promo, "no images".takeIf { noImages }))

@Composable
private fun Cost(cost: Double?) {
    if (cost == null) return
    val color = if (cost <= .3) Palette.Success else if (cost >= 4) Palette.Warning else Palette.TextSecondary
    Text(ModelSearch.multiplier(cost), style = MaterialTheme.typography.labelSmall, color = color, modifier = Modifier.background(color.copy(alpha = .08f), RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 4.dp))
}

/** A searchable model sheet shared by the phone's hire flow. No model or gateway substitutes its own logo for the family. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ModelPicker(catalogue: ModelCatalogue?, loading: Boolean, selected: String?, availability: Map<String, ModelAvailability>, onPick: (ModelOption) -> Unit) {
    val graph = LocalGraph.current
    val stored by graph.store.snapshot.collectAsStateWithLifecycle()
    val coroutine = rememberCoroutineScope()
    var open by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    var scope by rememberSaveable { mutableStateOf("") }
    val current = catalogue?.models?.find { it.id == selected }
    Row(
        Modifier.fillMaxWidth().panel(RoundedCornerShape(10.dp), Palette.SurfaceRaised, Palette.BorderStrong)
            .selectable(open, enabled = catalogue != null, role = Role.Button) { query = ""; scope = ""; open = true }.tagged(Tags.Hire.MODEL).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (loading) Spinner(Modifier.size(20.dp))
        else ModelLogo(selected, current?.displayName, current?.provider, Modifier.size(22.dp))
        Column(Modifier.weight(1f)) {
            Text(current?.pick()?.title ?: selected?.let { catalogue.nameOf(it) } ?: "The office's default", style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val why = Availability.reason(availability[selected], System.currentTimeMillis())
            if (why != null) Text(why, style = MaterialTheme.typography.bodySmall, color = Palette.Warning, maxLines = 1, overflow = TextOverflow.Ellipsis)
            else if (current != null) Text(current.pick().group, style = MaterialTheme.typography.bodySmall)
        }
        Cost(current?.pick()?.cost)
        Icon(Icons.Default.KeyboardArrowDown, null, tint = Palette.TextSecondary)
    }
    if (!open || catalogue == null) return
    val models = remember(catalogue) { catalogue.models.map { it.pick() } }
    val recent = stored.settings.recentModels.filter { !Availability.cannotRun(availability[it]) }
    val sections = remember(models, query, scope, recent) { ModelSearch.sections(models, query, scope, recent) }
    val listState = rememberLazyListState()
    val now = rememberNow(30_000)
    LaunchedEffect(query, scope) { listState.scrollToItem(0) }
    fun choose(option: ModelOption) {
        if (Availability.cannotRun(availability[option.id])) return
        open = false
        coroutine.launch { graph.store.settings { it.copy(recentModels = ModelSearch.recent(it.recentModels, option.id)) } }
        onPick(option)
    }
    ModalBottomSheet(onDismissRequest = { open = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Palette.Surface) {
        Column(Modifier.fillMaxWidth().heightIn(max = 640.dp).navigationBarsPadding().imePadding().tagged(Tags.Hire.MODEL_SHEET)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Model", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
                Text("${models.size} models", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { open = false }, modifier = Modifier.tagged(Tags.Hire.MODEL_CLOSE)) { Text("Done") }
            }
            OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp).tagged(Tags.Hire.MODEL_SEARCH),
                placeholder = { Text("Search models, providers…") }, singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Palette.Accent, unfocusedBorderColor = Palette.BorderStrong, cursorColor = Palette.Accent))
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Chip("All · ${models.size}", scope.isEmpty(), { scope = "" }, Modifier.tagged(Tags.Hire.modelScope("All")))
                ModelSearch.scopes(models).forEach { group ->
                    Chip("${group.name} · ${group.count}", scope == group.name, { scope = group.name }, Modifier.tagged(Tags.Hire.modelScope(group.name)), icon = ModelBrand.provider(group.name)?.let { ai.factory.droidoffice.ui.theme.OfficeIcons.model(androidx.compose.ui.platform.LocalContext.current, it) })
                }
            }
            LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false), state = listState, contentPadding = PaddingValues(bottom = 16.dp)) {
                sections.forEach { section ->
                    item(key = section.key) {
                        Row(Modifier.padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            ModelBrand.provider(section.label)?.let { BrandLogo(it, Modifier.size(16.dp)) }
                            Eyebrow("${section.label}${if (section.flat) "" else " · ${section.models.size}"}")
                        }
                    }
                    items(section.models, key = { "${section.key}:${it.id}" }) { model ->
                        val on = model.id == selected
                        val refusal = Availability.reason(availability[model.id], now)
                        val note = Availability.note(availability[model.id], now)
                        Row(
                            Modifier.fillMaxWidth().selectable(on, enabled = refusal == null) {
                                catalogue.models.find { it.id == model.id }?.let(::choose)
                            }.tagged(Tags.Hire.model(model.id)).background(if (on) Palette.AccentMuted else Color.Transparent).padding(horizontal = 20.dp, vertical = 11.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            ModelLogo(model.id, model.title, model.provider, Modifier.size(24.dp))
                            Column(Modifier.weight(1f)) {
                                val highlighted = buildAnnotatedString {
                                    append(model.title)
                                    ModelSearch.highlights(model.title, query).forEach { (from, to) -> addStyle(SpanStyle(color = Palette.Accent), from, to) }
                                }
                                Text(highlighted, style = MaterialTheme.typography.bodyLarge, color = if (refusal != null) Palette.TextTertiary else Palette.Text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                val line = refusal ?: note ?: (model.tags + if (section.flat) listOf(model.group) else emptyList()).joinToString(" · ").ifBlank { model.id }
                                Text(line, style = MaterialTheme.typography.bodySmall, color = if (refusal != null) Palette.Warning else Palette.TextSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.tagged(Tags.Hire.modelWhy(model.id)))
                            }
                            Cost(model.cost)
                            if (on) Icon(Icons.Default.Check, "Selected", Modifier.size(18.dp), tint = Palette.Accent)
                        }
                    }
                }
                val typed = query.trim()
                if (ModelSearch.customId(typed) && models.none { it.id == typed }) {
                    item(key = "custom") {
                        TextButton(onClick = { choose(ModelOption(typed, typed, custom = true)) }, modifier = Modifier.fillMaxWidth().tagged(Tags.Hire.MODEL_CUSTOM)) {
                            ModelLogo(typed, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(12.dp))
                            Text("Use $typed as typed", maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                } else if (sections.isEmpty()) {
                    item { Text("No model matches. Clear the search or choose another group.", modifier = Modifier.padding(20.dp), style = MaterialTheme.typography.bodyMedium) }
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}
