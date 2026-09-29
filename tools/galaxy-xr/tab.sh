#!/bin/sh
# Prints the office tab's DevTools WebSocket URL (the tab whose URL contains $XR_MATCH).
curl -s localhost:9333/json/list | python3 -c "import json,sys,os; m=os.environ.get('XR_MATCH','localhost:4600/'); t=[x for x in json.load(sys.stdin) if x['type']=='page' and m in x['url']]; print(t[0]['webSocketDebuggerUrl'] if t else '')"
