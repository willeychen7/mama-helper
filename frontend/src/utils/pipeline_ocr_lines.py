"""用 tesseract 产出与 PaddleOCR 相同形状的行结构（text + bbox + conf）"""
import subprocess, json, sys, glob, os
from collections import defaultdict

def ocr(path):
    out = subprocess.run(
        ['tesseract', path, 'stdout', '--psm', '4', '-c', 'preserve_interword_spaces=1', 'tsv'],
        capture_output=True, text=True).stdout
    rows = [r.split('\t') for r in out.strip().split('\n')]
    hdr = rows[0]
    idx = {k: hdr.index(k) for k in
           ['level','block_num','par_num','line_num','left','top','width','height','conf','text']}
    groups = defaultdict(list)
    for r in rows[1:]:
        if len(r) < len(hdr): continue
        if r[idx['level']] != '5': continue
        txt = r[idx['text']].strip()
        if not txt: continue
        try: conf = float(r[idx['conf']])
        except: conf = -1
        if conf < 0: continue
        key = (r[idx['block_num']], r[idx['par_num']], r[idx['line_num']])
        groups[key].append({
            'text': txt, 'conf': conf,
            'l': int(r[idx['left']]), 't': int(r[idx['top']]),
            'w': int(r[idx['width']]), 'h': int(r[idx['height']])})
    lines = []
    for i, (k, words) in enumerate(sorted(groups.items(),
            key=lambda kv: (min(w['t'] for w in kv[1]), min(w['l'] for w in kv[1])))):
        left = min(w['l'] for w in words); top = min(w['t'] for w in words)
        right = max(w['l']+w['w'] for w in words); bottom = max(w['t']+w['h'] for w in words)
        lines.append({
            'id': i, 'text': ' '.join(w['text'] for w in words),
            'confidence': sum(w['conf'] for w in words)/len(words),
            'left': left, 'top': top, 'right': right, 'bottom': bottom,
            'width': right-left, 'height': bottom-top,
            'centerX': (left+right)/2, 'centerY': (top+bottom)/2})
    return lines

result = {}
for f in sorted(glob.glob('./demo/*.png')):
    name = os.path.splitext(os.path.basename(f))[0]
    from PIL import Image
    w, h = Image.open(f).size
    result[name] = {'lines': ocr(f), 'width': w, 'height': h}
    print(f'{name}: {len(result[name]["lines"])} lines', file=sys.stderr)

json.dump(result, open('./demo_ocr.json','w'), ensure_ascii=False)
