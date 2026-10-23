'use strict';

// Limites das capas
const MAX_DIM = 4096;                       // qualquer largura/altura de 1 ate 4096
const GIF_MAX_FRAMES = 200;
const GIF_MAX_TOTAL_PIXELS = 300_000_000;   // largura * altura * quadros (barra GIF "bomba")

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

const MIME = { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg' };

/** Descobre o tipo pelos primeiros bytes (nao confia no Content-Type). */
function detectKind(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.length >= 6) {
    const s = buf.toString('ascii', 0, 6);
    if (s === 'GIF87a' || s === 'GIF89a') return 'gif';
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}

function checkDims(w, h, label) {
  if (w < 1 || h < 1 || w > MAX_DIM || h > MAX_DIM) {
    return `${label} ${w}x${h} nao suportado (max ${MAX_DIM}x${MAX_DIM}).`;
  }
  return null;
}

/** Valida PNG sem decodificar: assinatura, IHDR, tamanho e IEND. */
function validatePng(buf) {
  if (buf.length < 45 || !buf.subarray(0, 8).equals(PNG_SIG)) return 'O arquivo precisa ser um PNG.';
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return 'PNG invalido.';
  if (!buf.subarray(buf.length - 12).equals(PNG_IEND)) return 'PNG corrompido ou incompleto.';
  return checkDims(buf.readUInt32BE(16), buf.readUInt32BE(20), 'PNG');
}

/**
 * Percorre os marcadores do JPG ate o SOF. Aceita so baseline/progressivo (SOF0-2),
 * 1 ou 3 componentes: e o que o ImageIO do Java 8 do client consegue ler.
 * Devolve { width, height } ou { error }.
 */
function parseJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { error: 'O arquivo precisa ser um JPG.' };
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return { error: 'JPG corrompido.' };
    while (pos < buf.length && buf[pos] === 0xff) pos++; // bytes de preenchimento
    const marker = buf[pos++];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    if (pos + 2 > buf.length) break;
    const len = buf.readUInt16BE(pos);
    if (len < 2) return { error: 'JPG corrompido.' };

    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (pos + 8 > buf.length) break;
      const comps = buf[pos + 7];
      if (comps !== 1 && comps !== 3) return { error: 'JPG CMYK nao suportado. Salve como RGB.' };
      return { height: buf.readUInt16BE(pos + 3), width: buf.readUInt16BE(pos + 5) };
    }
    const isOtherSof = (marker >= 0xc3 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isOtherSof) return { error: 'Tipo de JPG nao suportado. Salve como JPG padrao.' };
    pos += len;
  }
  return { error: 'JPG invalido.' };
}

function validateJpg(buf) {
  const r = parseJpeg(buf);
  if (r.error) return r.error;
  if (!buf.subarray(Math.max(0, buf.length - 64)).includes(Buffer.from([0xff, 0xd9]))) {
    return 'JPG corrompido ou incompleto.';
  }
  return checkDims(r.width, r.height, 'JPG');
}

/**
 * Valida GIF percorrendo os blocos (sem decodificar o LZW): cabecalho, dimensoes,
 * quantidade de quadros, total de pixels e trailer.
 */
function validateGif(buf) {
  if (buf.length < 14) return 'GIF invalido.';
  const sig = buf.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return 'O arquivo precisa ser um GIF.';

  const w = buf.readUInt16LE(6);
  const h = buf.readUInt16LE(8);
  const dimErr = checkDims(w, h, 'GIF');
  if (dimErr) return dimErr;

  let pos = 13;
  const packed = buf[10];
  if (packed & 0x80) pos += 3 * (1 << ((packed & 7) + 1)); // tabela de cores global

  const skipSubBlocks = () => {
    for (;;) {
      if (pos >= buf.length) return false;
      const n = buf[pos++];
      if (n === 0) return true;
      pos += n;
    }
  };

  let frames = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    if (b === 0x3b) return frames === 0 ? 'GIF sem quadros.' : null; // trailer
    if (b === 0x21) {
      pos++; // rotulo da extensao
      if (!skipSubBlocks()) return 'GIF corrompido ou incompleto.';
    } else if (b === 0x2c) {
      if (pos + 9 > buf.length) return 'GIF corrompido ou incompleto.';
      const local = buf[pos + 8];
      pos += 9;
      if (local & 0x80) pos += 3 * (1 << ((local & 7) + 1));
      pos++; // codigo LZW minimo
      if (!skipSubBlocks()) return 'GIF corrompido ou incompleto.';
      if (++frames > GIF_MAX_FRAMES) return `GIF com quadros demais (max ${GIF_MAX_FRAMES}).`;
      if (frames * w * h > GIF_MAX_TOTAL_PIXELS) {
        return `GIF pesado demais (${w}x${h} com ${frames}+ quadros). Reduza a resolucao ou os quadros.`;
      }
    } else {
      return 'GIF corrompido.';
    }
  }
  return 'GIF corrompido ou incompleto.';
}

/** Valida PNG, GIF ou JPG. Devolve { kind, error }. */
function validateImage(buf) {
  const kind = detectKind(buf);
  if (!kind) return { kind: null, error: 'Formato nao suportado. Envie PNG, GIF ou JPG.' };
  const error = kind === 'png' ? validatePng(buf) : kind === 'gif' ? validateGif(buf) : validateJpg(buf);
  return { kind, error };
}

/** Largura/altura lidas do cabecalho (o buffer ja foi validado). */
function imageInfo(buf, kind) {
  if (kind === 'gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (kind === 'jpg') {
    const r = parseJpeg(buf);
    return { width: r.width || 0, height: r.height || 0 };
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

module.exports = {
  MIME,
  MAX_DIM,
  GIF_MAX_FRAMES,
  detectKind,
  validatePng,
  validateGif,
  validateJpg,
  validateImage,
  imageInfo,
};