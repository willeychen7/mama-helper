"""把干净扫描件合成成「手机实拍」样子：透视 + 阴影 + 失焦 + JPEG 压缩。
用来验证预处理那条链路 —— 老人不会把信平铺在扫描仪上。"""
from PIL import Image, ImageFilter, ImageDraw
import numpy as np, sys, os

def find_coeffs(pa, pb):
    A=[]
    for p1,p2 in zip(pa,pb):
        A.append([p2[0],p2[1],1,0,0,0,-p1[0]*p2[0],-p1[0]*p2[1]])
        A.append([0,0,0,p2[0],p2[1],1,-p1[1]*p2[0],-p1[1]*p2[1]])
    return np.linalg.solve(np.array(A,dtype=float), np.array(pa,dtype=float).reshape(8))

def phone_shot(src_path, out_path, quad, W=1500, H=2000, blur=0.7, q=82, shade=0.42):
    src=Image.open(src_path).convert('RGB')
    s=min(900/src.width, 1300/src.height)
    src=src.resize((int(src.width*s),int(src.height*s)), Image.LANCZOS)
    bg=Image.new('RGB',(W,H),(62,58,54))
    coeffs=find_coeffs([(0,0),(src.width,0),(src.width,src.height),(0,src.height)], quad)
    warped=src.transform((W,H),Image.PERSPECTIVE,coeffs,Image.BICUBIC,fillcolor=(62,58,54))
    mask=Image.new('L',(W,H),0); ImageDraw.Draw(mask).polygon(quad,fill=255)
    bg.paste(warped,(0,0),mask)
    arr=np.asarray(bg).astype(np.float32); yy,xx=np.mgrid[0:H,0:W]
    g=(1-shade)+shade*np.clip(1.25-(xx/W)*0.85-(yy/H)*0.4,0,1.3)
    Image.fromarray(np.clip(arr*g[...,None],0,255).astype('uint8')) \
        .filter(ImageFilter.GaussianBlur(blur)).save(out_path,'JPEG',quality=q)

if __name__=='__main__':
    src,out=sys.argv[1],sys.argv[2]
    phone_shot(src,out,[(230,210),(1280,150),(1350,1830),(160,1760)])
    print('生成', out)
