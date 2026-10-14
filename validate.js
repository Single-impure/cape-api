'use strict';

// Limites das capas
const PNG_MAX_W = 2048; // ate 2048x1024 (sempre 2:1, largura multipla de 64)
const GIF_MAX_DIM = 480; // ate 480x480
const GIF_MAX_FRAMES = 100; // 480x480x4 = ~0,9 MB por quadro decodificado no client

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

const MIME = { png: 'image/png', gif: 'image/gif' };

/** Descobre o tipo pelos primeiros bytes (nao confia no Content-Type). */
function detectKind(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.length >= 6) {
    const s = buf.toString('ascii', 0, 6);
    if (s === 'GIF87a' || s === 'GIF89a') return 'gif';
  }
  return null;
}

/** Valida PNG sem decodificar: assinatura, IHDR, proporcao 2:1 (64x32 ... 2048x1024) e IEND. */
function validatePng(buf) {
  if (buf.length < 45 || !buf.subarray(0, 8).equals(PNG_SIG)) return 'O arquivo precisa ser um PNG.';
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return 'PNG invalido.';
  if (!buf.subarray(buf.length - 12).equals(PNG_IEND)) return 'PNG corrompido ou incompleto.';
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w < 64 || w > PNG_MAX_W || w % 64 !== 0 || h !== w / 2) {
    return `Tamanho ${w}x${h} nao suportado. Use 64x32 (ou 128x64, 256x128, ... ate ${PNG_MAX_W}x${PNG_MAX_W / 2}).`;
  }
  return null;
}

/**
 * Valida GIF percorrendo os blocos (sem decodificar o LZW): cabecalho, dimensoes,
 * quantidade de quadros e trailer. Barra GIFs truncados e "bombas" de quadros.
 */
function validateGif(buf) {
  if (buf.length < 14) return 'GIF invalido.';
  const sig = buf.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return 'O arquivo precisa ser um GIF.';

  const w = buf.readUInt16LE(6);
  const h = buf.readUInt16LE(8);
  if (w < 1 || h < 1 || w > GIF_MAX_DIM || h > GIF_MAX_DIM) {
    return `GIF ${w}x${h} nao suportado (max ${GIF_MAX_DIM}x${GIF_MAX_DIM}).`;
  }

  let pos = 13;
  const packed = buf[10];
  if (packed & 0x80) pos += 3 * (1 << ((packed & 7) + 1)); // tabela de cores global

  // pula uma sequencia de sub-blocos ate o terminador (tamanho 0)
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
    if (b === 0x3b) {
      // trailer
      return frames === 0 ? 'GIF sem quadros.' : null;
    }
    if (b === 0x21) {
      // extensao (GCE, comentario, aplicacao...): rotulo + sub-blocos
      pos++;
      if (!skipSubBlocks()) return 'GIF corrompido ou incompleto.';
    } else if (b === 0x2c) {
      // descritor de imagem: 9 bytes (+ tabela local) + codigo LZW minimo + sub-blocos
      if (pos + 9 > buf.length) return 'GIF corrompido ou incompleto.';
      const local = buf[pos + 8];
      pos += 9;
      if (local & 0x80) pos += 3 * (1 << ((local & 7) + 1));
      pos++;
      if (!skipSubBlocks()) return 'GIF corrompido ou incompleto.';
      if (++frames > GIF_MAX_FRAMES) return `GIF com quadros demais (max ${GIF_MAX_FRAMES}).`;
    } else {
      return 'GIF corrompido.';
    }
  }
  return 'GIF corrompido ou incompleto.';
}

/** Valida PNG ou GIF. Devolve { kind, error }. */
function validateImage(buf) {
  const kind = detectKind(buf);
  if (!kind) return { kind: null, error: 'Formato nao suportado. Envie um PNG ou GIF.' };
  return { kind, error: kind === 'png' ? validatePng(buf) : validateGif(buf) };
}

/** Largura/altura lidas do cabecalho (o buffer ja foi validado). */
function imageInfo(buf, kind) {
  return kind === 'gif'
    ? { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    : { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

module.exports = {
  MIME,
  PNG_MAX_W,
  GIF_MAX_DIM,
  GIF_MAX_FRAMES,
  detectKind,
  validatePng,
  validateGif,
  validateImage,
  imageInfo,
};