#!/bin/bash
# Sourced by every office-choreography, office-video-capture and office-demo-staging script.
# Override any of these before sourcing:
#   AGENT_BROWSER_SESSION  the named agent-browser session (default office-rig)
#   OFFICE_URL             the office to drive (default the owner's office on :4600)
#   CAPTURE_DIR            where clips/, sheets/, stage.log and stills go (default the current directory)

# Headless Chromium uses software WebGL and drops the office page to about:blank after ~20 s,
# and agent-browser relaunches headless after an idle shutdown unless these are set on every call.
: "${AGENT_BROWSER_SESSION:=office-rig}"
export AGENT_BROWSER_SESSION
export AGENT_BROWSER_HEADED=1
export AGENT_BROWSER_IDLE_TIMEOUT_MS=0

: "${OFFICE_URL:=http://127.0.0.1:4600}"
export OFFICE_URL
: "${CAPTURE_DIR:=$PWD}"
export CAPTURE_DIR

OFFICE_RIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export OFFICE_RIG_DIR
