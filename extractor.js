(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FendiExtractor = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HEADERS = [
    '담당자', '수입신고번호', '수리일자', '납세의무자(상호)', '납세의무자번호',
    '해외공급자상호', '최초수입신고번호', '미제출자료', '원본페이지', 'OCR검토필요'
  ];
  const X_BOUNDS = [0, .128, .195, .234, .298, .390, .570, .700, 1.01];
  const FORM_DEFAULTS = { owner: '', taxpayer: '', taxpayerId: '' };

  function setFormDefaults(values) {
    for (const key of Object.keys(FORM_DEFAULTS)) {
      FORM_DEFAULTS[key] = String(values?.[key] || '').trim();
    }
  }

  function normalizeNumeric(value) {
    const map = { O: '0', o: '0', I: '1', l: '1', '|': '1', S: '5', B: '8' };
    return String(value).split('').map(c => map[c] ?? c).join('').toUpperCase().replace(/[^0-9A-Z-]/g, '');
  }

  function cleanCell(value, col) {
    let text = String(value || '').replace(/\s+/g, ' ').replace(/^[ ,.;]+|[ ,.;]+$/g, '');
    if ([1, 2, 4, 6].includes(col)) return normalizeNumeric(text);
    if ([0, 3].includes(col)) text = text.replace(/([가-힣])\s+(?=[가-힣])/g, '$1');
    if (col === 7) {
      text = text.replace(/미\s*제\s*출/g, '미제출').replace(/사\s*유\s*서/g, '사유서');
    }
    return text;
  }

  function editDistance(a, b) {
    const prev = Array.from({length: b.length + 1}, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diagonal = prev[0]; prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const above = prev[j], left = prev[j - 1];
        prev[j] = Math.min(above + 1, left + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = above;
      }
    }
    return prev[b.length];
  }

  function normalizeSupplier(value) {
    const compact = String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (compact && editDistance(compact, 'FENDISRL') <= 2) return 'FENDI SRL';
    return String(value || '').replace(/FENDI\s*S\.?\s*R\.?\s*L\.?/i, 'FENDI SRL').trim();
  }

  function columnIndex(left, width) {
    const x = left / width;
    for (let i = 0; i < 8; i++) if (x >= X_BOUNDS[i] && x < X_BOUNDS[i + 1]) return i;
    return null;
  }

  function parseTsv(tsv, minConfidence = 10) {
    const lines = String(tsv || '').split(/\r?\n/);
    const words = [];
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split('\t');
      if (p.length < 12 || !p.slice(11).join('\t').trim()) continue;
      const confidence = Number(p[10]);
      if (!Number.isFinite(confidence) || confidence < minConfidence) continue;
      words.push({
        left: Number(p[6]), top: Number(p[7]), width: Number(p[8]), height: Number(p[9]),
        confidence, text: p.slice(11).join('\t').trim()
      });
    }
    return words;
  }

  function looksLikeDataRow(cells) {
    return /\d{10,}/.test(cells[1]) && /^20\d{6}$/.test(cells[2]);
  }

  function reviewReasons(cells, confidences) {
    const reasons = [];
    if (!/^\d{13}[A-Z]$/.test(cells[1])) reasons.push('수입신고번호');
    if (!/^20\d{6}$/.test(cells[2])) reasons.push('수리일자');
    if (cells[4] && !/^\d{10,13}$/.test(cells[4])) reasons.push('납세의무자번호');
    if (confidences.some(v => v >= 0 && v < 45)) reasons.push('낮은 OCR 신뢰도');
    return [...new Set(reasons)].join(', ');
  }

  function extractRows(words, pageWidth, pageHeight, pageNumber) {
    const usable = words.filter(w => {
      w.cy = w.top + w.height / 2;
      return w.cy > pageHeight * .045 && w.cy < pageHeight * .91;
    }).sort((a, b) => a.cy - b.cy);
    const tolerance = Math.max(13, Math.floor(pageHeight * .0065));
    const clusters = [];
    for (const word of usable) {
      const last = clusters[clusters.length - 1];
      if (!last || Math.abs(word.cy - last.center) > tolerance) {
        clusters.push({ center: word.cy, words: [word] });
      } else {
        last.words.push(word);
        last.center = last.words.reduce((s, w) => s + w.cy, 0) / last.words.length;
      }
    }
    const rows = [];
    for (const cluster of clusters) {
      const groups = Array.from({ length: 8 }, () => []);
      cluster.words.sort((a, b) => a.left - b.left).forEach(word => {
        const idx = columnIndex(word.left, pageWidth);
        if (idx !== null) groups[idx].push(word);
      });
      const cells = groups.map((g, i) => cleanCell(g.map(w => w.text).join(' '), i));
      if (!looksLikeDataRow(cells)) continue;
      // These three values are invariant in the supplied FENDI Korea form and
      // are too small in print for reliable OCR. Keep OCR for variable fields.
      if (FORM_DEFAULTS.owner) cells[0] = FORM_DEFAULTS.owner;
      if (FORM_DEFAULTS.taxpayer) cells[3] = FORM_DEFAULTS.taxpayer;
      if (FORM_DEFAULTS.taxpayerId) cells[4] = normalizeNumeric(FORM_DEFAULTS.taxpayerId);
      cells[5] = normalizeSupplier(cells[5]);
      const confidences = groups.map(g => g.length ? g.reduce((s, w) => s + w.confidence, 0) / g.length : -1);
      const row = [...cells, pageNumber, reviewReasons(cells, confidences)];
      row._y = cluster.center;
      rows.push(row);
    }
    return rows;
  }

  function extractKeyFields(words, pageHeight) {
    const usable = words.map(w => ({...w, cy: w.top + w.height / 2})).sort((a, b) => a.cy - b.cy);
    const tolerance = Math.max(13, Math.floor(pageHeight * .0065));
    const clusters = [];
    for (const word of usable) {
      const last = clusters[clusters.length - 1];
      if (!last || Math.abs(word.cy - last.center) > tolerance) clusters.push({center: word.cy, words: [word]});
      else {
        last.words.push(word);
        last.center = last.words.reduce((s, w) => s + w.cy, 0) / last.words.length;
      }
    }
    const keys = [];
    for (const cluster of clusters) {
      const text = normalizeNumeric(cluster.words.sort((a,b) => a.left - b.left).map(w => w.text).join(''));
      const declaration = text.match(/\d{13}[A-Z]/)?.[0] || '';
      const date = text.match(/20\d{6}/)?.[0] || '';
      if (declaration && date) keys.push({y: cluster.center, declaration, date});
    }
    return keys;
  }

  function applyKeyFields(rows, keys, pageHeight) {
    const maxDistance = Math.max(14, Math.floor(pageHeight * .007));
    for (const row of rows) {
      let best = null, distance = Infinity;
      for (const key of keys) {
        const d = Math.abs((row._y || 0) - key.y);
        if (d < distance) { best = key; distance = d; }
      }
      if (best && distance <= maxDistance) {
        row[1] = best.declaration;
        row[2] = best.date;
        row[9] = String(row[9] || '').split(', ').filter(x => !['수입신고번호','수리일자'].includes(x)).join(', ');
      }
    }
    return rows;
  }

  return { HEADERS, X_BOUNDS, FORM_DEFAULTS, setFormDefaults, normalizeNumeric, cleanCell, normalizeSupplier, parseTsv, extractRows, extractKeyFields, applyKeyFields, reviewReasons };
});
