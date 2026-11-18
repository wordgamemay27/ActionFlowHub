const { execSync } = require('child_process');

console.log("Fine-tuning exact typography kerning & alignments...");

// Crop authentic globe and ribbons: 678x410+162+83
execSync(`convert public/assets/aistudio/IMG_20261002_004834_2e580032.png -crop 678x410+162+83 +repage /tmp/globe_authentic.png`);

// BANNER 1: Have2Want + (App Principale)
// In alto: Have2Want +
// Riflesso: ActionFlow Hub
execSync(`
convert -size 1440x810 "xc:#F6F1EB" \
  /tmp/globe_authentic.png -geometry +381+180 -composite \
  -font DejaVu-Sans-Bold -pointsize 66 -fill "#C59B27" -draw "text 450,118 'Have2'" \
  -font DejaVu-Sans-Bold -pointsize 66 -fill "#132A4D" -draw "text 680,118 'Want'" \
  -font DejaVu-Sans-Bold -pointsize 84 -fill "#E5C158" -draw "text 885,123 '+'" \
  -font DejaVu-Sans -pointsize 17 -fill "#132A4D" -draw "text 430,154 'SIMPLY DISCREET — WHAT YOU HAVE — WHAT YOU WANT'" \
  -stroke "#C59B27" -strokewidth 2 -draw "line 150,600 1290,600" \
  -fill "#EAE2D5" -stroke none -draw "rectangle 0,602 1440,810" \
  -stroke "rgba(255,255,255,0.75)" -strokewidth 1.5 -draw "line 200,622 1240,622" \
  -stroke "rgba(255,255,255,0.5)" -strokewidth 1.2 -draw "line 300,646 1140,646" \
  -stroke "rgba(255,255,255,0.35)" -strokewidth 1 -draw "line 400,672 1040,672" \
  -font DejaVu-Sans-Bold -pointsize 46 -fill "rgba(197,155,39,0.85)" -stroke none -draw "text 440,705 'ActionFlow'" \
  -font DejaVu-Sans-Bold -pointsize 46 -fill "rgba(19,42,77,0.85)" -stroke none -draw "text 830,705 'Hub'" \
  -font DejaVu-Sans -pointsize 15 -fill "rgba(157,102,34,0.7)" -stroke none -draw "text 445,742 'AUTONOMOUS DIGITAL PERFORMANCE ENGINE'" \
  public/have2want_plus_banner.jpg
`);

// BANNER 2: ActionFlow Hub
// In alto: ActionFlow Hub
// Riflesso: Have2Want +
execSync(`
convert -size 1440x810 "xc:#F6F1EB" \
  /tmp/globe_authentic.png -geometry +381+180 -composite \
  -font DejaVu-Sans-Bold -pointsize 66 -fill "#C59B27" -draw "text 400,118 'ActionFlow'" \
  -font DejaVu-Sans-Bold -pointsize 66 -fill "#132A4D" -draw "text 835,118 'Hub'" \
  -font DejaVu-Sans -pointsize 17 -fill "#9D6622" -draw "text 460,154 'AUTONOMOUS DIGITAL PERFORMANCE ENGINE'" \
  -stroke "#C59B27" -strokewidth 2 -draw "line 150,600 1290,600" \
  -fill "#EAE2D5" -stroke none -draw "rectangle 0,602 1440,810" \
  -stroke "rgba(255,255,255,0.75)" -strokewidth 1.5 -draw "line 200,622 1240,622" \
  -stroke "rgba(255,255,255,0.5)" -strokewidth 1.2 -draw "line 300,646 1140,646" \
  -stroke "rgba(255,255,255,0.35)" -strokewidth 1 -draw "line 400,672 1040,672" \
  -font DejaVu-Sans-Bold -pointsize 46 -fill "rgba(197,155,39,0.85)" -stroke none -draw "text 475,705 'Have2'" \
  -font DejaVu-Sans-Bold -pointsize 46 -fill "rgba(19,42,77,0.85)" -stroke none -draw "text 640,705 'Want'" \
  -font DejaVu-Sans-Bold -pointsize 60 -fill "rgba(235,190,50,0.98)" -stroke none -draw "text 790,708 '+'" \
  -font DejaVu-Sans -pointsize 15 -fill "rgba(19,42,77,0.7)" -stroke none -draw "text 430,742 'SIMPLY DISCREET — WHAT YOU HAVE — WHAT YOU WANT'" \
  public/actionflow_hub_banner.jpg
`);

console.log("Fine-tuning completed successfully.");
