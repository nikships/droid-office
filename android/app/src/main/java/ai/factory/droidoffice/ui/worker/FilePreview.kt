package ai.factory.droidoffice.ui.worker

import androidx.compose.runtime.staticCompositionLocalOf

// Stand-in for the Thread's file preview sheet, which ships separately: the cards only need to call it.

/** Opens a worker's workspace file read-only, at [line] when given. */
interface FilePreview {
    fun openFilePreview(path: String, line: Int? = null, endLine: Int? = null)
}

/** Null where the worker's files can't be opened (a cloud worker). */
val LocalFilePreview = staticCompositionLocalOf<FilePreview?> { null }
