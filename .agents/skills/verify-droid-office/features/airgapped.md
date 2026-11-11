# Airgapped no-account setup

The owner can skip Factory sign-in during onboarding or switch modes in Connections later. Office requires a usable configured custom model, keeps credentials, and explains that the public build is not network-silent.

## Sub-features

- `airgapped-welcome` offers no-account setup beside Sign in.
- `airgapped-model-required` blocks Start without a usable custom model.
- `airgapped-settings` switches modes and replaces account facts.
- `airgapped-factory` disables Factory account/API features with a reason.
- `airgapped-turn` runs a real worker turn on a configured BYOK endpoint.

## How to get to it (user POV)

- Open **Welcome**, then **Factory account**.
- Open **Settings → Connections → Droid → Airgapped mode**.
- Configure DroidProxy or a custom model, then use **Check again** and select the model in Ready or Settings → Models.

## Driving it with agent-browser and window.office

Preconditions:

- Build and prepare an isolated `office-clone --fresh`. Use a named browser session and a port other than 4600.
- For genuinely signed-out onboarding, launch the scratch office without inherited Factory environment credentials. Changing HOME alone is not isolation.
- `airgapped-turn` additionally needs a real reachable custom endpoint and authorization for inference costs.

- **Welcome.** Use `office.open('welcome')`, choose the Factory step, then click **Use without an account (airgapped)**. The stage reads **Airgapped · no Factory account**, without opening the sign-in page.
- **No model.** With no configured custom model, Ready explains how to add one and Start is disabled. Capture at 1440×900 and 1024×700.
- **Settings.** `office.open('settings')`, click Connections, then the Airgapped mode checkbox. The facts line replaces account information; switching off restores Sign in when signed out. Close, reopen and use Escape.
- **Factory.** The Factory API key row shows why it is unavailable. Read-only requests to `/api/factory/computers` return 403. `/api/agents/droid/models` reports `customOnly: true` and only custom models, or an empty list when none are configured.
- **Real turn.** Configure a real custom model through its supported configuration path, press Check again, select it and Start, then hire through the ordinary desk UI and verify the worker's reply. Do not replace inference with a fake endpoint for live proof.

## Gotchas

- No-account mode is not a network sandbox and does not stop already-running Droid turns.
- The cloud worker environment may itself contain Factory credentials; use a credential-free environment for the signed-out scenario.
- Wait for the expected state after clicks before capturing, since setup checks and broadcasts are asynchronous.
- Linux proof on 2026-11-11 covered welcome, missing-model blocking, settings at both sizes, restoration to account mode, and live HTTP guards. A real custom-model turn and Android execution were not available on this computer.
