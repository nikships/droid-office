package ai.factory.droidoffice.core

/**
 * The status line at the bottom of a live turn, as the Factory app's droidStatusIndicator words it:
 * which state the turn is in, and a phrase from that state's list, changed every [ROTATE_MS] with a
 * [FADE_MS] fade out and in, never the same one twice running.
 */
object ThreadStatus {
    /** How long a phrase stays before the next one fades in. */
    const val ROTATE_MS = 10_000L
    /** Each half of the swap: the old phrase fades out over this, then the new one fades in. */
    const val FADE_MS = 400
    /** The shimmer's sweep across the phrase. */
    const val SHIMMER_MS = 6_000
    const val COMPACTING = "Compacting conversation…"
    /** The worker's activity while Droid compacts (COMPACTING in src/server/worker-runtime/hooks.ts). */
    const val WORKER_COMPACTING = "Compacting its conversation"

    enum class Mode { Idle, Pondering, Responding, Waiting, Compacting }

    /**
     * The turn's state: the office's live one when it sends it, else what the worker's status says:
     * waiting on the owner, compacting, writing the last message ([streaming]), or thinking and working.
     */
    fun mode(w: WorkerInfo, live: ThreadLive?, streaming: Boolean): Mode {
        if (w.state == WorkerStatus.NeedsInput) return Mode.Waiting
        if (live != null) {
            return when (live.status) {
                ThreadLive.Status.Idle -> if (w.state.busy) Mode.Pondering else Mode.Idle
                ThreadLive.Status.Pondering -> Mode.Pondering
                ThreadLive.Status.Responding -> Mode.Responding
                ThreadLive.Status.Waiting -> Mode.Waiting
                ThreadLive.Status.Compacting -> Mode.Compacting
            }
        }
        return when {
            !w.state.busy -> Mode.Idle
            w.activity == WORKER_COMPACTING -> Mode.Compacting
            streaming -> Mode.Responding
            else -> Mode.Pondering
        }
    }

    fun phrases(mode: Mode): List<String> = when (mode) {
        Mode.Idle -> emptyList()
        Mode.Pondering -> PONDERS
        Mode.Responding -> RESPONDS
        Mode.Waiting -> WAITS
        Mode.Compacting -> listOf(COMPACTING)
    }

    /** A phrase index for [mode] other than [previous] where there's a choice; [random] takes a bound and returns 0 until it. */
    fun pick(mode: Mode, previous: Int, random: (Int) -> Int): Int {
        val n = phrases(mode).size
        if (n <= 1) return 0
        var i = random(n).coerceIn(0, n - 1)
        if (i == previous) i = (i + 1 + random(n - 1).coerceIn(0, n - 2)) % n
        return i
    }

    val PONDERS = listOf(
        "Following a thread here...",
        "There's something interesting about this...",
        "Let me trace this through...",
        "Something caught my attention...",
        "Let me look a bit closer...",
        "I wonder if this connects...",
        "This reminds me of something...",
        "Let me pull on this thread...",
        "Something here is worth exploring...",
        "Let me dig into this a bit...",
        "Curious about this part...",
        "I want to understand this better...",
        "There's more here than I expected...",
        "Following my intuition here...",
        "Something's taking shape...",
        "The pieces are starting to fit...",
        "This is beginning to click...",
        "A picture is forming...",
        "Things are coming into focus...",
        "The fog is starting to lift...",
        "I can see the outline now...",
        "It's starting to make sense...",
        "Connections are forming...",
        "A path is appearing...",
        "I think I'm onto something...",
        "Something's crystallizing here...",
        "The shape is revealing itself...",
        "Pieces falling into place...",
        "Let me think through this...",
        "Considering a few angles here...",
        "Turning this over in my mind...",
        "Weighing the options...",
        "Let me sit with this a moment...",
        "Thinking through the implications...",
        "Let me reason through this...",
        "Taking a moment to consider...",
        "Giving this some thought...",
        "Let me work through this...",
        "Thinking about the best approach...",
        "Considering how to tackle this...",
        "Mulling this over...",
        "Tracing the logic here...",
        "Exploring the possibilities...",
        "Mapping out the terrain...",
        "Navigating through this...",
        "Scanning the landscape...",
        "Probing a bit deeper...",
        "Working through the layers...",
        "Diving into the details...",
        "Making my way through this...",
        "Feeling out the edges...",
        "Charting a course here...",
        "I think I see a pattern...",
        "Something looks familiar here...",
        "I've seen something like this...",
        "There's a rhythm to this...",
        "The structure is showing itself...",
        "I'm spotting connections...",
        "There's a theme emerging...",
        "Noticing the underlying shape...",
        "Finding the hidden order...",
        "What's the best angle here...",
        "There might be a simpler way...",
        "What am I missing...",
        "Let me try another approach...",
        "What's the heart of this...",
        "Let me break this down...",
        "Finding the key insight...",
        "Zeroing in on the core...",
        "Getting to the essence...",
        "What if I approach it this way...",
        "Or maybe it's simpler than that...",
        "Hmm, that's interesting...",
        "Wait, what about this...",
        "Let me reconsider...",
        "Although, there's also...",
        "Could it be that...",
        "What if instead...",
        "Then again...",
        "Something's percolating...",
        "The gears are turning...",
        "Mental wheels spinning...",
        "Something's brewing here...",
        "Thoughts simmering...",
        "Ideas taking form...",
        "Reticulating the splines...",
        "Threads beginning to converge...",
        "The mist is clearing...",
        "Form emerging from the noise...",
        "Signal getting stronger...",
        "Edges becoming clearer...",
        "Layers slowly unfolding...",
    )

    val RESPONDS = listOf(
        "Gathering my thoughts...",
        "Finding the right words...",
        "Let me walk you through this...",
        "Here's what I'm thinking...",
        "Putting this together...",
        "Articulating the approach...",
        "Let me explain my thinking...",
        "Forming the response...",
        "Translating thoughts to words...",
        "Shaping the explanation...",
    )

    val WAITS = listOf(
        "Waiting on your thoughts...",
        "Standing by for your input...",
        "Ready when you are...",
        "Take your time...",
        "No rush, I'll be here...",
        "Whenever you're ready...",
        "Paused and listening...",
        "Patient as always...",
        "In no hurry...",
        "Standing by...",
        "Holding steady...",
        "Here whenever...",
        "At your pace...",
        "Waiting patiently...",
        "Taking a breather...",
        "On pause for now...",
        "Curious what you'll decide...",
        "Wondering which way you'll go...",
        "Interested to see your choice...",
        "Awaiting your direction...",
        "Eager to hear your take...",
        "Curious about your thinking...",
        "Interested in your perspective...",
        "Wondering what you're thinking...",
        "Intrigued to see your call...",
        "Looking forward to your input...",
        "Anticipating your decision...",
        "Curious which path you'll take...",
        "This one's your call...",
        "Over to you on this...",
        "Your move...",
        "Ball's in your court...",
        "Need your input here...",
        "Your decision to make...",
        "Deferring to your judgment...",
        "This requires your touch...",
        "You're the expert here...",
        "Trusting your instincts...",
        "Leaving this in your hands...",
        "Your expertise needed...",
        "Could use your guidance...",
        "Handing the reins to you...",
        "This one's all yours...",
        "Happy to wait...",
        "Here if you need more context...",
        "Let me know if I can clarify...",
        "Just say the word...",
        "Happy to elaborate if needed...",
        "Ask me anything...",
        "Here to help if you're stuck...",
        "Feel free to think it over...",
        "No pressure at all...",
        "Take all the time you need...",
        "I can explain more if helpful...",
        "Here for questions...",
        "Listening...",
        "All ears...",
        "Attentively waiting...",
        "Focused on you...",
        "Tuned in...",
        "Fully present...",
        "Giving you space to think...",
        "Quietly standing by...",
        "Twiddling my virtual thumbs...",
        "Patiently humming to myself...",
        "Enjoying the pause...",
        "A moment of zen...",
        "Brief intermission...",
        "Comfortable silence...",
        "The ball is airborne...",
        "Awaiting transmission...",
        "Respecting your process...",
        "Your thought process at work...",
        "Giving you room to decide...",
        "Space for consideration...",
        "Room to deliberate...",
        "Time to weigh options...",
    )
}
