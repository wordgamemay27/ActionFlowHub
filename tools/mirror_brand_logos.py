#!/usr/bin/env python3
"""
Scarica i 34 loghi ufficiali definiti in src/lib/brands.ts nella cartella public/logos/
"""
import os
import urllib.request

SEEDS = [
    ("amazon", "https://upload.wikimedia.org/wikipedia/commons/a/a9/Amazon_logo.svg"),
    ("netflix", "https://cdn.simpleicons.org/netflix/E50914"),
    ("spotify", "https://cdn.simpleicons.org/spotify/1ED760"),
    ("ton", "https://cdn.simpleicons.org/ton/0098EA"),
    ("telegram", "https://cdn.simpleicons.org/telegram/26A5E4"),
    ("discord", "https://cdn.simpleicons.org/discord/5865F2"),
    ("x", "https://cdn.simpleicons.org/x/FFFFFF"),
    ("paypal", "https://cdn.simpleicons.org/paypal/003087"),
    ("visa", "https://cdn.simpleicons.org/visa/1A1F71"),
    ("mastercard", "https://cdn.simpleicons.org/mastercard/EB001B"),
    ("steam", "https://cdn.simpleicons.org/steam/66C0F4"),
    ("playstation", "https://cdn.simpleicons.org/playstation/003791"),
    ("nike", "https://cdn.simpleicons.org/nike/F97316"),
    ("uber", "https://cdn.simpleicons.org/uber/FFFFFF"),
    ("googleplay", "https://cdn.simpleicons.org/googleplay/00A0FF"),
    ("apple", "https://cdn.simpleicons.org/apple/FFFFFF"),
    ("starbucks", "https://cdn.simpleicons.org/starbucks/00754A"),
    ("burgerking", "https://cdn.simpleicons.org/burgerking/D6231F"),
    ("mcdonalds", "https://cdn.simpleicons.org/mcdonalds/FFC72C"),
    ("pokemon", "https://upload.wikimedia.org/wikipedia/commons/9/98/International_Pok%C3%A9mon_logo.svg"),
    ("epicgames", "https://cdn.simpleicons.org/epicgames/FFFFFF"),
    ("dazn", "https://cdn.simpleicons.org/dazn/F8F32B"),
    ("roblox", "https://cdn.simpleicons.org/roblox/E2231C"),
    ("bitcoin", "https://cdn.simpleicons.org/bitcoin/F7931A"),
    ("ethereum", "https://cdn.simpleicons.org/ethereum/627EEA"),
    ("tiktok", "https://cdn.simpleicons.org/tiktok/69C9D0"),
    ("youtube", "https://cdn.simpleicons.org/youtube/FF0000"),
    ("instagram", "https://cdn.simpleicons.org/instagram/E4405F"),
    ("facebook", "https://cdn.simpleicons.org/facebook/0866FF"),
    ("binance", "https://cdn.simpleicons.org/binance/F3BA2F"),
    ("coinbase", "https://cdn.simpleicons.org/coinbase/0052FF"),
    ("vodafone", "https://cdn.simpleicons.org/vodafone/E60000"),
    ("zalando", "https://cdn.simpleicons.org/zalando/FF6900"),
    ("linkedin", "https://upload.wikimedia.org/wikipedia/commons/8/81/LinkedIn_icon.svg"),
]

def main():
    out_dirs = ["public/logos", "src/public/logos"]
    for d in out_dirs:
        os.makedirs(d, exist_ok=True)

    downloaded = 0
    for key, url in SEEDS:
        dest = os.path.join("public/logos", f"{key}.svg")
        if os.path.exists(dest) and os.path.getsize(dest) > 20:
            downloaded += 1
            continue
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = resp.read()
                if data:
                    with open(dest, "wb") as f:
                        f.write(data)
                    with open(os.path.join("src/public/logos", f"{key}.svg"), "wb") as f2:
                        f2.write(data)
                    downloaded += 1
        except Exception as e:
            print(f"[warn] {key}: {e}")

    print(f"[mirror_brand_logos] {downloaded}/{len(SEEDS)} brand disponibili in public/logos/")

if __name__ == "__main__":
    main()
