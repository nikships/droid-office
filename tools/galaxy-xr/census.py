import json, sys

a = json.load(sys.stdin)
print('TOTAL', a['total'])
for r in a['rows']:
    print(f"{r['path'][:60]:60} meshes {r['meshes']:5} ktris {r['ktris']:8} draws/eye {r['draws']:4} drawnKtris {r['drawnKtris']}")
