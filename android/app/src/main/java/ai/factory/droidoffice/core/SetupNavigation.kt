package ai.factory.droidoffice.core

object SetupNavigation {
    /** Retry scanning without leaving setup, including a pairing link opened as the root screen. */
    fun <Key> rescan(stack: MutableList<Key>, scanner: Key) {
        require(stack.isNotEmpty())
        if (stack.size > 1 && stack[stack.lastIndex - 1] == scanner) {
            stack.removeAt(stack.lastIndex)
        } else {
            stack[stack.lastIndex] = scanner
        }
    }
}
