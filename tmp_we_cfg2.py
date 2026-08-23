import json

cfg = json.load(open(r'D:\game\steam\steamapps\common\wallpaper_engine\config.json', encoding='utf-8'))
g = cfg['Administrator']['general']
wc = g.get('wallpaperconfig', {})
print('wallpaperconfig keys:', list(wc.keys()) if isinstance(wc, dict) else type(wc).__name__)
s = json.dumps(wc, ensure_ascii=False)
print(s[:1500])
print('\n=== playlists? ===')
user = g.get('user', {})
print('user keys:', list(user.keys()) if isinstance(user, dict) else str(user)[:200])
pu = json.dumps(user, ensure_ascii=False)
print(pu[:1500])
