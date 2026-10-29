package ai.factory.droidoffice.core

/** Bars/cutouts and the keyboard overlap; adding their bottom heights would double-inset the pane. */
data class WorkspaceInsets(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    fun withKeyboard(bottom: Int) = copy(bottom = maxOf(this.bottom, bottom))
}
