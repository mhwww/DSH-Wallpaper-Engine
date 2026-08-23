import json

cfg = json.load(open(r'D:\game\steam\steamapps\common\wallpaper_engine\config.json', encoding='utf-8'))
user = cfg.get('Administrator')
print('user keys:', list(user.keys())[:30])
# 找 playlist / favorite / current 相关
for k in user.keys():
    lk = k.lower()
    if 'playlist' in lk or 'favorite' in lk or 'wallpaper' in lk or 'install' in lk:
        v = user[k]
        s = json.dumps(v, ensure_ascii=False)
        print(f'\n== {k} ({type(v).__name__}) ==\n{s[:800]}')
