#!/usr/bin/env bash
# Shared listener ownership guard for launch, drive and doctor.
owns_listener() {
  local listeners listener group
  listeners=$(lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null) || return 1
  [[ -n "$listeners" ]] || return 1
  for listener in $listeners; do
    group=$(ps -o pgid= -p "$listener" | tr -d ' ') || return 1
    [[ "$group" == "$2" ]] || return 1
  done
}
