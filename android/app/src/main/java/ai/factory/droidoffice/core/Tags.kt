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
        const val WORKERS = "screen.workers"
        const val WORKER = "screen.worker"
        const val OFFICES = "screen.offices"
        const val ASKS = "screen.asks"
        const val ME = "screen.me"
        const val BOARD = "screen.board"
        const val BOARD_CARD = "screen.board_card"
    }

    object App {
        const val BANNER = "app.banner"
        const val BANNER_DISMISS = "app.banner.dismiss"
        const val SNACKBAR = "app.snackbar"
    }

    /** The bottom tabs. */
    object Tab {
        const val BAR = "tab.bar"
        const val WORKERS = "tab.workers"
        const val ASKS = "tab.asks"
        const val OFFICE = "tab.office"
        const val BOARD = "tab.board"
        const val ME = "tab.me"
    }

    /** The Whiteboard: the floor's grid of cards, and one card with its comment threads. */
    object Board {
        const val GRID = "board.grid"
        const val EMPTY = "board.empty"
        const val LOADING = "board.loading"
        const val RENDERER = "board.renderer"
        const val PING = "board.ping"
        const val CARD_TITLE = "board.card.title"
        const val CARD_META = "board.card.meta"
        const val CARD_CHANGED = "board.card.changed"
        const val BACK = "board.back"
        const val TITLE = "board.title"
        const val META = "board.meta"
        const val IMAGE = "board.image"
        const val IMAGE_STATUS = "board.image.status"
        const val SHOW = "board.show"
        const val COMMENTS = "board.comments"
        const val COMMENTS_SHEET = "board.comments_sheet"
        const val NEW_COMMENT = "board.new_comment"
        const val COMMENT_INPUT = "board.comment.input"
        const val COMMENT_SEND = "board.comment.send"
        const val COMMENT_CANCEL = "board.comment.cancel"
        const val PING_SHEET = "board.ping_sheet"
        const val GONE = "board.gone"
        /** The card live, as the office's window shows it (a WebView: its content isn't in a dump). */
        const val LIVE = "board.live"
        const val MODE_USE = "board.mode.use"
        const val MODE_MARKUP = "board.mode.markup"
        const val ADD_PICTURE = "board.add_picture"
        const val HINT = "board.hint"
        const val STICKY_SHEET = "board.sticky_sheet"
        const val STICKY_INPUT = "board.sticky.input"
        const val STICKY_SAVE = "board.sticky.save"
        const val STICKY_MOVE = "board.sticky.move"
        const val STICKY_DELETE = "board.sticky.delete"
        /** Full screen for the live card, and the button that leaves it. */
        const val FULLSCREEN = "board.fullscreen"
        /** What the live card itself put in full screen (its video's full-screen button); Back leaves it. */
        const val VIDEO_FULLSCREEN = "board.video_fullscreen"
        const val SEARCH = "board.search"
        const val NO_MATCH = "board.no_match"
        const val CARD_FORMAT = "board.card.format"
        const val PREV = "board.prev"
        const val NEXT = "board.next"

        fun card(id: String) = "board.card/$id"
        fun filter(id: String) = "board.filter/$id"
        fun thread(id: String) = "board.thread/$id"
        fun reply(id: String) = "board.thread.reply/$id"
        fun replySend(id: String) = "board.thread.reply_send/$id"
        fun resolve(id: String) = "board.thread.resolve/$id"
        fun editMessage(id: String) = "board.message.edit/$id"
        fun editInput(id: String) = "board.message.input/$id"
        fun editSave(id: String) = "board.message.save/$id"
        fun editCancel(id: String) = "board.message.cancel/$id"
        fun seek(label: String) = "board.seek/$label"
        fun sticky(id: String) = "board.sticky/$id"
        fun stickyColor(name: String) = "board.sticky.color/$name"
        fun showThread(id: String) = "board.thread.show/$id"
        fun moveThread(id: String) = "board.thread.move/$id"
        fun pingWorker(id: String) = "board.ping/$id"
        /** On the ping sheet row of the worker that made the open card. */
        fun pingAuthor(id: String) = "board.ping.author/$id"
    }

    object Answer {
        const val OPEN = "answer.open"
        const val WORKSPACE = "answer.workspace"
        const val CONTENT = "answer.content"
        const val CLOSE = "answer.close"
        const val RAW_TTY = "answer.raw_tty"
        const val QUESTION = "answer.question"
        const val REVIEW = "answer.review"
        const val INSTRUCTION = "answer.instruction"
        const val TYPE = "answer.type"
        const val TEXT = "answer.text"
        const val STATUS = "answer.status"
        const val SUBMIT = "answer.submit"
        const val CANCEL = "answer.cancel"
        fun option(number: Int) = "answer.option/$number"
    }

    object Asks {
        const val COUNT = "asks.count"
        const val CARD = "asks.card"
        const val WORKER = "asks.card.worker"
        const val CONTEXT = "asks.card.context"
        const val QUESTION = "asks.card.question"
        const val OWN_ANSWER = "asks.card.own_answer"
        const val OWN_ANSWER_SEND = "asks.card.own_answer.send"
        const val OPEN_THREAD = "asks.card.open_thread"
        const val WAITING = "asks.card.waiting"
        const val SENDING = "asks.sending"
        const val SENDING_CANCEL = "asks.sending.cancel"
        const val ANSWERED = "asks.answered"
        const val EMPTY = "asks.empty"
        const val EMPTY_HIRE = "asks.empty.hire"
        fun option(number: Int) = "asks.card.option/$number"
        fun next(id: String) = "asks.next/$id"
    }

    /** The cross-floor Workers tab: Needs you cards and the building roster. */
    object Workers {
        const val LIST = "workers.list"
        const val LOADING = "workers.loading"
        const val EMPTY = "workers.empty"
        const val EMPTY_HIRE = "workers.empty.hire"
        const val HIRE = "workers.hire"
        const val PICK_WORKER = "workers.pick_worker"
        const val WAITING_COUNT = "workers.waiting_count"
        const val SUMMARY = "workers.summary"
        const val NEEDS_YOU = "workers.needs_you"
        const val ANSWERED = "workers.answered"
        const val CARD_NAME = "workers.card.name"
        const val CARD_STATUS = "workers.card.status"
        const val CARD_FLOOR = "workers.card.floor"
        const val CARD_REPO = "workers.card.repo"
        const val CARD_META = "workers.card.meta"
        const val CARD_TITLE = "workers.card.title"
        const val CARD_DETAIL = "workers.card.detail"
        const val CARD_TODOS = "workers.card.todos"

        fun card(id: String) = "workers.card/$id"
        fun ask(id: String) = "workers.ask/$id"
    }

    object Update {
        const val NOTICE_STATUS = "update.notice.status"
        const val NOTICE_OPEN = "update.notice.open"
        const val NOTICE_DISMISS = "update.notice.dismiss"
        const val ROW = "update.row"
        const val STATUS = "update.status"
        const val OPEN = "update.open"
        const val DIALOG = "update.dialog"
        const val DIALOG_STATUS = "update.dialog.status"
        const val PROGRESS = "update.progress"
        const val ERROR = "update.error"
        const val INSTALL = "update.install"
        const val CANCEL = "update.cancel"
        const val CHECK = "update.check"
        const val DISMISS = "update.dismiss"
        const val BROWSER = "update.browser"
        const val DOWNLOAD = "update.download"
    }

    object Welcome {
        const val SCAN = "welcome.scan"
        const val PASTE = "welcome.paste"
        const val DEEP_LINK = "welcome.deep_link"
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
        const val CONNECTION = "home.connection"
        const val RETRY = "home.retry"
        const val PAIR_AGAIN = "home.pair_again"
        const val LOADING = "home.loading"
        const val LIST = "home.list"
        const val EMPTY = "home.empty"
        const val HIRE = "home.hire"
        const val HIRE_FIRST = "home.hire_first"
        const val REPAIR_SCAN = "home.repair.scan"
        const val REPAIR_FORGET = "home.repair.forget"
        const val PICK_WORKER = "home.pick_worker"
        const val FLOOR_ORDER_HINT = "home.floor_order_hint"

        // Inside each worker card; the card itself is [worker].
        const val CARD_NAME = "home.worker.name"
        const val CARD_STATUS = "home.worker.status"
        const val CARD_META = "home.worker.meta"
        const val CARD_TITLE = "home.worker.title"
        const val CARD_DETAIL = "home.worker.detail"
        const val CARD_TODOS = "home.worker.todos"

        fun floor(id: String) = "home.floor/$id"
        fun worker(id: String) = "home.worker/$id"
    }

    /** The pinned Mission Control section at the top of Home: the Orchestrator's card and a row per external bot. */
    object Mission {
        const val SECTION = "mission.section"
        const val ORCHESTRATOR = "mission.orchestrator"
        const val ORCHESTRATOR_STATUS = "mission.orchestrator.status"
        const val ORCHESTRATOR_META = "mission.orchestrator.meta"
        const val ORCHESTRATOR_DETAIL = "mission.orchestrator.detail"
        const val ORCHESTRATOR_BLOCKED = "mission.orchestrator.blocked"
        /** The Orchestrator's row while it is off; it opens its screen, which can turn it on. */
        const val ORCHESTRATOR_OFF = "mission.orchestrator_off"
        fun bot(id: String) = "mission.bot/$id"
    }

    /** The Orchestrator's screen, beyond the worker screen's own names, and its settings sheet. */
    object Orchestrator {
        /** What it is for, with example prompts, before its first prompt or after a new conversation. */
        const val INTRO = "orchestrator.intro"
        /** It is off: what that means, and [TURN_ON]. */
        const val OFF = "orchestrator.off"
        const val TURN_ON = "orchestrator.turn_on"
        /** Why it can't start now, in place of the composer. */
        const val BLOCKED = "orchestrator.blocked"
        /** The header's overflow button, which opens [SHEET]. */
        const val MENU = "orchestrator.menu"
        /** Its team across floors, under the header. */
        const val TEAM = "orchestrator.team"
        const val SHEET = "orchestrator.sheet"
        /** On or off, a toggle row (`checked` is on). */
        const val SWITCH = "orchestrator.on"
        const val MODEL_DEFAULT = "orchestrator.model_default"
        const val NEW_CONVERSATION = "orchestrator.new_conversation"
        const val NEW_DIALOG = "orchestrator.new_dialog"
        const val NEW_CONFIRM = "orchestrator.new_confirm"
        const val NEW_CANCEL = "orchestrator.new_cancel"
        /** The row under Me that opens [SHEET]. */
        const val SETTINGS = "settings.orchestrator"

        /** An example prompt in [INTRO], from 1: tapping it fills the composer. */
        fun example(n: Int) = "orchestrator.example/$n"
        /** A reasoning choice in [SHEET]; `default` is the office's. */
        fun effort(wire: String) = "orchestrator.effort/$wire"
        /** A subagent in [TEAM] or on a bot's screen: opens it on its floor. */
        fun member(id: String) = "orchestrator.team/$id"
    }

    /** An external bot's screen: it runs elsewhere, so there is no terminal or thread here. */
    object Bot {
        const val SCREEN = "screen.bot"
        const val NAME = "bot.name"
        const val STATUS = "bot.status"
        const val ACTIVITY = "bot.activity"
        const val LAST_USED = "bot.last_used"
        const val TEAM = "bot.team"
    }

    object WorkerActions {
        const val SHEET = "worker_actions.sheet"
        const val NAME = "worker_actions.name"
        const val FORK = "worker_actions.fork"
        const val FORK_REASON = "worker_actions.fork_reason"
        const val DISMISS = "worker_actions.dismiss"
    }

    object Fork {
        const val DIALOG = "fork.dialog"
        const val PROMPT = "fork.prompt"
        const val CONFIRM = "fork.confirm"
        const val CANCEL = "fork.cancel"
        const val ERROR = "fork.error"
    }

    object Hire {
        const val SHEET = "hire.sheet"
        /** Closes the hire screen without hiring. */
        const val CLOSE = "hire.close"
        const val DROID = "hire.droid"
        const val SHELL = "hire.shell"
        const val PROMPT = "hire.prompt"
        const val MODEL = "hire.model"
        const val WORKTREE = "hire.worktree"
        /** "Also work in": other floors' projects a Droid in its own worktree takes on too. */
        const val REPOS = "hire.repos"
        fun repo(floorId: String) = "hire.repo/$floorId"
        const val SUBMIT = "hire.submit"
        const val MODEL_SHEET = "hire.model_sheet"
        const val MODEL_SEARCH = "hire.model_search"
        const val MODEL_CUSTOM = "hire.model_custom"
        const val MODEL_CLOSE = "hire.model_close"
        fun modelScope(name: String) = "hire.model_scope/$name"

        fun effort(wire: String) = "hire.effort/$wire"
        fun model(id: String) = "hire.model/$id"

        /** Why a model in the list can't be chosen, or the quiet note that DroidProxy will be started. */
        fun modelWhy(id: String) = "hire.model_why/$id"

        /** Where a Droid runs, shown while the office is connected to Factory and has a computer or Environment to offer. */
        const val RUNS_ON = "hire.runs_on"
        /** The folder on that computer, and the note under it. */
        const val FOLDER = "hire.folder"
        const val FOLDER_NOTE = "hire.folder_note"
        /** The model picked can't run on a Factory computer. */
        const val CLOUD_MODEL = "hire.cloud_model"

        /** A "Runs on" choice: `local` for this machine, `env:<environmentId>` or a computer's id. */
        fun runsOn(key: String) = "hire.runs_on/${key.ifEmpty { "local" }}"
    }

    object HostUpdate {
        const val OPEN = "host_update.open"
        const val SHEET = "host_update.sheet"
        const val STATUS = "host_update.status"
        const val ERROR = "host_update.error"
        const val CLOSE = "host_update.close"
        const val CHECK = "host_update.check"
        const val INSTALL = "host_update.install"
        const val CONFIRM_DIALOG = "host_update.confirm_dialog"
        const val CONFIRM = "host_update.confirm"
        const val CANCEL = "host_update.cancel"
    }

    object Subscriptions {
        const val OPEN = "subscriptions.open"
        const val SHEET = "subscriptions.sheet"
        const val STATUS = "subscriptions.status"
        const val CLOSE = "subscriptions.close"
        const val DETAIL = "subscriptions.detail"
        const val OFF = "subscriptions.off"
        const val UNCONNECTED = "subscriptions.unconnected"
        fun provider(key: String) = "subscriptions.provider/$key"
        fun ring(provider: String, account: String) = "subscriptions.ring/$provider/$account"
    }

    object Worker {
        /** Reserved: external bots now open [Bot.SCREEN] from Mission Control. */
        const val REMOTE = "worker.remote"
        const val BACK = "worker.back"
        const val NAME = "worker.name"
        const val META = "worker.meta"
        const val STATUS = "worker.status"
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
        /** Why a cloud worker can't work right now, above its composer; Send is off while it shows. */
        const val CLOUD_ERROR = "worker.cloud.error"
        const val GONE = "worker.gone"
        const val GONE_BACK = "worker.gone.back"
        const val KEYS = "worker.keys"
        const val PHONE = "key.phone"
        const val DIRECT_INPUT = "worker.input.direct"
        /** The button at the end of the quick keys that opens [KEYS_SHEET]. */
        const val KEYS_ARRANGE = "worker.keys.arrange"
        const val KEYS_SHEET = "worker.keys_sheet"
        const val KEYS_RESET = "worker.keys_sheet.reset"
        const val KEYS_DONE = "worker.keys_sheet.done"
        const val INPUT = "composer.input"
        const val ATTACH = "composer.attach"
        const val SEND = "composer.send"
        /** While Droid is on a turn: sends the draft to Droid's queue, for after the turn (Send steers the turn now). */
        const val QUEUE_SEND = "composer.queue_send"
        /** Droid's slash commands matching a draft that starts with `/`, over the composer. */
        const val SLASH_MENU = "composer.slash_menu"
        /** In the Thread view while the worker is on a turn: stops it with Esc, as Droid's own Esc does. */
        const val STOP = "composer.stop"
        /** Why Send is off while the office is out of reach: the draft stays and nothing is sent later on its own. */
        const val COMPOSER_OFFLINE = "composer.offline"

        /** A numbered menu choice above the terminal, by the number the menu shows. */
        fun choice(number: Int) = "worker.choice/$number"
        const val VIEW_THREAD = "worker.view.thread"
        const val VIEW_TTY = "worker.view.tty"
        const val THREAD = "worker.thread"
        const val THREAD_PROMPT = "worker.thread.prompt"
        const val THREAD_ACTIVITY = "worker.thread.activity"
        const val LIVE_LINE = "worker.live_line"
        /** The conversation, a lazy list: swipe it to scroll. */
        const val THREAD_LIST = "worker.thread.list"
        /** Readable state when there are no messages to show: its text says loading, empty, unavailable or why not. */
        const val THREAD_STATE = "worker.thread.state"
        const val THREAD_RETRY = "worker.thread.retry"
        /** Switches to Raw TTY from a state, notice or question the thread can't handle. */
        const val THREAD_RAW_TTY = "worker.thread.raw_tty"
        const val THREAD_CODE_HINT = "worker.thread.code.hint"
        /** The messages waiting in Droid's queue, after the conversation. */
        const val THREAD_QUEUED = "worker.thread.queued"
        /** Clears Droid's queue (Ctrl+X), shown while its screen shows one. */
        const val THREAD_QUEUED_CLEAR = "worker.thread.queued.clear"
        const val THREAD_EARLIER = "worker.thread.earlier"
        const val THREAD_START = "worker.thread.start"
        /** Shown when scrolled up from the newest message: back to the bottom, which follows new ones again. */
        const val THREAD_JUMP = "worker.thread.jump"
        /** An error from the office shown over messages already here. */
        const val THREAD_ERROR = "worker.thread.error"
        /** In place of the composer while the worker waits on its terminal: prompts aren't sent into a question. */
        const val THREAD_WAITING = "worker.thread.waiting"
        /** The Raw TTY button in [THREAD_WAITING]. */
        const val THREAD_WAITING_TTY = "worker.thread.waiting.raw_tty"
        /** After Load earlier pushed the newest entries out: loads the newest page again. */
        const val THREAD_NEWER = "worker.thread.newer"
        /** In place of the conversation when the office's Thread can't be read here: update the office or the app, or use Raw TTY. */
        const val THREAD_UPDATE = "worker.thread.update"

        /** The row in the Thread view with the Thread and Raw TTY switch, the PR and the branch. */
        const val THREAD_BAR = "worker.thread.bar"
        /** The [THREAD_JUMP] arrow, described as "Jump to latest" or the new-message count. */
        const val THREAD_JUMP_LABEL = "worker.thread.jump.label"
        /** A Markdown table in a message: its columns line up and it scrolls sideways as one. */
        const val THREAD_TABLE = "worker.thread.table"
        /** A picture at full size over the Thread, opened from [threadImage]; tap it or [THREAD_IMAGE_CLOSE] to close. */
        const val THREAD_IMAGE_VIEWER = "worker.thread.image_viewer"
        const val THREAD_IMAGE_CLOSE = "worker.thread.image_viewer.close"
        /** A picture a tool returned or a message carried, by its image id: tapping it opens [THREAD_IMAGE_VIEWER]. */
        fun threadImage(id: String) = "worker.thread.image/$id"

        /** A slash command in [SLASH_MENU], by its name: `composer.slash/model`. */
        fun slash(name: String) = "composer.slash/$name"
        /** A message waiting in Droid's queue, by its place in it from 1. */
        fun threadQueued(n: Int) = "worker.thread.queued/$n"
        /** A message, tool call, thought or notice in the thread, by its entry id. */
        fun threadEntry(id: String) = "worker.thread.entry/$id"
        /** Expands or collapses a tool call's arguments and result, or a thought (`checked` is open). */
        fun threadToggle(id: String) = "worker.thread.toggle/$id"
        /** Shows all of a long message from the owner, or only its first lines again (`checked` is all of it). */
        fun threadMore(id: String) = "worker.thread.more/$id"
        /** One consecutive run of tool calls, by the id of its first entry. */
        fun threadGroup(id: String) = "worker.thread.group/$id"
        /** Opens or closes a run's list of actions (`checked` is open). */
        fun threadGroupToggle(id: String) = "worker.thread.group.toggle/$id"
        /** A run's one-line summary: "Read 3 files · Ran 2 commands". */
        fun threadGroupSummary(id: String) = "worker.thread.group.summary/$id"
        /** What failed in a run, shown even while it is closed. */
        fun threadGroupError(id: String) = "worker.thread.group.error/$id"
        /** The plan as the run left it, inside the open run. Reserved: plans are now under [threadRunPlan]. */
        fun threadGroupPlan(id: String) = "worker.thread.group.plan/$id"
        /** What didn't simply finish in an Activity: "2 failed · 1 no result". */
        fun threadGroupStatus(id: String) = "worker.thread.group.status/$id"
        /** What a live Activity is running now. */
        fun threadGroupRunning(id: String) = "worker.thread.group.running/$id"
        /** One run of tool calls inside an open Activity, by the id of the run's first entry. */
        fun threadRun(id: String) = "worker.thread.run/$id"
        /** Opens or closes a run's actions (`checked` is open). */
        fun threadRunToggle(id: String) = "worker.thread.run.toggle/$id"
        /** The run's plan, when it changed since the last one shown, inside the open run. */
        fun threadRunPlan(id: String) = "worker.thread.run.plan/$id"
        /** In an open call whose entry isn't loaded: Load earlier brings what it was given and returned. */
        fun threadNotLoaded(id: String) = "worker.thread.not_loaded/$id"

        /** A quick key, by what TalkBack calls it: "Shift Tab" is `key.shift_tab`. */
        fun key(spoken: String) = "key." + spoken.lowercase().replace(' ', '_')

        /** A quick key's row in [KEYS_SHEET], and its move buttons, by its id (`control_c`). */
        fun arrangeKey(id: String) = "worker.keys_sheet.key/$id"
        fun arrangeUp(id: String) = "worker.keys_sheet.up/$id"
        fun arrangeDown(id: String) = "worker.keys_sheet.down/$id"

        fun removeImage(number: Int) = "composer.remove_image/$number"
    }

    object SendHome {
        const val DIALOG = "send_home.dialog"
        const val CONFIRM = "send_home.confirm"
        const val ERROR = "send_home.error"
        /** For a cloud worker: also delete its Factory session. */
        const val DELETE_SESSION = "send_home.delete_session"
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
        const val ANSWER_DELAY = "settings.answer_delay"
        const val FORGET_DIALOG = "forget.dialog"
        const val FORGET_CONFIRM = "forget.confirm"
        const val FORGET_CANCEL = "forget.cancel"
        const val RENAME_DIALOG = "offices.rename_dialog"
        const val RENAME_INPUT = "offices.rename.input"
        const val RENAME_SAVE = "offices.rename.save"
        const val RENAME_CANCEL = "offices.rename.cancel"

        fun office(id: String) = "offices.office/$id"
        fun forget(id: String) = "offices.forget/$id"
        fun rename(id: String) = "offices.rename/$id"
        fun name(id: String) = "offices.name/$id"
    }
}
