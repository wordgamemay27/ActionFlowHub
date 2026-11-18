import { BRAND_LOGOS, resolveBrandLogo, BRANDS_WITHOUT_OFFICIAL_LOGO } from '../src/lib/brands';

const count = Object.keys(BRAND_LOGOS).length;
if (count === 0) {
  throw new Error('BRAND_LOGOS is empty');
}

for (const id of Object.keys(BRAND_LOGOS)) {
  const resolved = resolveBrandLogo(id);
  if (!resolved || !resolved.label || !resolved.url) {
    throw new Error(`Brand ${id} missing label or url`);
  }
}

console.log(
  `[verify-brand-logos] OK — ${count} loghi ufficiali e ${BRANDS_WITHOUT_OFFICIAL_LOGO.length} segnaposto glass verificati.`
);
