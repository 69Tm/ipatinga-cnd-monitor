'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const H = require('./helpers');

const URL = 'https://ipatinga.meumunicipio.online/tributario/servlet/hwpcgeracertidaonegativa';
const ROOT = __dirname;
const REPORT = path.join(ROOT, 'report');
const DEBUG = path.join(ROOT, 'debug');
const OUTPUT = path.join(ROOT, 'output');
const VIDEOS = path.join(DEBUG, 'videos');

const args = new Set(process.argv.slice(2));
const GATE_ONLY = args.has('--gate-only');
const TEST_ALERT = args.has('--test-alert') || process.env.TEST_ALERT === 'true';
const FORCE = process.env.FORCE_RUN === 'true';
const DRY = process.env.DRY_RUN === 'true';
const HEADLESS = process.env.HEADLESS !== 'false';
const CNPJ = process.env.DEXMED_CNPJ;

if (!CNPJ) throw new Error('Secret ausente: DEXMED_CNPJ');

function reportBase() {
  return {
    timestamp: new Date().toISOString(),
    status: 'RUNNING',
    mode: GATE_ONLY ? 'GATE_ONLY' : TEST_ALERT ? 'TEST_ALERT' : DRY ? 'DRY_RUN' : FORCE ? 'FORCE_RUN' : 'SCHEDULED',
    cnpj: H.digits(CNPJ),
    shouldRun: false,
    reason: '',
    currentValidity: null,
    imageRecognized: false,
    searchOk: false,
    generated: false,
    pdfValidated: false,
    driveUrl: null,
    alerts: { bark: 'não executado', email: 'não executado' },
    newCertificate: null,
    error: null
  };
}

async function debug(page, name) {
  H.ensureDir(DEBUG);
  await page.screenshot({ path: path.join(DEBUG, `${name}.png`), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(DEBUG, `${name}.html`), await page.content().catch(() => ''));
}

async function latestNegative(page) {
  const rows = page.locator('#GridcertidaoContainerTbl tbody tr, #GridcertidaoContainerTbl tr[id^="GridcertidaoContainerRow_"]');
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const r = rows.nth(i);
    const type = H.normaliza(await r.locator('[id^="span_vGRIDCERNEGTIPO_"]').first().textContent().catch(() => ''));
    if (type !== 'negativa') continue;
    const t = async sel => (await r.locator(sel).first().textContent().catch(() => '')).trim();
    const numero = await t('[id^="span_vGRIDCERNEGNUMERO_"]');
    const exercicio = await t('[id^="span_vGRIDCERNEGEXERCICIO_"]');
    const emissao = await t('[id^="span_vGRIDCERNEGEMISSAO_"]');
    const validade = await t('[id^="span_vGRIDCERNEGVALIDADE_"]');
    const printEl = r.locator('[id^="vGRIDIMPRIMIR_"]').first();
    const printerId = await printEl.getAttribute('id').catch(() => null);
    return { numero, exercicio, emissao, validade, printerId, fingerprint: `${numero}/${exercicio}|${emissao}|${validade}` };
  }
  return null;
}

async function generate(page, context, before) {
  console.log('Acionando botão de emissão (#vGRIDGERAR_0001)...');
  const pop = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
  await page.locator('#vGRIDGERAR_0001, [id^="vGRIDGERAR_"]').first().click({ force: true, timeout: 5000 });
  
  const popup = await pop;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
    const isPrintPage = popup.url().includes('hwcertidao') || await popup.locator('body').textContent().then(t => t.includes('CERTIDÃO') || t.includes('DEXMED')).catch(() => false);
    if (!isPrintPage) {
      const close = popup.locator('input[value*="Fechar" i], button:has-text("Fechar")').first();
      if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
      else await popup.close().catch(() => {});
    }
  }

  const closeSame = page.locator('input[value*="Fechar" i], button:has-text("Fechar")').first();
  if (await closeSame.isVisible().catch(() => false)) await closeSame.click().catch(() => {});

  await page.waitForTimeout(2000);

  const current = await latestNegative(page);
  if (!current) {
    await debug(page, 'post-generate-no-row');
    throw new Error('Nenhuma certidão negativa encontrada no histórico após acionar emissão.');
  }

  console.log('Certidão negativa identificada:', current);
  return current;
}

async function printPdf(page, context, latest) {
  console.log(`Clicando no botão de impressão (#${latest.printerId || 'vGRIDIMPRIMIR_0001'})...`);
  H.ensureDir(OUTPUT);
  const provisional = path.join(OUTPUT, 'cnd-municipal-ipatinga.pdf');
  const popupP = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
  const downP = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);

  const printLocator = latest.printerId ? page.locator(`#${latest.printerId}`) : page.locator('[id^="vGRIDIMPRIMIR_"]').first();
  await printLocator.click({ force: true, timeout: 5000 });

  const [popup, download] = await Promise.all([popupP, downP]);
  if (download) {
    console.log('Download direto capturado.');
    await download.saveAs(provisional);
    return provisional;
  }
  if (popup) {
    console.log(`Popup de impressão capturado: ${popup.url()}`);
    await popup.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await popup.waitForTimeout(1500);
    await popup.pdf({ path: provisional, format: 'A4', printBackground: true, preferCSSPageSize: true });
    await popup.close().catch(() => {});
    return provisional;
  }
  if (page.url().includes('hwcertidaoimpressao') || page.url().includes('impressao')) {
    console.log('Impressão na mesma página.');
    await page.pdf({ path: provisional, format: 'A4', printBackground: true, preferCSSPageSize: true });
    return provisional;
  }

  const pages = context.pages();
  for (const p of pages) {
    if (p !== page && (p.url().includes('hwcertidao') || p.url().includes('impressao'))) {
      console.log(`Página de impressão localizada no contexto: ${p.url()}`);
      await p.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      await p.pdf({ path: provisional, format: 'A4', printBackground: true, preferCSSPageSize: true });
      await p.close().catch(() => {});
      return provisional;
    }
  }

  throw new Error('Impressora não gerou download nem página de impressão detectável');
}

async function waitForCaptchaReady(page) {
  // Aguarda até que a imagem esteja de fato carregada na memória do navegador
  await page.waitForFunction(() => {
    const el = document.querySelector('#W0054CAPTCHAHTML img');
    return el && el.complete && el.naturalWidth > 0;
  }, { timeout: 10000 });
  await page.waitForTimeout(500);
}

async function reloadCaptcha(page) {
  console.log('[Captcha] Solicitando novo captcha...');
  const oldSrc = await page.evaluate(() => {
    const img = document.querySelector('#W0054CAPTCHAHTML img');
    return img ? img.src : '';
  }).catch(() => '');

  await page.evaluate(() => {
    const btn = document.querySelector('#W0054IMGCAPTCHA') || document.querySelector('[id*="ImgCaptchaReload" i]');
    if (btn) btn.click();
    else {
      const img = document.querySelector('#W0054CAPTCHAHTML img');
      if (img) img.src = img.src.split('?')[0] + '?Gb=' + Date.now();
    }
  }).catch(() => {});

  if (oldSrc) {
    // Fica monitorando até o src mudar e carregar
    await page.waitForFunction(prev => {
      const el = document.querySelector('#W0054CAPTCHAHTML img');
      return el && el.src !== prev && el.complete && el.naturalWidth > 0;
    }, oldSrc, { timeout: 10000 }).catch(() => {});
  } else {
    await waitForCaptchaReady(page).catch(() => {});
  }
  await page.waitForTimeout(500);
}

async function solveCaptchaAndSearch(page, report, maxAttempts = 3) {
  // 1. Tipo de Certidão
  const tipoSelect = page.locator('#vVTIPOCERTIDAO');
  await tipoSelect.waitFor({ state: 'visible', timeout: 8000 });
  if (await tipoSelect.inputValue().catch(() => '') !== '1') {
    await tipoSelect.selectOption('1');
  }

  // 2. Preenchimento instantâneo do CNPJ via injeção JS
  const rawCnpj = H.digits(CNPJ);
  await page.evaluate((c) => {
    const el = document.getElementById('vINCTBCPFCNPJ');
    if (el) {
      el.value = c;
      el.setAttribute('data-gxoldvalue', c);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true })); // Dispara o AJAX do site
    }
  }, rawCnpj);
  
  // Respiro rápido para o site digerir o CNPJ
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[Captcha] Tentativa ${attempt} de ${maxAttempts}...`);
    
    try {
      await waitForCaptchaReady(page);
    } catch (e) {
      console.warn('[Captcha] Imagem demorou para ser carregada no DOM.');
    }

    let buffer;
    try {
      // EXTRAÇÃO INFALÍVEL VIA HTML5 CANVAS
      const base64 = await page.evaluate(() => {
        const img = document.querySelector('#W0054CAPTCHAHTML img');
        if (!img || !img.complete || img.naturalWidth === 0) throw new Error('Imagem corrompida ou não carregada no DOM.');
        
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      buffer = Buffer.from(base64, 'base64');
    } catch (err) {
      console.warn(`[Captcha] Falha ao extrair imagem via Canvas: ${err.message}`);
      if (attempt < maxAttempts) await reloadCaptcha(page);
      continue;
    }

    fs.writeFileSync(path.join(DEBUG, `captcha-tentativa-${attempt}.png`), buffer);

    let recog;
    try {
      recog = await H.readImageGemini(buffer, 1);
      console.log(`[Captcha] Tentativa ${attempt} — decodificado: "${recog.code}"`);
    } catch (err) {
      console.warn(`[Captcha] Falha OCR: ${err.message}`);
      if (attempt < maxAttempts) await reloadCaptcha(page);
      continue;
    }

    // 3. Preenchimento do Captcha
    await page.evaluate((code) => {
      const el = document.getElementById('W0054vVCAPTCHA');
      if (el) {
        el.value = code;
        el.setAttribute('data-gxoldvalue', code);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }
    }, recog.code);

    await page.waitForTimeout(300);

    console.log(`[Captcha] Clicando em Pesquisar...`);
    const respPromise = page.waitForResponse(
      res => res.url().includes('hwpcgeracertidaonegativa') && res.request().method() === 'POST',
      { timeout: 8000 }
    ).catch(() => null);

    await page.evaluate(() => {
      const errViewer = document.getElementById('W0054gxErrorViewer');
      if (errViewer) errViewer.innerText = '';
      const btn = document.getElementById('W0054BUTTON1');
      if (btn) btn.click();
    });

    await respPromise;
    await page.waitForTimeout(1000);

    // 4. Avaliação inteligente: Checa se a grade de resultados foi renderizada
    const outcome = await page.waitForFunction(() => {
      const grid = document.querySelector('#Grid1ContainerRow_0001, #GridcertidaoContainerRow_0001, #GridcertidaoContainerTbl');
      const err = document.querySelector('#W0054gxErrorViewer, .ErrorMessages, .gx-warning-message');
      
      if (grid) return 'SUCCESS';
      if (err && err.innerText && err.innerText.trim().length > 0) return 'ERROR';
      return null;
    }, { timeout: 8000, polling: 200 }).catch(() => null);

    const isGridPresent = await page.evaluate(() => !!document.querySelector('#Grid1ContainerRow_0001, #GridcertidaoContainerRow_0001'));

    if (outcome === 'SUCCESS' || isGridPresent) {
      report.imageRecognized = true;
      await page.screenshot({ path: path.join(DEBUG, `step-pos-pesquisa-tentativa-${attempt}.png`), fullPage: true }).catch(() => {});
      console.log(`[Captcha] Sucesso! Painel de resultados carregado.`);
      return true;
    } else {
      console.warn(`[Captcha] Tentativa ${attempt} falhou: Captcha incorreto ou erro do servidor.`);
      await page.screenshot({ path: path.join(DEBUG, `step-falha-tentativa-${attempt}.png`), fullPage: true }).catch(() => {});
      if (attempt < maxAttempts) {
        await reloadCaptcha(page);
      }
    }
  }

  throw new Error(`Não foi possível validar o Captcha após ${maxAttempts} tentativas.`);
}

async function main() {
  H.ensureDir(REPORT);
  H.ensureDir(DEBUG);
  H.ensureDir(VIDEOS);
  H.ensureDir(OUTPUT);
  const report = reportBase();

  if (TEST_ALERT) {
    report.shouldRun = true;
    report.reason = 'Teste manual';
    report.newCertificate = { numero: 'TESTE', validade: 'TESTE' };
    await H.alerts(report, true);
    report.status = report.alerts.bark === 'SENT' && report.alerts.email === 'SENT' ? 'SUCCESS' : 'FAILED';
    H.saveReport(report, REPORT);
    return;
  }

  try {
    const row = await H.getControlRow(CNPJ);
    report.currentValidity = row.validade;
    const g = H.gate(row, FORCE);
    report.shouldRun = g.shouldRun;
    report.reason = g.reason;

    if (GATE_ONLY || !g.shouldRun) {
      report.status = 'SUCCESS';
      H.saveReport(report, REPORT);
      if (GATE_ONLY) H.ghOutput('should_run', g.shouldRun ? 'true' : 'false');
      return;
    }

    console.log(`Iniciando navegador (Headless: ${HEADLESS})...`);
    const browser = await chromium.launch({
      headless: HEADLESS,
      slowMo: HEADLESS ? 0 : 50
    });

    const context = await browser.newContext({
      locale: 'pt-BR',
      acceptDownloads: true,
      recordVideo: { dir: VIDEOS, size: { width: 1280, height: 720 } },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();
    page.on('dialog', d => d.accept().catch(() => {}));

    // === DESTRUIDOR CONTÍNUO DE MÁSCARAS DO GENEXUS ===
    await page.addInitScript(() => {
      setInterval(() => {
        document.querySelectorAll('.gx-mask').forEach(el => el.remove());
      }, 100);
    });

    try {
      console.log(`Navegando para: ${URL}`);
      await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.locator('#vINCTBCPFCNPJ').waitFor({ state: 'visible', timeout: 15000 });

      await solveCaptchaAndSearch(page, report, 3);

      const rc = await page.locator('#span_vGRIDCTBCPFCNPJMASC_0001').first().textContent().catch(() => '');
      const rn = await page.locator('#Grid1ContainerRow_0001 [id^="span_vGRIDCTBNOMERAZSOC_"]').first().textContent().catch(() => '');
      if (H.digits(rc) !== H.digits(CNPJ)) throw new Error(`CNPJ retornado diverge: ${rc}`);
      if (!H.normaliza(rn).includes('dexmed servicos medicos ltda')) throw new Error(`Razão social inesperada: ${rn}`);

      report.searchOk = true;
      const before = await latestNegative(page);
      console.log('Última negativa registrada:', before);

      if (DRY) {
        await debug(page, 'dry-run-after-search');
        report.status = 'SUCCESS';
        H.saveReport(report, REPORT);
        return;
      }

      const latest = await generate(page, context, before);
      report.generated = true;

      const tmp = await printPdf(page, context, latest);
      const text = await H.pdfText(tmp);
      H.validateCert(text, CNPJ);

      const data = H.extractCert(text);
      data.validade = data.validade || latest.validade;
      data.numero = data.numero || (latest.numero && latest.exercicio ? `${latest.numero}/${latest.exercicio}` : null);
      if (!data.validade) throw new Error('Validade não identificada no documento');
      report.pdfValidated = true;

      const final = path.join(OUTPUT, `DEXMED - CND Municipal Ipatinga - validade ${H.isoDate(H.parseBrDate(data.validade))}.pdf`);
      fs.renameSync(tmp, final);

      const drive = await H.uploadPdf(final, process.env.DRIVE_FOLDER_ID);
      report.driveUrl = await H.updateControl(row, {
        emissao: (latest.emissao || '').split(' ')[0] || new Intl.DateTimeFormat('pt-BR').format(new Date()),
        validade: data.validade,
        driveFile: drive,
        numero: data.numero,
        codigoControle: data.codigoControle,
        result: 'SUCCESS — emissão, PDF, Drive e planilha concluídos'
      });

      report.newCertificate = { numero: data.numero, emissao: latest.emissao, validade: data.validade, codigoControle: data.codigoControle };
      await H.alerts(report, true, final);

      report.status = 'SUCCESS';
      H.saveReport(report, REPORT);
    } catch (e) {
      report.status = 'FAILED';
      report.error = String(e.stack || e);
      await debug(page, 'failure').catch(() => {});
      try { await H.alerts(report, false); } catch (alertErr) { console.error(alertErr); }
      H.saveReport(report, REPORT);
      throw e;
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  } catch (e) {
    if (report.status !== 'FAILED') {
      report.status = 'FAILED';
      report.error = String(e.stack || e);
      H.saveReport(report, REPORT);
    }
    throw e;
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
