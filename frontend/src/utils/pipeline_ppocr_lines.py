"""用真正的 PP-OCR 模型（RapidOCR 打包的 PP-OCRv4）产出行结构"""
from rapidocr_onnxruntime import RapidOCR
from PIL import Image
import json, glob, os, sys, numpy as np

engine = RapidOCR()
out = {}
for f in sorted(glob.glob('./demo/*.png')):
    name = os.path.splitext(os.path.basename(f))[0]
    im = Image.open(f).convert('RGB')
    res, _ = engine(np.array(im))
    lines = []
    for i, item in enumerate(res or []):
        poly, text, score = item[0], item[1], float(item[2])
        xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
        l, t, r, b = min(xs), min(ys), max(xs), max(ys)
        lines.append({'id': i, 'text': text, 'confidence': score*100,
            'left': l, 'top': t, 'right': r, 'bottom': b,
            'width': r-l, 'height': b-t, 'centerX': (l+r)/2, 'centerY': (t+b)/2})
    lines.sort(key=lambda x: (round(x['centerY']/max(1,x['height'])), x['left']))
    for i, ln in enumerate(lines): ln['id'] = i
    out[name] = {'lines': lines, 'width': im.width, 'height': im.height}
    print(f'{name}: {len(lines)} 行', file=sys.stderr)

json.dump(out, open('./demo_ocr_pp.json','w'), ensure_ascii=False)
