from PIL import Image

TARGET_RGB = (194, 24, 91)  # #C2185B

files = [
    "app/src/main/res/mipmap-hdpi/ic_launcher_foreground.png",
    "app/src/main/res/mipmap-mdpi/ic_launcher_foreground.png",
    "app/src/main/res/mipmap-xhdpi/ic_launcher_foreground.png",
    "app/src/main/res/mipmap-xxhdpi/ic_launcher_foreground.png",
    "app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png",
]

for f in files:
    img = Image.open(f).convert("RGBA")
    pixels = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if a > 0:
                pixels[x, y] = (TARGET_RGB[0], TARGET_RGB[1], TARGET_RGB[2], a)
    img.save(f)
    print("Recoloured:", f)
