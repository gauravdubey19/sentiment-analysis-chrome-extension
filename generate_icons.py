#!/usr/bin/env python3
"""
SentiScope Icon Generator
Generates icon-16.png, icon-48.png, icon-128.png using the Pillow library.
Run: pip install Pillow && python3 generate_icons.py
"""

import os
import math

def generate_icons():
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("Pillow not found. Installing...")
        os.system("pip3 install Pillow")
        from PIL import Image, ImageDraw, ImageFont

    os.makedirs('icons', exist_ok=True)

    # Brand gradient: purple #a855f7 → indigo #6366f1
    # We'll simulate a gradient by blending
    def blend(c1, c2, t):
        return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))

    purple = (168, 85, 247)
    indigo = (99,  102, 241)

    for size in [16, 48, 128]:
        img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        # Draw gradient background circle with rounded-rect shape
        margin = max(1, size // 16)
        r = size // 4  # corner radius

        # Draw gradient pixel by pixel inside rounded rect
        for y in range(margin, size - margin):
            for x in range(margin, size - margin):
                # Check if inside rounded rect
                cx = size / 2
                cy = size / 2
                dx = abs(x - cx) - (size / 2 - margin - r)
                dy = abs(y - cy) - (size / 2 - margin - r)
                inside = (dx <= r and dy <= r and
                          (dx <= 0 or dy <= 0 or dx * dx + dy * dy <= r * r))
                if inside:
                    t = (x - margin) / max(1, size - 2 * margin - 1)
                    color = blend(purple, indigo, t) + (255,)
                    img.putpixel((x, y), color)

        # Draw "S" letter centered
        if size >= 48:
            font_size = size // 2
            try:
                # Try to load a system font
                font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
            except Exception:
                try:
                    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
                except Exception:
                    font = ImageFont.load_default()

            # Get text bounding box
            bbox = draw.textbbox((0, 0), "S", font=font)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]
            tx = (size - tw) // 2 - bbox[0]
            ty = (size - th) // 2 - bbox[1]
            draw.text((tx, ty), "S", fill=(255, 255, 255, 240), font=font)
        else:
            # For 16px, draw a simplified "S" shape using pixels
            # Draw white dot in center
            cx, cy = size // 2, size // 2
            dot_r = max(1, size // 6)
            for dy in range(-dot_r, dot_r + 1):
                for dx in range(-dot_r, dot_r + 1):
                    if dx*dx + dy*dy <= dot_r*dot_r:
                        px, py = cx + dx, cy + dy
                        if 0 <= px < size and 0 <= py < size:
                            img.putpixel((px, py), (255, 255, 255, 220))

        # Save
        path = f'icons/icon-{size}.png'
        img.save(path, 'PNG')
        print(f'✅ Created {path} ({size}x{size}px)')

    print('\n🎨 All icons generated successfully!')
    print('📁 Check the icons/ directory')

if __name__ == '__main__':
    generate_icons()
