/**
 * 题库加载。
 *
 * 题库是**数据资产**，不是代码：`banks/` 目录下放 `.js`（导出数组）或 `.json`（数组）
 * 都会被自动收进来。老师/管理员替换题目不需要改引擎。
 */

import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
export const DEFAULT_BANK_DIR = path.join(PROJECT_ROOT, 'banks');

/** 文件名关键词 → 学科/学段。用于在没有显式元数据时做归属判断。 */
const SUBJECT_HINTS = [
  [/math|数学/i, '数学'], [/physics|物理/i, '物理'], [/chemistry|化学/i, '化学'],
  [/chinese|语文/i, '语文'], [/english|英语/i, '英语'], [/biology|生物/i, '生物'],
  [/history|历史/i, '历史'], [/geo|地理/i, '地理'], [/politics|政治/i, '政治'],
];
const GRADE_HINTS = [[/senior|高中|gaozhong/i, '高中'], [/junior|初中|chuzhong/i, '初中'], [/primary|小学/i, '小学']];

function guessMeta(fileName) {
  const subject = SUBJECT_HINTS.find(([re]) => re.test(fileName))?.[1] ?? '';
  const grade = GRADE_HINTS.find(([re]) => re.test(fileName))?.[1] ?? '';
  return { subject, grade };
}

/** 校验并补齐一道题目的必填字段。返回 null 表示这道题不可用。 */
export function normalizeQuestion(raw, sourceFile, index) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? `${path.basename(sourceFile, path.extname(sourceFile))}-${index + 1}`);
  const type = String(raw.type ?? '').toLowerCase();
  const allowed = ['choice', 'multi', 'blank', 'judge', 'solve', 'proof', 'essay'];
  if (!allowed.includes(type)) return null;

  const stem = String(raw.stem ?? '').trim();
  if (!stem) return null;

  const difficulty = Number(raw.difficulty);
  return {
    id,
    type,
    stem,
    ...(Array.isArray(raw.options) ? { options: raw.options.map(String) } : {}),
    ...(raw.answer !== undefined ? { answer: raw.answer } : {}),
    ...(raw.analysis ? { analysis: String(raw.analysis) } : {}),
    score: Number(raw.score) > 0 ? Number(raw.score) : 5,
    difficulty: Number.isFinite(difficulty) ? Math.min(1, Math.max(0, difficulty)) : 0.5,
    knowledge: Array.isArray(raw.knowledge) ? raw.knowledge.map(String).filter(Boolean) : (raw.knowledge ? [String(raw.knowledge)] : []),
    ...(raw.source ? { source: String(raw.source) } : {}),
    bank: path.basename(sourceFile),
  };
}

/** 读取一个题库文件（.js 或 .json）。 */
async function readBankFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let payload;
  if (ext === '.json') {
    const { readFile } = await import('node:fs/promises');
    payload = JSON.parse(await readFile(filePath, 'utf8'));
  } else if (ext === '.js' || ext === '.mjs') {
    const module = await import(pathToFileURL(filePath).href);
    payload = module.default ?? module.questions ?? module.bank;
  } else return null;

  if (payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray(payload.questions)) {
    // { meta: {subject, grade}, questions: [...] } 形式
    const guessed = guessMeta(path.basename(filePath));
    return {
      file: filePath,
      name: payload.meta?.name ?? path.basename(filePath),
      subject: payload.meta?.subject ?? guessed.subject,
      grade: payload.meta?.grade ?? guessed.grade,
      questions: payload.questions.map((item, i) => normalizeQuestion(item, filePath, i)).filter(Boolean),
    };
  }
  if (!Array.isArray(payload)) return null;

  const guessed = guessMeta(path.basename(filePath));
  return {
    file: filePath,
    name: path.basename(filePath),
    subject: guessed.subject,
    grade: guessed.grade,
    questions: payload.map((item, i) => normalizeQuestion(item, filePath, i)).filter(Boolean),
  };
}

/** 加载目录下全部题库。 */
export async function loadBanks(bankDir = DEFAULT_BANK_DIR) {
  if (!existsSync(bankDir)) return [];
  const entries = await readdir(bankDir);
  const banks = [];
  for (const entry of entries.sort()) {
    if (!/\.(js|mjs|json)$/i.test(entry)) continue;
    try {
      const bank = await readBankFile(path.join(bankDir, entry));
      if (bank && bank.questions.length) banks.push(bank);
    } catch (error) {
      process.emitWarning?.(`题库 ${entry} 加载失败：${error.message}`);
    }
  }
  return banks;
}

/**
 * 取用于组卷的题目池。
 *
 * @param {{subject?: string, grade?: string, extra?: object[], bankDir?: string}} [options]
 * @returns {Promise<Array<object>>}
 */
export async function loadBank(options = {}) {
  const banks = await loadBanks(options.bankDir);
  const extra = Array.isArray(options.extra) ? options.extra : [];
  const extraQuestions = extra.map((item, i) => normalizeQuestion(item, 'inline', i)).filter(Boolean);

  if (!banks.length) return extraQuestions;

  const subject = String(options.subject ?? '').trim();
  let selected = banks;
  if (subject) {
    const matched = banks.filter(bank => bank.subject === subject || bank.name.includes(subject));
    // 学科没有专属题库时回退到全部题库，并在上层以 warnings 说明覆盖不足。
    if (matched.length) selected = matched;
  }

  const questions = selected.flatMap(bank => bank.questions);
  return [...questions, ...extraQuestions];
}

/** 题库概览，供 CLI `formgen bank` 展示。 */
export async function describeBanks(bankDir = DEFAULT_BANK_DIR) {
  const banks = await loadBanks(bankDir);
  return banks.map(bank => {
    const byType = {};
    for (const question of bank.questions) byType[question.type] = (byType[question.type] ?? 0) + 1;
    const knowledge = [...new Set(bank.questions.flatMap(question => question.knowledge))];
    return {
      name: bank.name,
      subject: bank.subject,
      grade: bank.grade,
      count: bank.questions.length,
      byType,
      knowledge,
    };
  });
}
