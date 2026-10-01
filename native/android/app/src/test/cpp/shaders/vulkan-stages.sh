#!/usr/bin/env bash
# Helper of check.sh for the Vulkan dialect: each argument is a generated program, the path of its
# two stages without the .vert/.frag extension. Both stages compile to Vulkan 1.1 SPIR-V with glslc
# (shaderc, the compiler the Vulkan renderer embeds as libshaderc) and spirv-val validates them;
# glslangValidator then links the two (their interfaces and blocks must agree) and its reflection
# of the Draw block must match draw-offsets.txt (DrawBlock's offsets, written by dump). Prints one
# line per failure and exits 1 when any program failed.
#
#   GLSLC=... SPIRV_VAL=... GLSLANG=... OFFSETS=.../draw-offsets.txt vulkan-stages.sh <program>...
set -uo pipefail

status=0
work="$(mktemp -d "${TMPDIR:-/tmp}/vulkan-stages.XXXXXX")"
trap 'rm -rf "$work"' EXIT
want_size="$(sed -n 's/^size //p' "$OFFSETS")"
for program in "$@"; do
  ok=1
  for stage in "$program.vert" "$program.frag"; do
    if ! msg="$("$GLSLC" --target-env=vulkan1.1 -Werror -o "$stage.spv" "$stage" 2>&1)"; then
      printf 'glslc %s\n%s\n' "$stage" "$msg"
      ok=0
      continue
    fi
    if ! msg="$("$SPIRV_VAL" --target-env vulkan1.1 "$stage.spv" 2>&1)"; then
      printf 'spirv-val %s\n%s\n' "$stage" "$msg"
      ok=0
    fi
  done
  [ "$ok" -eq 1 ] || { status=1; continue; }
  # The link writes vert.spv and frag.spv into the working directory; -q prints the reflection.
  if ! reflection="$(cd "$work" && "$GLSLANG" -V --target-env vulkan1.1 -l -q "$program.vert" "$program.frag" 2>&1)" ||
    printf '%s\n' "$reflection" | grep -q -E '^(WARNING|ERROR)'; then
    printf 'glslang link %s\n%s\n' "$program" "$(printf '%s\n' "$reflection" | grep -E '^(WARNING|ERROR)|error' || true)"
    status=1
    continue
  fi
  # A program that reads no Draw member (a shadow pass without alpha test) reflects no Draw block.
  size="$(printf '%s\n' "$reflection" | sed -n 's/^Draw: offset -1, type ffffffff, size \([0-9]*\),.*/\1/p' | head -n 1)"
  if [ -n "$size" ] && [ "$size" != "$want_size" ]; then
    printf 'reflection %s: Draw block size %s, DrawBlock %s\n' "$program" "$size" "$want_size"
    status=1
  fi
  # Each reflected Draw member (a uniform named u..., at a non-negative offset) against DrawBlock;
  # members of other blocks are named Block.member and samplers have offset -1.
  if ! printf '%s\n' "$reflection" | sed -n 's/^\(u[A-Za-z0-9]*\): offset \([0-9]*\),.*/\1 \2/p' |
    awk -v program="$program" 'NR == FNR { want[$1] = $2; next }
      ($1 in want) && want[$1] != $2 {
        printf "reflection %s: %s at offset %s, DrawBlock %s\n", program, $1, $2, want[$1]; bad = 1 }
      END { exit bad }' "$OFFSETS" -; then
    status=1
  fi
done
exit "$status"
