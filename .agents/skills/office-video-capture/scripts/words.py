#!/usr/bin/env python3
"""words.py <transcript.json|tool-output.log> <out.words.json>

Turns a gemini-aio transcribe_audio result (word_timestamps on) into a word list
[{"w": "Five", "s": 0.3, "e": 0.7}, ...] and prints one line per sentence with its start and
end, which is what the edit cuts on. Accepts the raw JSON or a saved tool-output log that has
text before the JSON.
"""

import json
import sys


def load(path):
    raw = open(path, encoding="utf-8").read()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return json.loads(raw[raw.find("{"):])


def seconds(v):
    return float(str(v).rstrip("s"))


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    d = load(sys.argv[1])
    if isinstance(d, list):
        # Already a word list (a words.json from an earlier run): just print its sentences.
        words = d
    else:
        notes = []
        for out in d.get("outputs", []):
            notes.extend(out.get("annotations") or [])
        words = [{"w": a["text"], "s": seconds(a["start_offset"]), "e": seconds(a["end_offset"])} for a in notes if "start_offset" in a]
    if not words:
        sys.exit("no word timings: transcribe with word_timestamps=true (verbatim mode)")
    json.dump(words, open(sys.argv[2], "w", encoding="utf-8"), indent=0)
    line = []
    for w in words:
        line.append(w)
        if w["w"][-1] in ".?!":
            print(f"{line[0]['s']:6.2f}-{line[-1]['e']:6.2f}  " + " ".join(x["w"] for x in line))
            line = []
    if line:
        print(f"{line[0]['s']:6.2f}-{line[-1]['e']:6.2f}  " + " ".join(x["w"] for x in line))
    print(f"{len(words)} words, ends at {words[-1]['e']:.2f}s -> {sys.argv[2]}", file=sys.stderr)


main()
