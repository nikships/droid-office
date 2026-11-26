package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.R
import androidx.compose.ui.graphics.Color

internal val OrbitalFoundry = Artwork(
    id = "orbital-foundry", name = "Orbital Foundry", blurb = "A ring forge burning against the black of space.",
    image = R.drawable.art_orbital_foundry, preview = R.drawable.preview_orbital_foundry,
    portrait = PortraitArt(R.drawable.art_orbital_foundry_portrait, focalX = .5f, focalY = .27f),
    x = .50f, y = .45f,
    bg = Color(0xFF0A0505), tint = Color(0xFF100707), text = Color(0xFFFBEFEA), muted = Color(0xFFC0A59C),
    accent = Color(0xFFFF5A36), accent2 = Color(0xFFFFB347), line = Color(0xFFFFD9CC), glass = .74f,
    terminal = TerminalInk("#fbefea", "#ff5a36", "#080303", "#4a1d14"),
    speed = 1.1f, stage = embers(Color(0xFFFF5A36), Color(0xFFFFB347), Color(0xFFFFE2A8), .85f),
)
