#!/usr/bin/env python3
"""ペットと部屋の素材（PNG 連番）を、アプリ用の WebP スプライトシートと設定ファイルに変換する。

使い方（展開済みの素材フォルダを指定）:
  python3 -I scripts/build-pet-assets.py \
    --dogs DIR --cats DIR --birds DIR --extra DIR --idle DIR \
    --marmot-walk DIR --marmot-eat DIR --marmot-extra DIR --room DIR

出力:
  public/assets/pets/<group>/<id>/<anim>.webp  … 1 コマ 256×256 を横に並べたシート
  public/assets/room/*.webp                     … 背景と家具
  src/pets/assets.json                          … コマ数・再生速度・ループ・足元位置
画像の見た目は変えない（形式の変換と、家具の縮小だけ）。
"""
import argparse, json, os, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PETS = os.path.join(ROOT, 'public/assets/pets')
OUT_ROOM = os.path.join(ROOT, 'public/assets/room')
OUT_JSON = os.path.join(ROOT, 'src/pets/assets.json')

# id → (出力フォルダ, 素材フォルダ名, 待機画像)
PETS = {
    'shiba': ('dogs/shiba', 'shiba', '02_shiba_idle.png'),
    'golden': ('dogs/golden', 'golden', '03_golden_idle.png'),
    'corgi': ('dogs/corgi', 'corgi', '04_corgi_idle.png'),
    'tabby': ('cats/tabby', 'tabby', '05_tabby_idle.png'),
    'calico': ('cats/calico', 'calico', '06_calico_idle.png'),
    'ragdoll': ('cats/ragdoll', 'ragdoll', '07_ragdoll_idle.png'),
    'marmot': ('marmot', None, '01_marmot_idle.png'),
    'budgie': ('birds/budgie', 'budgie', '08_budgie_idle.png'),
    'cockatiel': ('birds/cockatiel', 'cockatiel', '09_cockatiel_idle.png'),
    'java_sparrow': ('birds/java-sparrow', 'java_sparrow', '10_java_sparrow_idle.png'),
}
GROUP_OF = {'shiba': 'dogs', 'golden': 'dogs', 'corgi': 'dogs', 'tabby': 'cats', 'calico': 'cats', 'ragdoll': 'cats',
            'budgie': 'birds', 'cockatiel': 'birds', 'java_sparrow': 'birds'}
FURNITURE = ['rug', 'bookshelf', 'plant', 'bed', 'cushion', 'cat_tower', 'bowl', 'ball', 'mouse']
CELL = 256
ANCHOR = [128, 232]


def sheet(files, out):
    frames = [Image.open(f).convert('RGBA') for f in files]
    for f in frames:
        if f.size != (CELL, CELL):
            sys.exit(f'unexpected frame size {f.size}: {files}')
    im = Image.new('RGBA', (CELL * len(frames), CELL))
    for i, f in enumerate(frames):
        im.paste(f, (i * CELL, 0))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.save(out, 'WEBP', quality=88, method=6)
    return len(frames)


def anim_entry(rel, frames, meta):
    e = {'file': rel, 'frames': frames, 'frameMs': meta.get('frame_duration_ms', 120), 'loop': meta.get('loop', True)}
    seq = meta.get('playback_sequence')
    if seq and seq != list(range(1, frames + 1)):
        e['sequence'] = [n - 1 for n in seq]
    if meta.get('return_to'):
        e['returnTo'] = meta['return_to']
    # 「遊ぶ」の絵にはどの種類にもボールが描かれている（マーモットの設定には印が無い）
    if meta.get('contains_toy_ball') or rel.endswith('/play.webp'):
        e['hidesBall'] = True
    return e


def main():
    p = argparse.ArgumentParser()
    for k in ['dogs', 'cats', 'birds', 'extra', 'idle', 'marmot-walk', 'marmot-eat', 'marmot-extra', 'room']:
        p.add_argument('--' + k, required=True)
    a = p.parse_args()
    groups = {'dogs': a.dogs, 'cats': a.cats, 'birds': a.birds}
    config = {'cell': CELL, 'anchor': ANCHOR, 'pets': {}}

    for pid, (outdir, src, idle) in PETS.items():
        anims = {}
        def add(name, files, meta):
            rel = f'{outdir}/{name}.webp'
            n = sheet(files, os.path.join(OUT_PETS, rel))
            anims[name] = anim_entry(rel, n, meta)
        add('idle', [os.path.join(a.idle, idle)], {'loop': True, 'frame_duration_ms': 1000})
        if pid == 'marmot':
            walk_meta = json.load(open(os.path.join(a.marmot_walk, 'animation.json')))
            for d in ['front', 'back', 'left', 'right']:
                files = [os.path.join(a.marmot_walk, d, f'walk_{d}_{i:02d}.png') for i in range(1, 9)]
                add(f'walk_{d}', files, {'frame_duration_ms': round(1000 / walk_meta.get('suggested_fps', 8)), 'loop': True})
            for base in [a.marmot_eat, a.marmot_extra]:
                meta = json.load(open(os.path.join(base, 'animation.json')))['animations']
                for name, m in meta.items():
                    add(name, [os.path.join(base, f) for f in m['files']], m)
        else:
            for base in [os.path.join(groups[GROUP_OF[pid]], src), os.path.join(a.extra, src)]:
                meta = json.load(open(os.path.join(base, 'animation.json')))['animations']
                for name, m in meta.items():
                    add(name, [os.path.join(base, f) for f in m['files']], m)
        config['pets'][pid] = {'animations': anims}

    # 部屋：背景と家具（家具は第 4 段階の配置に固定）
    os.makedirs(OUT_ROOM, exist_ok=True)
    layout = json.load(open(os.path.join(a.room, 'stage_4/layout.json')))
    Image.open(os.path.join(a.room, 'stage_4', layout['background'])).convert('RGB').save(
        os.path.join(OUT_ROOM, 'background.webp'), 'WEBP', quality=85, method=6)
    items = {}
    for key in FURNITURE:
        it = layout['items'][key]
        im = Image.open(os.path.join(a.room, 'assets', f'{key}.png')).convert('RGBA')
        # 画面の拡大（Retina）に備えて配置サイズの 1.5 倍で保存
        w, h = round(it['width'] * 1.5), round(it['height'] * 1.5)
        if w < im.width:
            im = im.resize((w, h), Image.LANCZOS)
        im.save(os.path.join(OUT_ROOM, f'{key}.webp'), 'WEBP', quality=88, method=6)
        items[key] = {'file': f'{key}.webp', 'x': it['x'], 'y': it['y'], 'w': it['width'], 'h': it['height'], 'groundY': it['ground_y']}
    config['room'] = {'width': layout['canvas'][0], 'height': layout['canvas'][1], 'background': 'background.webp', 'items': items}

    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, 'w') as f:
        json.dump(config, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print('ok')


if __name__ == '__main__':
    main()
