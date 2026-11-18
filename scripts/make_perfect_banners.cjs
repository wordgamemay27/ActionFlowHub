const { execSync } = require('child_process');

const BG = "#F6F1EB";
const GOLD = "#C59B27";
const NAVY = "#132A4D";

// 1. BANNER HAVE2WANT +
// Start from authentic original image (1022x644), extend to 1022x680
execSync(`
convert public/assets/aistudio/IMG_20261002_004834_2e580032.png \
  -background "${BG}" -extent 1022x680 \
  /tmp/base_h2w.png
`);

// Add gold "+" after "HAVE 2 WANT"
execSync(`
convert /tmp/base_h2w.png \
  -font DejaVu-Sans-Bold -pointsize 42 -fill "#E5C158" \
  -draw "text 722,564 '+'" \
  /tmp/h2w_with_plus.png
`);

// Reflection layer for "ActionFlow Hub"
execSync(`
convert -size 460x45 "xc:${BG}" \
  -font DejaVu-Sans-Bold -pointsize 28 \
  -fill "${GOLD}" -draw "text 40,32 'ActionFlow'" \
  -fill "${NAVY}" -draw "text 210,32 'Hub'" \
  -flip \
  /tmp/refl_af_flipped.png
`);

// Alpha fade
execSync(`
convert /tmp/refl_af_flipped.png \
  -alpha set -channel A -sparse-color Barycentric "0,0 #FFFFFF 0,%[h] #000000" \
  /tmp/refl_af_faded.png
`);

// Composite reflection centered under the tagline
execSync(`
composite -geometry +300+626 /tmp/refl_af_faded.png /tmp/h2w_with_plus.png public/have2want_plus_banner.jpg
`);

// 2. BANNER ACTIONFLOW HUB
execSync(`
convert public/assets/aistudio/IMG_20261002_004834_2e580032.png \
  -crop 1022x515+0+0 +repage \
  -background "${BG}" -extent 1022x680 \
  /tmp/base_af_globe.png
`);

// Add "ActionFlow Hub" centered with proper spacing
execSync(`
convert /tmp/base_af_globe.png \
  -font DejaVu-Sans-Bold -pointsize 44 \
  -fill "${GOLD}" -draw "text 315,564 'ActionFlow'" \
  -fill "${NAVY}" -draw "text 605,564 'Hub'" \
  /tmp/af_with_text.png
`);

// Reflection layer for "Have2Want +"
execSync(`
convert -size 460x45 "xc:${BG}" \
  -font DejaVu-Sans-Bold -pointsize 28 \
  -fill "${GOLD}" -draw "text 50,32 'Have2'" \
  -fill "${NAVY}" -draw "text 145,32 'Want'" \
  -fill "#E5C158" -draw "text 230,32 '+'" \
  -flip \
  /tmp/refl_h2w_flipped.png
`);

// Alpha fade
execSync(`
convert /tmp/refl_h2w_flipped.png \
  -alpha set -channel A -sparse-color Barycentric "0,0 #FFFFFF 0,%[h] #000000" \
  /tmp/refl_h2w_faded.png
`);

// Composite reflection directly under "ActionFlow Hub"
execSync(`
composite -geometry +330+576 /tmp/refl_h2w_faded.png /tmp/af_with_text.png public/actionflow_hub_banner.jpg
`);

console.log("Both banners generated cleanly.");
