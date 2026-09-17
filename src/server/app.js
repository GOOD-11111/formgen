/**
 * HTTP 服务：把引擎包成一个能用的微型平台。
 *
 * 两条静默但重要的设计：
 *   1. `/engine/*` 直接把 `src/` 暴露给浏览器——前端运行时 import 的就是服务端引擎源码本身。
 *   2. 提交数据在服务端**再次**用同一份 Schema 校验。不是「信任前端」，而是
 *      客户端校验为了体验、服务端校验为了正确，两者共用同一个函数。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileStore } from './store.js';
import { generate, generateByRule, compareChannels } from '../gen/index.js';
import { isLlmConfigured, resolveLlmConfig } from '../gen/llm.js';
import { validateSubmission } from '../core/validate.js';
import { normalizeSchema, schemaStats, fieldIndex } from '../core/schema.js';
import { describeError, FormgenError } from '../core/errors.js';
import { renderFillPage, renderHomePage, renderStudioPage, renderResultsPage, renderDocsPage, renderErrorPage, collectColumns, formatCell } from '../render/html.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');

const MAX_BODY_BYTES = 12 * 1024 * 1024; // 允许 base64 内联的小文件

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  // 漏了 jpg 会让背景图以 application/octet-stream 下发，部分浏览器会拒绝渲染。
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * @param {{port?: number, host?: string, dataDir?: string, quiet?: boolean}} [options]
 */
export async function createFormgenServer(options = {}) {
  const dataDir = options.dataDir ?? path.join(PROJECT_ROOT, 'data');
  const store = await new FileStore(dataDir).init();
  const quiet = options.quiet ?? false;

  const log = (...args) => { if (!quiet) console.log(...args); };

  async function handler(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    try {
      // ---------- 静态资源 ----------
      if (pathname.startsWith('/static/')) {
        return await serveFile(res, path.join(PUBLIC_DIR, pathname.slice('/static/'.length)), PUBLIC_DIR);
      }
      // 引擎源码直供浏览器：前端与后端共用同一份校验/表达式实现。
      if (pathname.startsWith('/engine/')) {
        return await serveFile(res, path.join(SRC_DIR, pathname.slice('/engine/'.length)), SRC_DIR);
      }
      if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }

      // ---------- JSON API ----------
      if (pathname.startsWith('/api/')) {
        return await handleApi(req, res, pathname, store, { quiet });
      }

      // ---------- 页面 ----------
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendHtml(res, 405, renderErrorPage(405, '该地址只支持 GET 请求'));
      }

      if (pathname === '/' || pathname === '') {
        const forms = await Promise.all(store.listForms().map(async record => ({
          ...record,
          submissionCount: await store.submissionCount(record.id),
        })));
        const stats = await store.stats();
        return sendHtml(res, 200, renderHomePage(forms, { ...stats, llmConfigured: isLlmConfigured() }));
      }

      if (pathname === '/studio') return sendHtml(res, 200, renderStudioPage());
      if (pathname === '/docs') return sendHtml(res, 200, renderDocsPage());

      const previewMatch = /^\/preview\/([\w-]+)$/.exec(pathname);
      if (previewMatch) {
        const schema = store.getDraft(previewMatch[1]);
        if (!schema) return sendHtml(res, 404, renderErrorPage(404, '预览已过期（草稿仅保留 6 小时），请回生成器重新生成。'));
        return sendHtml(res, 200, renderFillPage(schema, { preview: true }));
      }

      const formMatch = /^\/f\/([^/]+)$/.exec(pathname);
      if (formMatch) {
        const form = await store.getForm(formMatch[1]);
        if (!form) return sendHtml(res, 404, renderErrorPage(404, '表单不存在'));
        const submissions = await store.listSubmissions(form.id);
        const grading = await buildGrading(form, submissions);
        return sendHtml(res, 200, renderResultsPage(form, submissions, { grading }));
      }

      const fillMatch = /^\/f\/([^/]+)\/fill$/.exec(pathname);
      if (fillMatch) {
        const form = await store.getForm(fillMatch[1]);
        if (!form) return sendHtml(res, 404, renderErrorPage(404, '表单不存在'));
        if (form.schema.settings?.closeAt && new Date(form.schema.settings.closeAt) < new Date()) {
          return sendHtml(res, 403, renderErrorPage(403, '该表单已停止收集'));
        }
        return sendHtml(res, 200, renderFillPage(form.schema));
      }

      const schemaMatch = /^\/f\/([^/]+)\/schema\.json$/.exec(pathname);
      if (schemaMatch) {
        const form = await store.getForm(schemaMatch[1]);
        if (!form) return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '表单不存在' } });
        return sendJson(res, 200, form.schema);
      }

      const exportMatch = /^\/f\/([^/]+)\/export\.(csv|json)$/.exec(pathname);
      if (exportMatch) {
        const form = await store.getForm(exportMatch[1]);
        if (!form) return sendHtml(res, 404, renderErrorPage(404, '表单不存在'));
        const submissions = await store.listSubmissions(form.id);
        if (exportMatch[2] === 'json') {
          return sendDownload(res, `${form.id}.json`, 'application/json; charset=utf-8',
            JSON.stringify({ form: { id: form.id, title: form.title }, schema: form.schema, submissions }, null, 2));
        }
        return sendDownload(res, `${form.id}.csv`, 'text/csv; charset=utf-8', toCsv(form.schema, submissions));
      }

      return sendHtml(res, 404, renderErrorPage(404, '页面不存在'));
    } catch (error) {
      const { code, message } = describeError(error);
      log(`[error] ${code}: ${message}`);
      if (pathname.startsWith('/api/')) return sendJson(res, 500, { ok: false, error: { code, message } });
      return sendHtml(res, 500, renderErrorPage(500, message));
    }
  }

  const server = createServer(handler);
  return {
    server,
    store,
    listen(port = options.port ?? 4321, host = options.host ?? '127.0.0.1') {
      return new Promise(resolve => {
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    close() {
      return new Promise(resolve => server.close(resolve));
    },
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleApi(req, res, pathname, store, ctx) {
  const route = `${req.method} ${pathname}`;

  if (route === 'POST /api/generate') {
    const body = await readJsonBody(req);
    const text = String(body.text ?? '').trim();
    if (!text) throw new FormgenError('NLP_EMPTY_INPUT', '需求文本为空');

    const mode = ['auto', 'rule', 'llm', 'compare', 'exam'].includes(body.mode) ? body.mode : 'auto';
    const llmOptions = { apiKey: body.apiKey, baseUrl: body.baseUrl, model: body.model };

    if (mode === 'exam') {
      const result = await runExamPipeline(text, body);
      const draftId = store.putDraft(result.schema);
      return sendJson(res, 200, { ok: true, kind: 'exam', draftId, schema: result.schema, paper: result.paper, blueprint: result.blueprint, outline: result.outline, issues: result.issues });
    }

    if (mode === 'compare') {
      const rule = generateByRule(text);
      let llm = null;
      let llmError = null;
      try {
        llm = await generate(text, { ...llmOptions, mode: 'llm' });
      } catch (error) {
        llmError = describeError(error);
      }
      const comparison = llm ? compareChannels(rule, llm) : null;
      const draftId = store.putDraft(rule.schema);
      return sendJson(res, 200, {
        ok: true,
        mode: 'compare',
        kind: 'form',
        draftId,
        schema: rule.schema,
        channel: 'rule',
        issues: rule.issues,
        understanding: rule.understanding,
        comparison,
        llmError,
      });
    }

    const result = await generate(text, { ...llmOptions, mode });
    const draftId = store.putDraft(result.schema);
    return sendJson(res, 200, {
      ok: true,
      kind: result.kind,
      draftId,
      schema: result.schema,
      channel: result.channel,
      llm: result.llm,
      fallback: result.fallback,
      issues: result.issues ?? [],
      understanding: result.understanding,
    });
  }

  if (route === 'POST /api/publish') {
    const body = await readJsonBody(req);
    const schema = store.getDraft(String(body.draftId ?? ''));
    if (!schema) throw new FormgenError('DRAFT_NOT_FOUND', '草稿不存在或已过期，请重新生成');
    const record = await store.createForm(schema, { id: body.id });
    return sendJson(res, 200, {
      ok: true,
      formId: record.id,
      fillUrl: `/f/${record.id}/fill`,
      resultsUrl: `/f/${record.id}`,
    });
  }

  if (route === 'POST /api/submit') {
    const body = await readJsonBody(req);
    const form = await store.getForm(String(body.formId ?? ''));
    if (!form) throw new FormgenError('FORM_NOT_FOUND', '表单不存在');

    const settings = form.schema.settings ?? {};
    if (settings.closeAt && new Date(settings.closeAt) < new Date()) {
      throw new FormgenError('FORM_CLOSED', '该表单已停止收集');
    }
    if (settings.allowMultipleSubmissions === false && (await store.submissionCount(form.id)) > 0) {
      throw new FormgenError('ALREADY_SUBMITTED', '该表单每份只能提交一次');
    }

    // 服务端权威校验：与浏览器跑的是同一个函数。
    const result = validateSubmission(form.schema, body.values ?? {});
    if (!result.ok) {
      return sendJson(res, 422, {
        ok: false,
        error: { code: 'VALIDATION_FAILED', message: `有 ${result.errors.length} 项未通过校验` },
        errors: result.errors,
      });
    }

    const grading = gradeIfExam(form.schema, result.values);
    const record = await store.addSubmission(form.id, {
      values: result.values,
      meta: body.meta ?? {},
      ...(grading ? { grading } : {}),
    });

    return sendJson(res, 200, {
      ok: true,
      submissionId: record.id,
      message: settings.successMessage ?? '提交成功，感谢你的填写！',
      ...(grading && form.schema.kind === 'exam' ? { score: grading.total, totalScore: grading.fullScore } : {}),
    });
  }

  void ctx;
  return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `未知接口 ${route}` } });
}

/** 考卷流水线：需求 → 大纲 → 蓝图 → 组卷 → 可渲染/可评分的 Schema。 */
async function runExamPipeline(text, body) {
  const { planExam } = await import('../gen/index.js');
  const { buildBlueprint } = await import('../exam/blueprint.js');
  const { selectQuestions } = await import('../exam/select.js');
  const { paperToSchema, alignBankToBlueprint } = await import('../exam/paper-schema.js');
  const { loadBank } = await import('../exam/bank.js');

  const planned = planExam(text);
  const outline = { ...planned.outline, ...(body.outline ?? {}) };
  const blueprint = buildBlueprint(outline);

  const bank = await loadBank({ subject: outline.subject, grade: outline.grade, extra: body.questions });
  // 分值对齐必须发生在组卷之前，否则实际总分必然偏离计划总分。
  const { paper, report } = selectQuestions(alignBankToBlueprint(bank, blueprint), blueprint, { seed: body.seed });
  paper.report = report;

  const schema = paperToSchema(paper, { sourceText: text });
  return { schema, paper, blueprint, outline, issues: report.warnings };
}

/** 考卷提交后自动判分（仅客观题可自动判，主观题留给人工）。 */
function gradeIfExam(schema, values) {
  if (schema.kind !== 'exam' || schema.grading?.autoGrade === false) return null;
  const index = fieldIndex(schema);
  let total = 0;
  let fullScore = 0;
  const details = [];

  for (const [key, field] of index) {
    if (field.type !== 'question') continue;
    const question = field.question ?? {};
    const score = Number(question.score) || 0;
    fullScore += score;

    const objective = ['choice', 'multi', 'judge', 'blank'].includes(question.type);
    if (!objective) {
      details.push({ key, label: field.label, type: question.type, score, awarded: null, correct: null, needsReview: true });
      continue;
    }
    const correct = isCorrect(question, values[key]);
    const awarded = correct ? score : 0;
    total += awarded;
    details.push({ key, label: field.label, type: question.type, score, awarded, correct, needsReview: false, answer: question.answer });
  }

  const autoGraded = details.filter(d => !d.needsReview);
  return {
    total,
    fullScore,
    objectiveScore: autoGraded.reduce((sum, d) => sum + d.score, 0),
    gradedAt: new Date().toISOString(),
    details,
  };
}

const OBJECTIVE_TYPES = new Set(['choice', 'multi', 'judge', 'blank']);

/**
 * 客观题判分：单选/判断严格比较；多选全对才给分；填空按字符串归一后比较。
 *
 * 主观题（解答/证明/论述）**返回 null 表示不可自动判定**，而不是 false——
 * 「判错了」和「判不了」是两件事，混在一起会让成绩统计失真。
 */
export function isCorrect(question, answer) {
  if (!question || !OBJECTIVE_TYPES.has(question.type)) return null;
  const expected = question.answer;
  if (expected === undefined || expected === null) return null;
  const normalize = value => String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');

  if (question.type === 'multi') {
    const expectedList = (Array.isArray(expected) ? expected : [expected]).map(normalize).sort();
    const actualList = (Array.isArray(answer) ? answer : [answer]).map(normalize).filter(Boolean).sort();
    return expectedList.length === actualList.length && expectedList.every((v, i) => v === actualList[i]);
  }
  if (question.type === 'judge') {
    const toBool = value => (typeof value === 'boolean' ? value : ['true', '对', '正确', '是', 't', '√'].includes(normalize(value)));
    return toBool(expected) === toBool(answer);
  }
  if (question.type === 'blank') {
    const expectedList = Array.isArray(expected) ? expected : [expected];
    const actualList = Array.isArray(answer) ? answer : [answer];
    return expectedList.every((value, i) => normalize(value) === normalize(actualList[i]));
  }
  return normalize(expected) === normalize(answer);
}

async function buildGrading(form, submissions) {
  if (form.schema.kind !== 'exam') return null;
  const graded = submissions.map(s => s.grading).filter(Boolean);
  if (!graded.length) return null;

  const scores = graded.map(g => g.total);
  const index = fieldIndex(form.schema);
  const perQuestion = [];
  for (const [key, field] of index) {
    if (field.type !== 'question') continue;
    const awards = graded.map(g => g.details.find(d => d.key === key)).filter(Boolean);
    const objective = awards.filter(a => !a.needsReview);
    perQuestion.push({
      label: field.label,
      score: Number(field.question?.score) || 0,
      average: objective.length ? (objective.reduce((sum, a) => sum + (a.awarded ?? 0), 0) / objective.length).toFixed(2) : '—',
      accuracy: objective.length ? `${Math.round(objective.filter(a => a.correct).length / objective.length * 100)}%` : '待人工',
    });
  }

  return {
    count: graded.length,
    average: (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1),
    max: Math.max(...scores),
    min: Math.min(...scores),
    perQuestion,
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new FormgenError('BODY_TOO_LARGE', `请求体超过 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB 上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new FormgenError('BODY_NOT_JSON', `请求体不是合法 JSON：${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function serveFile(res, filePath, rootDir) {
  // 目录穿越防护：解析后的真实路径必须仍在允许的根目录内。
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(rootDir) + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    res.writeHead(404).end('Not Found');
    return;
  }
  const body = await readFile(resolved);
  const type = MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }).end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(payload));
}

function sendDownload(res, filename, contentType, body) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  }).end(body);
}

/** 导出 CSV。带 BOM，否则 Excel 打开中文会乱码——这是真实使用中最常被投诉的一点。 */
export function toCsv(schema, submissions) {
  const columns = collectColumns(schema);
  const escape = value => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['编号', '提交时间', ...columns.map(c => c.group ? `${c.group}/${c.label}` : c.label)];
  const lines = [header.map(escape).join(',')];

  for (const submission of submissions) {
    const row = [
      submission.id,
      submission.createdAt,
      ...columns.map(column => formatCell(column, submission.values?.[column.key])),
    ];
    lines.push(row.map(escape).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

/** 供 CLI 复用的便捷包装。 */
export async function startServer(options = {}) {
  const instance = await createFormgenServer(options);
  const address = await instance.listen(options.port, options.host);
  return { ...instance, address };
}

export { renderStudioPage, renderDocsPage, normalizeSchema, schemaStats, resolveLlmConfig };
