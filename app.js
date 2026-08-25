'use strict';

const UI = {};
const STATE = { file: null, rows: [], pages: [] };

document.addEventListener('DOMContentLoaded', () => {
  ['pdfInput','dropZone','runButton','clearButton','fileCard','fileName','fileMeta','progressSection',
   'progressTitle','progressPercent','progressBar','progressDetail','errorBox','resultSection','downloadButton',
   'rowCount','reviewCount','pageCount','tableHeader','tableBody','startPage','endPage'].forEach(id => UI[id] = document.getElementById(id));
  if (!window.pdfjsLib || !window.Tesseract || !window.XLSX) return showError('필수 라이브러리를 불러오지 못했습니다. 인터넷 연결 후 새로고침하세요.');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  UI.pdfInput.addEventListener('change', () => selectFile(UI.pdfInput.files[0]));
  UI.dropZone.addEventListener('dragover', e => { e.preventDefault(); UI.dropZone.classList.add('active'); });
  UI.dropZone.addEventListener('dragleave', () => UI.dropZone.classList.remove('active'));
  UI.dropZone.addEventListener('drop', e => { e.preventDefault(); UI.dropZone.classList.remove('active'); selectFile(e.dataTransfer.files[0]); });
  UI.clearButton.addEventListener('click', clearAll);
  UI.runButton.addEventListener('click', runExtraction);
  UI.downloadButton.addEventListener('click', downloadExcel);
});

function selectFile(file) {
  hideError();
  if (!file || (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf')) return showError('PDF 파일만 선택할 수 있습니다.');
  STATE.file = file;
  UI.fileName.textContent = file.name;
  UI.fileMeta.textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  UI.fileCard.hidden = false;
  UI.runButton.disabled = false;
  UI.resultSection.hidden = true;
}

function clearAll() {
  STATE.file = null; STATE.rows = []; STATE.pages = [];
  UI.pdfInput.value = ''; UI.fileCard.hidden = true; UI.runButton.disabled = true;
  UI.resultSection.hidden = true; UI.progressSection.hidden = true; hideError();
}

async function runExtraction() {
  if (!STATE.file) return;
  hideError(); UI.resultSection.hidden = true; UI.progressSection.hidden = false; UI.runButton.disabled = true;
  let worker;
  try {
    setProgress(1, 'PDF 확인', '페이지 정보를 읽고 있습니다.');
    const data = await STATE.file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const start = Number(UI.startPage.value), end = Number(UI.endPage.value);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > pdf.numPages) {
      throw new Error(`페이지 범위는 1~${pdf.numPages} 사이로 입력하세요.`);
    }
    STATE.pages = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    setProgress(3, 'OCR 준비', '한국어·영어 OCR 모델을 처음 한 번 내려받습니다.');
    worker = await Tesseract.createWorker(['kor', 'eng'], 1, {
      logger: m => {
        const base = 3;
        const pct = Math.min(18, base + Math.round((m.progress || 0) * 15));
        setProgress(pct, 'OCR 준비', `${koreanStatus(m.status)} ${Math.round((m.progress || 0) * 100)}%`);
      },
      // Use the same current tessdata_fast models as the verified desktop build.
      // The default Project Naptha models are older and were materially less
      // accurate on this small Korean customs table.
      langPath: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main',
      gzip: false,
      cacheMethod: 'refresh'
    });
    await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
    const allRows = [];
    for (let i = 0; i < STATE.pages.length; i++) {
      const pageNo = STATE.pages[i];
      const from = 20 + i * (75 / STATE.pages.length);
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale: 4 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: ctx, viewport }).promise;
      preprocessCanvas(ctx, canvas.width, canvas.height);
      setProgress(Math.round(from), `${pageNo}페이지 OCR`, `${i + 1}/${STATE.pages.length}페이지를 읽는 중입니다.`);
      const result = await worker.recognize(canvas, {}, { tsv: true });
      const words = FendiExtractor.parseTsv(result.data.tsv);
      const pageRows = FendiExtractor.extractRows(words, canvas.width, canvas.height, pageNo);

      // Re-read the two critical identifier columns from a narrow crop with an
      // alphanumeric whitelist. Small declaration numbers are substantially
      // more accurate this way than in whole-page mixed Korean OCR.
      const keyCanvas = document.createElement('canvas');
      const keyX = Math.floor(canvas.width * .125);
      keyCanvas.width = Math.ceil(canvas.width * .110);
      keyCanvas.height = canvas.height;
      keyCanvas.getContext('2d').drawImage(canvas, keyX, 0, keyCanvas.width, canvas.height, 0, 0, keyCanvas.width, canvas.height);
      await worker.setParameters({tessedit_char_whitelist:'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'});
      const keyResult = await worker.recognize(keyCanvas, {}, {tsv:true});
      await worker.setParameters({tessedit_char_whitelist:''});
      const keyWords = FendiExtractor.parseTsv(keyResult.data.tsv, 0);
      const keys = FendiExtractor.extractKeyFields(keyWords, keyCanvas.height);
      FendiExtractor.applyKeyFields(pageRows, keys, canvas.height);

      // Re-read each variable column independently. Keeping the original Y
      // coordinate lets us attach every result to its own row without copying
      // a frequent value across unrelated records.
      const columnJobs = [
        {col:0, whitelist:''},
        {col:3, whitelist:''},
        {col:4, whitelist:'0123456789'},
        {col:5, whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&.,()-'},
        {col:6, whitelist:'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-'},
        {col:7, whitelist:''}
      ];
      for (let j = 0; j < columnJobs.length; j++) {
        const job = columnJobs[j];
        const x1 = Math.floor(canvas.width * (job.col === 0 ? .09 : FendiExtractor.X_BOUNDS[job.col]));
        const x2 = Math.ceil(canvas.width * Math.min(1, FendiExtractor.X_BOUNDS[job.col + 1]));
        const {canvas: colCanvas, centers} = buildColumnStrip(canvas, pageRows, x1, x2);
        await worker.setParameters({tessedit_char_whitelist:job.whitelist});
        setProgress(Math.round(from + (j + 1) * (12 / columnJobs.length)), `${pageNo}페이지 열 검증`, `${j + 1}/${columnJobs.length}개 열을 다시 읽는 중입니다.`);
        const colResult = await worker.recognize(colCanvas, {}, {tsv:true});
        FendiExtractor.applyColumnWords(pageRows, FendiExtractor.parseTsv(colResult.data.tsv, 0), colCanvas.height, job.col, centers);
      }
      await worker.setParameters({tessedit_char_whitelist:''});
      allRows.push(...pageRows);
    }
    if (allRows.length < Math.max(1, STATE.pages.length * 5)) throw new Error(`OCR 결과가 비정상적으로 적습니다(${allRows.length}행). 이 PDF가 FENDI 공문 양식인지 확인하세요.`);
    STATE.rows = FendiExtractor.finalizeRows(allRows);
    setProgress(100, '완료', `${STATE.rows.length}개 행을 추출했습니다.`);
    renderResults();
  } catch (err) {
    console.error(err); showError(err?.message || '처리 중 오류가 발생했습니다.');
  } finally {
    if (worker) await worker.terminate();
    UI.runButton.disabled = !STATE.file;
  }
}

function buildColumnStrip(source, rows, x1, x2) {
  const scale = 2;
  const half = Math.max(15, Math.floor(source.height * .0052));
  const padding = 12;
  const slotHeight = half * 2 * scale + padding * 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(80, (x2 - x1) * scale + padding * 2);
  canvas.height = Math.max(slotHeight, rows.length * slotHeight);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  const centers = [];
  rows.forEach((row, i) => {
    const top = Math.max(0, Math.round((row._y || 0) - half));
    const sourceHeight = Math.min(half * 2, source.height - top);
    const destY = i * slotHeight + padding;
    ctx.drawImage(source, x1, top, x2 - x1, sourceHeight, padding, destY, (x2 - x1) * scale, sourceHeight * scale);
    centers.push(destY + sourceHeight * scale / 2);
  });
  return {canvas, centers};
}

function preprocessCanvas(ctx, width, height) {
  const image = ctx.getImageData(0, 0, width, height), d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2];
    const enhanced = Math.max(0, Math.min(255, (gray - 128) * 1.45 + 128));
    d[i] = d[i + 1] = d[i + 2] = enhanced;
  }
  ctx.putImageData(image, 0, 0);
}

function renderResults() {
  const review = STATE.rows.filter(r => r[9]).length;
  UI.rowCount.textContent = STATE.rows.length.toLocaleString('ko-KR');
  UI.reviewCount.textContent = review.toLocaleString('ko-KR');
  UI.pageCount.textContent = STATE.pages.length;
  UI.tableHeader.innerHTML = FendiExtractor.HEADERS.map(h => `<th>${escapeHtml(h)}</th>`).join('');
  UI.tableBody.innerHTML = STATE.rows.slice(0, 250).map(row => `<tr class="${row[9] ? 'review' : ''}">${row.map(v => `<td>${escapeHtml(v ?? '')}</td>`).join('')}</tr>`).join('');
  UI.resultSection.hidden = false;
  UI.resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function downloadExcel() {
  if (!STATE.rows.length) return;
  const wb = XLSX.utils.book_new();
  const data = [FendiExtractor.HEADERS, ...STATE.rows];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [10,21,12,25,18,32,23,42,11,28].map(wch => ({ wch }));
  ws['!autofilter'] = { ref: `A1:J${data.length}` };
  XLSX.utils.book_append_sheet(wb, ws, '추출결과');
  const info = [['항목','내용'],['원본 PDF',STATE.file.name],['추출 페이지',STATE.pages.join(', ')],['추출 행 수',STATE.rows.length],['검토 필요 행 수',STATE.rows.filter(r=>r[9]).length],['주의','OCR검토필요 행은 원본과 대조하세요.']];
  const infoWs = XLSX.utils.aoa_to_sheet(info); infoWs['!cols'] = [{wch:20},{wch:70}];
  XLSX.utils.book_append_sheet(wb, infoWs, '실행정보');
  const stem = STATE.file.name.replace(/\.pdf$/i, '');
  XLSX.writeFile(wb, `${stem}_${STATE.pages[0]}-${STATE.pages.at(-1)}_추출.xlsx`);
}

function setProgress(percent, title, detail) {
  UI.progressBar.style.width = `${percent}%`; UI.progressPercent.textContent = `${percent}%`;
  UI.progressTitle.textContent = title; UI.progressDetail.textContent = detail;
}
function koreanStatus(s) { return ({'loading tesseract core':'OCR 엔진 로딩','initializing tesseract':'OCR 초기화','loading language traineddata':'언어 데이터 로딩','initializing api':'언어 적용','recognizing text':'문자 인식'})[s] || '준비 중'; }
function showError(message) { UI.errorBox.textContent = message; UI.errorBox.hidden = false; }
function hideError() { UI.errorBox.hidden = true; UI.errorBox.textContent = ''; }
function escapeHtml(v) { return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
