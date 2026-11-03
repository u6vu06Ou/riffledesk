# make_pptx_fixture.py — 生成 tests/fixtures/deck.pptx（驗收用固定夾具）。
# 用法：python tests/fixtures/make_pptx_fixture.py
# 需要 python-pptx（pip install python-pptx）。產生 3 張投影片：
#   1. 標題：「RiffleDesk 投影片驗收」
#   2. 內文含已知字串「閃電小螺絲」＋不同字級
#   3. 一張小圖（程式內手刻的 96x96 PNG，不依賴 PIL）
# 輸出位置固定在腳本旁邊。
import os
import struct
import zlib
from pptx import Presentation
from pptx.util import Inches, Pt

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'deck.pptx')
PNG_TMP = os.path.join(HERE, '_fixture_img.png')


def make_png(path, w=96, h=96):
    """手刻一張 w×h 漸層 PNG（標準 zlib/struct，不用 PIL）。"""
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    raw = b''
    for y in range(h):
        raw += b'\x00'  # filter: none
        for x in range(w):
            raw += bytes([(x * 255) // max(1, w - 1), (y * 255) // max(1, h - 1), 128])
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)  # 8-bit RGB
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', zlib.compress(raw)))
        f.write(chunk(b'IEND', b''))


def main():
    make_png(PNG_TMP)
    prs = Presentation()   # 預設 10"×7.5"（4:3）
    blank = prs.slide_layouts[6]

    # 1. 標題（明確文字框＋位置，驗證絕對定位路徑）
    s1 = prs.slides.add_slide(blank)
    tb = s1.shapes.add_textbox(Inches(1), Inches(2.5), Inches(8), Inches(1.5))
    r = tb.text_frame.paragraphs[0].add_run()
    r.text = 'RiffleDesk 投影片驗收'
    r.font.size = Pt(40)

    # 2. 內文：已知查找字串＋兩種字級
    s2 = prs.slides.add_slide(blank)
    tb2 = s2.shapes.add_textbox(Inches(0.8), Inches(1), Inches(8.5), Inches(5))
    tf2 = tb2.text_frame
    tf2.text = '重點清單'
    tf2.paragraphs[0].runs[0].font.size = Pt(28)
    p = tf2.add_paragraph()
    r = p.add_run()
    r.text = '閃電小螺絲藏在第二張投影片'
    r.font.size = Pt(18)
    p2 = tf2.add_paragraph()
    p2.add_run().text = 'lightning screw'

    # 3. 圖片（吃 p:pic / a:blip → rels → ppt/media 路徑）
    s3 = prs.slides.add_slide(blank)
    s3.shapes.add_picture(PNG_TMP, Inches(3), Inches(2), Inches(4), Inches(3))

    prs.save(OUT)
    os.remove(PNG_TMP)
    print('wrote', OUT, os.path.getsize(OUT), 'bytes')


if __name__ == '__main__':
    main()
