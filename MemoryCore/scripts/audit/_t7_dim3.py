import sqlite3, json
con = sqlite3.connect('file:/data/tdai-memory/vectors.db?mode=ro', uri=True)
cur = con.cursor()
out = {}
out['coreValuesTotal'] = cur.execute('SELECT COUNT(*) FROM core_values').fetchone()[0]
out['coreValuesNoDesc'] = cur.execute("SELECT COUNT(*) FROM core_values WHERE attrs_json='' OR attrs_json='{}'").fetchone()[0]
try:
    out['characterPool'] = cur.execute("SELECT COUNT(*) FROM core_values WHERE node_type='character' AND state='active'").fetchone()[0]
    out['personPool'] = cur.execute("SELECT COUNT(*) FROM core_values WHERE node_type='person' AND state='active'").fetchone()[0]
    out['themePool'] = cur.execute("SELECT COUNT(*) FROM core_values WHERE node_type='theme' AND state='active'").fetchone()[0]
except Exception as e:
    out['poolErr'] = str(e)[:80]
print(json.dumps(out))
