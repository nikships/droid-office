package ai.factory.droidoffice.core

/**
 * Stable names for every screen and control. The app maps them to `resource-id` in the
 * accessibility tree, so `adb shell uiautomator dump` and UI Automator's `By.res` find a control by
 * name instead of by its text or position. A dynamic part (a worker's, floor's, office's or model's
 * id) follows a `/`.
 *
 * Agents script against these names: renaming one breaks them, so add new names rather than
 * reuse old ones, and keep the table in android/README.md "Drive it with adb" in step.
 */
object Tags {
    object Screen {
        const val WELCOME = "screen.welcome"
        const val SCAN = "screen.scan"
        const val PAIR = "screen.pair"
        const val HOME = "screen.home"
        const val WORKER = "screen.worker"
        const val OFFICES = "screen.offices"
    }

    object App {
        const val BANNER = "app.banner"
        const val BANNER_DISMISS = "app.banner.dismiss"
        const val SNACKBAR = "app.snackbar"
    }

    object Welcome {
        const val SCAN = "welcome.scan"
        const val PASTE = "welcome.paste"
    }

    object Scan {
        const val BACK = "scan.back"
        const val PASTE = "scan.paste"
        const val STATUS = "scan.status"
        const val TORCH = "scan.torch"
        const val CAMERA = "scan.camera"
        const val PASTE_LINK = "scan.paste_link"
    }

    object Paste {
        const val SHEET = "paste.sheet"
        const val INPUT = "paste.input"
        const val CLIPBOARD = "paste.clipboard"
        const val SUBMIT = "paste.submit"
    }

    object Pair {
        const val STATUS = "pair.status"
        const val OUTCOME = "pair.outcome"
        const val OPEN = "pair.open"
        const val RETRY = "pair.retry"
        const val RESCAN = "pair.rescan"
        const val CANCEL = "pair.cancel"
    }

    object Home {
        const val OFFICES = "home.offices"
        const val ROUTE = "home.route"
        const val SETTINGS = "home.settings"
        const val CONNECTION = "home.connection"
        const val RETRY = "home.retry"
        const val PAIR_AGAIN = "home.pair_again"
        const val LOADING = "home.loading"
        const val LIST = "home.list"
        const val STAT_NEEDS_YOU = "home.stat.needs_you"
        const val STAT_WORKING = "home.stat.working"
        const val STAT_DONE = "home.stat.done"
        const val EMPTY = "home.empty"
        const val HIRE = "home.hire"
        const val HIRE_FIRST = "home.hire_first"
        const val REPAIR_SCAN = "home.repair.scan"
        const val REPAIR_FORGET = "home.repair.forget"
        const val PICK_WORKER = "home.pick_worker"

        // Inside each worker card; the card itself is [worker].
        const val CARD_NAME = "home.worker.name"
        const val CARD_STATUS = "home.worker.status"
        const val CARD_META = "home.worker.meta"
        const val CARD_TITLE = "home.worker.title"
        const val CARD_DETAIL = "home.worker.detail"

        fun floor(id: String) = "home.floor/$id"
        fun worker(id: String) = "home.worker/$id"
    }

    object Hire {
        const val SHEET = "hire.sheet"
        const val DROID = "hire.droid"
        const val SHELL = "hire.shell"
        const val PROMPT = "hire.prompt"
        const val MODEL = "hire.model"
        const val WORKTREE = "hire.worktree"
        const val SUBMIT = "hire.submit"
        const val QUEUE = "hire.queue"
        const val MODEL_SHEET = "hire.model_sheet"

        fun effort(wire: String) = "hire.effort/$wire"
        fun model(id: String) = "hire.model/$id"
    }

    object Worker {
        const val BACK = "worker.back"
        const val NAME = "worker.name"
        const val META = "worker.meta"
        const val STATUS = "worker.status"
        const val MENU = "worker.menu"
        const val MENU_COPY = "worker.menu.copy"
        const val MENU_SEND_HOME = "worker.menu.send_home"
        const val RESUME = "worker.resume"
        const val PR = "worker.pr"
        const val BRANCH = "worker.branch"
        const val SEND_HOME = "worker.send_home"
        const val OFFLINE = "worker.offline"
        const val NEEDS_YOU = "worker.needs_you"
        const val QUESTION = "worker.question"
        const val TERMINAL = "worker.terminal"
        const val LATEST = "worker.latest"
        const val ASLEEP = "worker.asleep"
        const val ASLEEP_RESUME = "worker.asleep.resume"
        const val CLOUD = "worker.cloud"
        const val GONE = "worker.gone"
        const val GONE_BACK = "worker.gone.back"
        const val KEYS = "worker.keys"
        const val ZOOM = "key.zoom"
        const val PHONE = "key.phone"
        const val INPUT = "composer.input"
        const val ATTACH = "composer.attach"
        const val SEND = "composer.send"
        const val QUEUE = "composer.queue"

        /** A numbered menu choice above the terminal, by the number the menu shows. */
        fun choice(number: Int) = "worker.choice/$number"

        /** A quick key, by what TalkBack calls it: "Shift Tab" is `key.shift_tab`. */
        fun key(spoken: String) = "key." + spoken.lowercase().replace(' ', '_')

        fun removeImage(number: Int) = "composer.remove_image/$number"
    }

    object SendHome {
        const val DIALOG = "send_home.dialog"
        const val CONFIRM = "send_home.confirm"
        const val CANCEL = "send_home.cancel"

        /** `all`, `worktree` or `keep`: the cleanup the office's `kill` message takes. */
        fun option(cleanup: String) = "send_home.option/$cleanup"
    }

    object Offices {
        const val BACK = "offices.back"
        const val PAIR_NEW = "offices.pair_new"
        const val ALLOW_NOTIFICATIONS = "offices.allow_notifications"
        const val STAY_CONNECTED = "settings.stay_connected"
        const val NOTIFY_NEEDS_INPUT = "settings.notify_needs_input"
        const val NOTIFY_DONE = "settings.notify_done"
        const val HAPTICS = "settings.haptics"
        const val FORGET_DIALOG = "forget.dialog"
        const val FORGET_CONFIRM = "forget.confirm"
        const val FORGET_CANCEL = "forget.cancel"

        fun office(id: String) = "offices.office/$id"
        fun forget(id: String) = "offices.forget/$id"
    }
}
