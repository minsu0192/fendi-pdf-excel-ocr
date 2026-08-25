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

  function normalizeNumeric(value) {
    const map = { O: '0', o: '0', I: '1', l: '1', '|': '1', S: '5', B: '8' };
    return String(value).split('').map(c => map[c] ?? c).join('').toUpperCase().replace(/[^0-9A-Z-]/g, '');
  }

  function cleanCell(value, col) {
    let text = String(value || '').replace(/\s+/g, ' ').replace(/^[ ,.;]+|[ ,.;]+$/g, '');
    if ([1, 2, 4, 6].includes(col)) return normalizeNumeric(text);
    if ([0, 3].includes(col)) text = text.replace(/([가-힣])\s+(?=[가-힣])/g, '$1');
    if (col === 3) text = text.replace(/[\[{]/g, '(').replace(/[\]}|]/g, ')').replace(/\s*([()])\s*/g, '$1');
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

  function isValidBusinessNumber(value) {
    const text = String(value || '').replace(/\D/g, '');
    if (!/^\d{10}$/.test(text)) return false;
    const d = [...text].map(Number), weights = [1,3,7,1,3,7,1,3,5];
    const sum = d.slice(0,9).reduce((s,v,i) => s + v * weights[i], 0) + Math.floor(d[8] * 5 / 10);
    return (10 - sum % 10) % 10 === d[9];
  }

  function recoverBusinessNumber(value, current = '') {
    const digits = String(value || '').replace(/\D/g, '');
    const candidates = [];
    if (digits.length === 10 && isValidBusinessNumber(digits)) candidates.push(digits);
    if (digits.length === 11) {
      for (let i = 0; i < digits.length; i++) {
        const candidate = digits.slice(0,i) + digits.slice(i+1);
        if (isValidBusinessNumber(candidate)) candidates.push(candidate);
      }
    }
    const unique = [...new Set(candidates)];
    return unique.sort((a,b) => editDistance(a, String(current || '')) - editDistance(b, String(current || '')))[0] || '';
  }

  function reviewReasons(cells, confidences) {
    const reasons = [];
    if (!/[가-힣]{2,}/.test(cells[0] || '')) reasons.push('담당자');
    if (!/^\d{13}[A-Z]$/.test(cells[1])) reasons.push('수입신고번호');
    if (!/^20\d{6}$/.test(cells[2])) reasons.push('수리일자');
    if (!/[가-힣]{2,}/.test(cells[3] || '')) reasons.push('납세의무자');
    if (!isValidBusinessNumber(cells[4])) reasons.push('납세의무자번호');
    if (!/[A-Za-z가-힣]{3,}/.test(cells[5] || '')) reasons.push('해외공급자');
    if (!/[가-힣A-Za-z]{3,}/.test(cells[7] || '')) reasons.push('미제출자료');
    if ([1, 2, 4].some(i => confidences[i] >= 0 && confidences[i] < 35)) reasons.push('핵심값 낮은 신뢰도');
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
      cells[5] = normalizeSupplier(cells[5]);
      const confidences = groups.map(g => g.length ? g.reduce((s, w) => s + w.confidence, 0) / g.length : -1);
      const row = [...cells, pageNumber, reviewReasons(cells, confidences)];
      row._y = cluster.center;
      row._confidences = confidences;
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
        row._confidences[1] = Math.max(row._confidences[1], 70);
        row._confidences[2] = Math.max(row._confidences[2], 70);
      }
    }
    return rows;
  }

  function applyColumnWords(rows, words, imageHeight, col, rowCenters = null) {
    const maxDistance = rowCenters ? Math.max(18, Math.floor(imageHeight / Math.max(1, rows.length) * .38)) : Math.max(15, Math.floor(imageHeight * .007));
    const buckets = rows.map(() => []);
    for (const word of words) {
      const cy = word.top + word.height / 2;
      let best = -1, distance = Infinity;
      for (let i = 0; i < rows.length; i++) {
        const targetY = rowCenters ? rowCenters[i] : (rows[i]._y || 0);
        const d = Math.abs(targetY - cy);
        if (d < distance) { best = i; distance = d; }
      }
      if (best >= 0 && distance <= maxDistance) buckets[best].push(word);
    }
    for (let i = 0; i < rows.length; i++) {
      const bucket = buckets[i].sort((a,b) => a.left - b.left);
      if (!bucket.length) continue;
      let value = cleanCell(bucket.map(w => w.text).join(' '), col);
      if (col === 5) value = normalizeSupplier(value);
      const confidence = bucket.reduce((s,w) => s + w.confidence, 0) / bucket.length;
      rows[i]._columnCandidates = rows[i]._columnCandidates || {};
      rows[i]._columnCandidates[col] = {value, confidence};
      if (col === 4) value = recoverBusinessNumber(value, rows[i][4]) || value;
      const plausible = col === 0 ? /[가-힣A-Za-z]{2,}/.test(value)
        : col === 3 ? /[가-힣A-Za-z]{2,}/.test(value)
        : col === 4 ? isValidBusinessNumber(value)
        : col === 5 ? /[A-Za-z가-힣]{3,}/.test(value)
        : col === 6 ? !value || /^\d{13}[A-Z]?-?$/.test(value)
        : col === 7 ? /[가-힣A-Za-z]{3,}/.test(value)
        : Boolean(value);
      const current = String(rows[i][col] || '');
      const currentPlausible = col === 0 ? /[가-힣A-Za-z]{2,}/.test(current)
        : col === 3 ? /[가-힣A-Za-z]{2,}/.test(current)
        : col === 4 ? isValidBusinessNumber(current)
        : col === 5 ? /[A-Za-z가-힣]{3,}/.test(current)
        : col === 6 ? !current || /^\d{13}[A-Z]?-?$/.test(current)
        : col === 7 ? /[가-힣A-Za-z]{3,}/.test(current)
        : Boolean(current);
      // Short Korean names and ten-digit IDs are especially vulnerable to a
      // one-character regression in isolated-column OCR. Use the second pass
      // only to fill an implausible/missing value for those fields. Longer
      // supplier and description fields benefit from the isolated crop.
      const currentConfidence = rows[i]._confidences[col] || 0;
      const replace = col === 0
        ? (!currentPlausible || (/[가-힣]{2,}/.test(value) && (!/[가-힣]{2,}/.test(current) || confidence >= currentConfidence + 8)))
        : col === 3
        ? (!currentPlausible || (/[가-힣]{2,}/.test(value) && !/[가-힣]{2,}/.test(current)) || (value.length >= current.length + 2 && confidence >= currentConfidence - 8))
        : col === 4
        ? (!currentPlausible && plausible)
        : (!currentPlausible || confidence >= (rows[i]._confidences[col] || 0) - 5);
      if (plausible && replace && (confidence >= 20 || !current)) {
        rows[i][col] = value;
        rows[i]._confidences[col] = confidence;
      }
    }
    return rows;
  }

  function finalizeRows(rows) {
    for (const page of new Set(rows.map(r => r[8]))) {
      const pageRows = rows.filter(r => r[8] === page);
      applyLocalConsensus(pageRows, 0, 1);
      applyLocalConsensus(pageRows, 3, 2);
      applyBusinessConsensus(pageRows);
    }
    for (const row of rows) {
      row[9] = [reviewReasons(row, row._confidences || []), ...(row._consensusReview || [])].filter(Boolean).join(', ');
    }
    const bestByKey = new Map();
    for (const row of rows) {
      const key = `${row[8]}|${row[1]}|${row[2]}`;
      const score = row.slice(0, 8).filter(Boolean).length * 100 + (row._confidences || []).reduce((s,v) => s + Math.max(0,v), 0);
      if (!bestByKey.has(key) || score > bestByKey.get(key).score) bestByKey.set(key, {row, score});
    }
    return [...bestByKey.values()].map(x => x.row);
  }

  function applyLocalConsensus(rows, col, maxEdits) {
    const compact = value => String(value || '').replace(/[^0-9A-Za-z가-힣]/g, '').toUpperCase();
    const votes = new Map();
    for (const row of rows) {
      for (const value of [row[col], row._columnCandidates?.[col]?.value]) {
        const key = compact(value);
        if (key.length >= 2) votes.set(key, {value: cleanCell(value, col), count: (votes.get(key)?.count || 0) + 1});
      }
    }
    const winner = [...votes.values()].sort((a,b) => b.count - a.count)[0];
    if (!winner || winner.count < Math.max(5, rows.length * .35)) return;
    const winnerKey = compact(winner.value);
    for (const row of rows) {
      const currentKey = compact(row[col]);
      const distance = editDistance(currentKey, winnerKey);
      const confidence = row._confidences?.[col] || 0;
      if (currentKey === winnerKey && cleanCell(row[col], col) !== winner.value) {
        row[col] = winner.value;
      } else if (currentKey !== winnerKey && distance <= maxEdits) {
        row[col] = winner.value;
        if (row._confidences) row._confidences[col] = Math.max(confidence, 80);
      } else if (currentKey !== winnerKey && distance <= maxEdits + 2) {
        row._consensusReview = row._consensusReview || [];
        row._consensusReview.push(`${HEADERS[col]} OCR 불일치`);
      }
    }
  }

  function applyBusinessConsensus(rows) {
    const valid = rows.map(r => String(r[4] || '')).filter(isValidBusinessNumber);
    const counts = valid.reduce((m,v) => (m.set(v,(m.get(v)||0)+1),m), new Map());
    const winner = [...counts.entries()].sort((a,b) => b[1]-a[1])[0];
    if (!winner || winner[1] < Math.max(5, rows.length * .35)) return;
    for (const row of rows) {
      const current = String(row[4] || '');
      if (!isValidBusinessNumber(current) && editDistance(current, winner[0]) <= 2) {
        row[4] = winner[0];
        if (row._confidences) row._confidences[4] = Math.max(row._confidences[4] || 0, 80);
      }
    }
  }

  return { HEADERS, X_BOUNDS, normalizeNumeric, cleanCell, normalizeSupplier, isValidBusinessNumber, recoverBusinessNumber, parseTsv, extractRows, extractKeyFields, applyKeyFields, applyColumnWords, finalizeRows, reviewReasons };
});
