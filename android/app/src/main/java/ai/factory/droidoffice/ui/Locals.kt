package ai.factory.droidoffice.ui

import ai.factory.droidoffice.AppGraph
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.Dp

val LocalGraph = staticCompositionLocalOf<AppGraph> { error("no graph") }
val LocalSnackbar = staticCompositionLocalOf<SnackbarHostState> { error("no snackbar") }

/** How far above the bottom a screen with controls there wants snackbars; null is the default. */
val LocalSnackbarLift = staticCompositionLocalOf<MutableState<Dp?>> { error("no snackbar") }
