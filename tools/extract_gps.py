# -*- coding: utf-8 -*-
"""Qiita記事「Pythonを使ってiphoneで撮影した写真から位置情報を抽出する」の手順を
   フォルダ内の全画像へ適用し、ファイル名と位置情報を一覧化する。"""
import csv, os, re, struct, sys

import exifread  # 記事と同じ 2.3.2

# 対象フォルダ（引数で上書き可）。既定はリポジトリ内の現地写真フォルダ。
TARGET_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data", "photos", "mauracho")
IMG_EXT = (".jpg", ".jpeg", ".heic", ".png", ".tif", ".tiff")
MOV_EXT = (".mov", ".mp4")


def read_exif_from_image(image_path):
    """画像ファイルから EXIF データを読み込む"""
    try:
        with open(image_path, "rb") as f:
            return exifread.process_file(f, details=False)
    except (FileNotFoundError, IOError) as e:
        print("読み込み失敗: %s (%s)" % (image_path, e), file=sys.stderr)
        return None


def dms_to_decimal(dms):
    """度分秒（DMS）リストから10進数の座標に変換する関数"""
    degrees, minutes, seconds = [float(v.num) / float(v.den) for v in dms]
    return degrees + (minutes / 60) + (seconds / 3600)


def get_coordinates(exif_data):
    """EXIF タグから緯度と経度を抽出してタプルで返す（N/S・E/W の符号も反映）"""
    try:
        lat = dms_to_decimal(exif_data["GPS GPSLatitude"].values)
        lon = dms_to_decimal(exif_data["GPS GPSLongitude"].values)
    except KeyError:
        return None
    if str(exif_data.get("GPS GPSLatitudeRef", "N")) == "S":
        lat = -lat
    if str(exif_data.get("GPS GPSLongitudeRef", "E")) == "W":
        lon = -lon
    return (lat, lon)


def get_altitude(exif_data):
    try:
        v = exif_data["GPS GPSAltitude"].values[0]
        alt = float(v.num) / float(v.den)
        if str(exif_data.get("GPS GPSAltitudeRef", "0")) in ("1", "Below sea level"):
            alt = -alt
        return alt
    except (KeyError, IndexError, ZeroDivisionError):
        return None


def get_datetime(exif_data):
    for tag in ("EXIF DateTimeOriginal", "Image DateTime"):
        if tag in exif_data:
            return str(exif_data[tag])
    return None


def get_mov_location(path):
    """QuickTime(.MOV) の ISO6709 形式の位置情報を読む（記事の対象外の補足）"""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            data = f.read(8 * 1024 * 1024)
            if size > 8 * 1024 * 1024:
                f.seek(max(0, size - 8 * 1024 * 1024))
                data += f.read()
    except IOError:
        return None
    m = re.search(rb"([+-]\d{2,3}\.\d+)([+-]\d{2,3}\.\d+)(?:([+-]\d+\.\d+))?/", data)
    if not m:
        return None
    alt = float(m.group(3)) if m.group(3) else None
    dt = re.search(rb"(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})", data)
    when = "%s %s" % (dt.group(1).decode().replace("-", ":"), dt.group(2).decode()) if dt else ""
    return (float(m.group(1)), float(m.group(2)), alt, when)


def main():
    rows = []
    for name in sorted(os.listdir(TARGET_DIR)):
        path = os.path.join(TARGET_DIR, name)
        low = name.lower()
        if low.endswith(IMG_EXT):
            exif = read_exif_from_image(path)
            if exif is None:
                rows.append([name, "", "", "", "", "EXIF読込エラー"])
                continue
            coords = get_coordinates(exif)
            if coords is None:
                rows.append([name, "", "", "", get_datetime(exif) or "", "GPS情報なし"])
                continue
            alt = get_altitude(exif)
            rows.append([name,
                         "%.8f" % coords[0], "%.8f" % coords[1],
                         "" if alt is None else "%.2f" % alt,
                         get_datetime(exif) or "", "OK"])
        elif low.endswith(MOV_EXT):
            c = get_mov_location(path)
            if c:
                rows.append([name, "%.8f" % c[0], "%.8f" % c[1],
                             "" if c[2] is None else "%.2f" % c[2], c[3], "OK(動画)"])
            else:
                rows.append([name, "", "", "", "", "GPS情報なし(動画)"])

    out = os.path.join(TARGET_DIR, "位置情報一覧.csv")
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["ファイル名", "緯度", "経度", "標高(m)", "撮影日時", "備考"])
        w.writerows(rows)

    for r in rows:
        print("\t".join(r))
    print("---", len(rows), "件 ->", out, file=sys.stderr)


if __name__ == "__main__":
    main()
