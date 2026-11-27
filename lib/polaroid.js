// Renders an order's photo as a polaroid image for the payment mail (mail clients can't do CSS filters).
// Same film look (order nr % 8) and the same handwriting (by name) as the note on the order page.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const woffToSfnt = require('./woff2ttf');

const FONT_SRC = path.join(__dirname, '..', 'node_modules', '@fontsource');
const FONT_DIR = path.join(os.tmpdir(), 'sammat-fonts');
// [family, package, name weight, text weight, size factor] – mirrors .hand0–3 in style.css
const HANDS = [
  ['Caveat', 'caveat', 700, 400, 1.32],
  ['Kalam', 'kalam', 700, 400, 1],
  ['Patrick Hand', 'patrick-hand', 400, 400, 1.12],
  ['Architects Daughter', 'architects-daughter', 400, 400, 0.98]
];
const fontCache = new Map();
function fontFile(pkg, weight) {
  const key = `${pkg}-${weight}`;
  if (fontCache.has(key)) return fontCache.get(key);
  fs.mkdirSync(FONT_DIR, { recursive: true });
  const out = path.join(FONT_DIR, `${key}.ttf`);
  if (!fs.existsSync(out)) {
    const woff = fs.readFileSync(path.join(FONT_SRC, pkg, 'files', `${pkg}-latin-${weight}-normal.woff`));
    fs.writeFileSync(out, woffToSfnt(woff));
  }
  fontCache.set(key, out);
  return out;
}

const handOf = (name) => {
  let h = 0;
  for (const ch of String(name).trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 4;
};
const escXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

const S = 432; // photo size
const sepia = (a) => {
  const m = [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]];
  return m.map((row, i) => row.map((v, j) => (1 - a) * (i === j ? 1 : 0) + a * v));
};
const GRAY = [[0.299, 0.587, 0.114], [0.299, 0.587, 0.114], [0.299, 0.587, 0.114]];
const svg = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><defs>${body.defs || ''}</defs>${body.shapes}</svg>`);
const vignette = (op, color = '0,0,0', inner = 0.5) => svg({
  defs: `<radialGradient id="v" cx="50%" cy="50%" r="72%"><stop offset="${inner}" stop-color="rgb(${color})" stop-opacity="0"/><stop offset="1" stop-color="rgb(${color})" stop-opacity="${op}"/></radialGradient>`,
  shapes: '<rect width="100%" height="100%" fill="url(#v)"/>'
});
const wash = (rgba) => svg({ shapes: `<rect width="100%" height="100%" fill="rgba(${rgba})"/>` });
const leak = (cx, cy, rgba, r = '45%') => svg({
  defs: `<radialGradient id="l" cx="${cx}" cy="${cy}" r="${r}"><stop offset="0" stop-color="rgb(${rgba.slice(0, 3).join(',')})" stop-opacity="${rgba[3]}"/><stop offset="1" stop-color="rgb(${rgba.slice(0, 3).join(',')})" stop-opacity="0"/></radialGradient>`,
  shapes: '<rect width="100%" height="100%" fill="url(#l)"/>'
});
const scratches = svg({ shapes: `<g stroke="white" stroke-opacity=".5" fill="none"><path d="M60 0 L66 ${S}" stroke-width="1.2"/><path d="M260 0 Q255 200 270 ${S}" stroke-width=".8"/><path d="M360 40 L364 260" stroke-width="1"/><path d="M20 300 Q150 285 240 320" stroke-width=".7"/></g><g fill="white" fill-opacity=".7"><circle cx="40" cy="70" r="2"/><circle cx="200" cy="40" r="1.4"/><circle cx="310" cy="150" r="2.4"/><circle cx="130" cy="240" r="1.5"/><circle cx="260" cy="300" r="1.8"/></g>` });
const letterbox = svg({ shapes: `<rect width="${S}" height="${Math.round(S * 0.09)}" fill="#000"/><rect y="${Math.round(S * 0.91)}" width="${S}" height="${Math.round(S * 0.09)}" fill="#000"/>` });

// Each look: colour operations on the photo, then overlays [svg, blend]
const LOOKS = [
  { sepia: 0.28, mod: { saturation: 0.78, brightness: 1.04, hue: -6 }, contrast: 1.08, frame: '#fbf8ef',
    over: [[leak('18%', '12%', [255, 196, 120, 0.4]), 'screen'], [vignette(0.45, '40,20,0', 0.52), 'multiply']] },
  { sepia: 0.6, mod: { saturation: 0.55, brightness: 1.02 }, contrast: 1.12, frame: '#f3ead6',
    over: [[wash('255,215,150,.2'), 'soft-light'], [vignette(0.6, '50,25,0', 0.45), 'multiply'], [scratches, 'screen']] },
  { mod: { saturation: 1.25, brightness: 1.05, hue: 8 }, contrast: 1.15, frame: '#fbf8ef',
    over: [[wash('80,200,220,.12'), 'soft-light'], [leak('85%', '85%', [255, 90, 140, 0.3], '50%'), 'screen'], [vignette(0.45, '0,30,50', 0.55), 'multiply']] },
  { gray: true, contrast: 1.25, mod: { brightness: 1.05 }, frame: '#fbf8ef', grain: 0.22,
    over: [[vignette(0.5, '0,0,0', 0.5), 'multiply']] },
  { mod: { saturation: 0.7, brightness: 1.1, hue: -18 }, contrast: 0.92, frame: '#f7f1e1',
    over: [[wash('40,110,70,.22'), 'soft-light'], [vignette(0.35, '20,40,20', 0.6), 'multiply']] },
  { mod: { saturation: 1.5, brightness: 0.98 }, contrast: 1.3, frame: '#f7f1e1',
    over: [[leak('0%', '50%', [255, 110, 30, 0.55], '40%'), 'screen'], [vignette(0.7, '0,0,0', 0.35), 'multiply']] },
  { mod: { saturation: 0.6, brightness: 1.12 }, contrast: 0.85, blur: 0.6, frame: '#eef0f2',
    over: [[wash('150,175,210,.25'), 'screen']] },
  { sepia: 0.15, mod: { saturation: 1.1 }, contrast: 1.2, frame: '#fbf8ef',
    over: [[wash('0,120,140,.18'), 'soft-light'], [leak('100%', '100%', [255, 140, 40, 0.3], '70%'), 'screen'], [scratches, 'screen'], [letterbox, 'over']] }
];

async function photoWithLook(file, look) {
  let p = sharp(file).rotate().resize(S, S, { fit: 'cover' }).removeAlpha();
  if (look.gray) p = p.recomb(GRAY);
  else if (look.sepia) p = p.recomb(sepia(look.sepia));
  if (look.mod) p = p.modulate(look.mod);
  if (look.contrast) p = p.linear(look.contrast, 128 * (1 - look.contrast));
  if (look.blur) p = p.blur(look.blur);
  const base = await p.toBuffer();
  const noise = await sharp({ create: { width: S, height: S, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
    .ensureAlpha(look.grain || 0.1).png().toBuffer();
  return sharp(base).composite([...look.over.map(([input, blend]) => ({ input, blend })), { input: noise, blend: 'overlay' }]).toBuffer();
}

async function text(str, family, pkg, weight, sizePx, width, align) {
  const { data, info } = await sharp({
    text: { text: `<span foreground="#2b2b2b">${escXml(str)}</span>`, font: `${family} ${weight >= 700 ? 'Bold ' : ''}${sizePx}`,
      fontfile: fontFile(pkg, weight), rgba: true, dpi: 72, width, align, wrap: 'word' }
  }).png().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

// Returns a JPEG buffer, or null if anything goes wrong (the mail is sent without it)
async function renderPolaroid({ file, nr, name, item }) {
  try {
    const look = LOOKS[nr % 8];
    const [family, pkg, wName, wText, k] = HANDS[handOf(name)];
    const photo = await photoWithLook(file, look);
    const W = 480, pad = 24;
    const nameImg = await text(name, family, pkg, wName, Math.round(34 * k), W - 2 * pad, 'centre');
    const itemImg = await text(item, family, pkg, wText, Math.round(24 * k), W - 2 * pad - 8, 'left');
    const H = pad + S + 14 + nameImg.h + 4 + Math.min(itemImg.h, 130) + 26;
    const card = await sharp({ create: { width: W, height: H, channels: 3, background: look.frame } })
      .composite([
        { input: photo, top: pad, left: pad },
        { input: nameImg.data, top: pad + S + 14, left: Math.round((W - nameImg.w) / 2) },
        { input: await sharp(itemImg.data).extract({ left: 0, top: 0, width: itemImg.w, height: Math.min(itemImg.h, 130) }).toBuffer(), top: pad + S + 18 + nameImg.h, left: pad + 4 }
      ]).png().toBuffer();
    // Tilt it a little and drop it on white with a soft shadow
    const angle = ((nr * 37) % 11) - 5 > 0 ? 2 : -2;
    const tilted = await sharp(card).rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer({ resolveWithObject: true });
    const tw = tilted.info.width, th = tilted.info.height, m = 30;
    const shadow = await sharp(tilted.data).ensureAlpha().linear([0, 0, 0, 0.35], [0, 0, 0, 0]).blur(9).png().toBuffer();
    return await sharp({ create: { width: tw + 2 * m, height: th + 2 * m, channels: 3, background: '#ffffff' } })
      .composite([{ input: shadow, top: m + 8, left: m + 5 }, { input: tilted.data, top: m, left: m }])
      .jpeg({ quality: 84, mozjpeg: true }).toBuffer();
  } catch (e) {
    console.error('Polaroid:', e.message);
    return null;
  }
}

module.exports = { renderPolaroid, handOf };
