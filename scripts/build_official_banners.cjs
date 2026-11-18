const { execSync } = require('child_process');

console.log("Generating mathematically centered, identical-font banners...");

const BG = "#F6F1EB";

// 1. Prepare shared assets:
// Slogans
execSync(`convert -background transparent -font DejaVu-Sans -pointsize 14 -fill "#132A4D" label:"SIMPLY DISCREET" /tmp/slogan1.png`);
execSync(`convert -background transparent -font DejaVu-Sans -pointsize 13 -fill "#132A4D" label:"WHAT YOU HAVE — WHAT YOU WANT" /tmp/slogan2.png`);

// Titles
// Title Have2Want + (pointsize 44)
execSync(`convert -background transparent -font DejaVu-Sans-Bold -pointsize 44 -fill "#C59B27" label:"HAVE 2 " /tmp/h1.png`);
execSync(`convert -background transparent -font DejaVu-Sans-Bold -pointsize 44 -fill "#132A4D" label:"WANT " /tmp/h2.png`);
execSync(`convert -background transparent -font DejaVu-Sans-Bold -pointsize 44 -fill "#E5C158" label:"+" /tmp/h3.png`);
execSync(`convert /tmp/h1.png /tmp/h2.png /tmp/h3.png +append /tmp/title_h2w.png`);

// Title ActionFlow Hub (pointsize 44)
execSync(`convert -background transparent -font DejaVu-Sans-Bold -pointsize 44 -fill "#C59B27" label:"ActionFlow " /tmp/a1.png`);
execSync(`convert -background transparent -font DejaVu-Sans-Bold -pointsize 44 -fill "#132A4D" label:"Hub" /tmp/a2.png`);
execSync(`convert /tmp/a1.png /tmp/a2.png +append /tmp/title_af.png`);

// Watermarks (pointsize 22)
execSync(`convert -background transparent -font DejaVu-Sans-Bold -pointsize 22 -fill "rgba(19,42,77,0.22)" label:"ActionFlow Hub" /tmp/wm_af.png`);
execSync(`convert -background transparent -font DejaVu-Sans-Bold -pointsize 22 -fill "rgba(197,155,39,0.28)" label:"Have2Want +" /tmp/wm_h2w.png`);

// 2. Build Banner 1: Have2Want +
// Base: Original globe + ribbons (y=0 to y=515) on #F6F1EB extended to 1022x670
execSync(`convert public/assets/aistudio/IMG_20261002_004834_2e580032.png -crop 1022x515+0+0 +repage -background "${BG}" -extent 1022x670 /tmp/base_canvas.png`);

execSync(`
composite -gravity south -geometry +0+112 /tmp/title_h2w.png /tmp/base_canvas.png /tmp/step1_h2w.png && \
composite -gravity south -geometry +0+74 /tmp/slogan1.png /tmp/step1_h2w.png /tmp/step2_h2w.png && \
composite -gravity south -geometry +0+48 /tmp/slogan2.png /tmp/step2_h2w.png /tmp/step3_h2w.png && \
composite -gravity south -geometry +0+16 /tmp/wm_af.png /tmp/step3_h2w.png public/have2want_plus_banner.jpg
`);
console.log("Built perfect public/have2want_plus_banner.jpg");

// 3. Build Banner 2: ActionFlow Hub
// Identical base canvas, identical layout coordinates!
execSync(`
composite -gravity south -geometry +0+112 /tmp/title_af.png /tmp/base_canvas.png /tmp/step1_af.png && \
composite -gravity south -geometry +0+74 /tmp/slogan1.png /tmp/step1_af.png /tmp/step2_af.png && \
composite -gravity south -geometry +0+48 /tmp/slogan2.png /tmp/step2_af.png /tmp/step3_af.png && \
composite -gravity south -geometry +0+16 /tmp/wm_h2w.png /tmp/step3_af.png public/actionflow_hub_banner.jpg
`);
console.log("Built perfect public/actionflow_hub_banner.jpg");

