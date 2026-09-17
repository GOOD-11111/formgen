/**
 * 自适应组卷（Adaptive Paper Selection）—— 考卷场景内核 ②
 * =====================================================================
 * 职责：给定题库与命题蓝图，用「种子化随机 + 贪心可行性 + 多轮重启取最优」
 *       选出一份考卷，并给出可解释的组卷报告（分值/难度/知识点覆盖/警告/建议）。
 *
 * 设计要点
 * --------
 * 1. 确定性：同一 seed + 同一输入 ⇒ 完全相同的 paper（因此 generatedAt 默认
 *    由 seed 确定性推导；如需要真实时间，传 options.now 或 options.generatedAt）。
 * 2. 绝不抛错：题库不足、题库为空、蓝图残缺都返回「尽力而为」的卷子 + warnings。
 * 3. 选优目标：① 知识点覆盖（按蓝图权重）② 难度贴合（分区目标 vs 实际均值）
 *    ③ 题型/数量必然优先满足 ④ 优先使用未被使用过的题。
 * 4. 零依赖，只使用 ECMAScript 内置能力。
 *
 * @typedef {import('./blueprint.js').CanonicalType} CanonicalType
 */

import {
  ExamError,
  buildBlueprint,
  difficultyToNumber,
  normalizeType,
  TYPE_LABELS,
} from './blueprint.js';

/** 默认随机种子（与需求一致）。 */
export const DEFAULT_SEED = 20240501;
/** 默认重启轮数。 */
export const DEFAULT_ATTEMPTS = 60;
/** 默认难度容差。 */
export const DEFAULT_DIFFICULTY_TOLERANCE = 0.18;

/** 覆盖达标容差：实际覆盖 ≥ 需求 × (1 - ε) 即视为达标。 */
const COVERAGE_GRACE = 0.15;
/** 难度直方图分档阈值（[0,0.4) 易、[0.4,0.7) 中、[0.7,1] 难）。 */
const BAND_EASY_MAX = 0.4;
const BAND_MEDIUM_MAX = 0.7;
/** 代价函数权重。 */
const W_FILL = 3.0;
const W_COVERAGE = 1.0;
const W_DIFFICULTY = 0.8;
const W_REUSE = 0.6;
/** 逐题效用权重（同一分区内排序用）。 */
const U_KNOWLEDGE_MATCH = 1.2;
const U_KNOWLEDGE_WEIGHT = 0.8;
const U_DIFFICULTY_FIT = 0.9;
const U_SCORE_FIT = 0.5;
const U_UNUSED = 0.45;
const U_REUSE_PENALTY = -2.6;
const U_DEFICIT_BONUS = 0.9;
/** generatedAt 的确定性基准时刻（2024-01-01T00:00:00Z）。 */
const GENERATED_AT_BASE_MS = Date.UTC(2024, 0, 1, 0, 0, 0);

/* ==================================================================== *
 * 随机数
 * ==================================================================== */

/**
 * mulberry32 伪随机数发生器（供外部复用/测试）。
 * @param {number|string} seed
 * @returns {() => number} 返回 [0,1) 的确定性随机数
 */
export function createRng(seed) {
  let a = normalizeSeed(seed);
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把任意种子折叠成 uint32。 */
function normalizeSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.trunc(seed) >>> 0;
  if (typeof seed === 'string') {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
      h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
    }
    return h >>> 0;
  }
  return DEFAULT_SEED >>> 0;
}

/** 第 k 轮重启使用的子种子。 */
function mixSeed(seed, k) {
  return (normalizeSeed(seed) + Math.imul(k, 0x9e3779b1)) >>> 0;
}

/** Fisher–Yates 洗牌（不改动入参）。 */
function shuffle(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/* ==================================================================== *
 * 题库 / 蓝图归一
 * ==================================================================== */

/**
 * 归一题库：丢弃无法识别题型或分值非法的题，其余保留**原对象引用**
 * （仅在题型/ID 需要补全时才浅拷贝，便于上层按引用比对）。
 */
function prepareBank(bank) {
  const raw = Array.isArray(bank) ? bank : [];
  const list = [];
  let ignored = 0;
  raw.forEach((q, index) => {
    const rec = prepareQuestion(q, index);
    if (rec) list.push(rec);
    else ignored += 1;
  });
  return { list, ignored, total: raw.length };
}

function prepareQuestion(q, index) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return null;
  let type;
  try {
    type = normalizeType(q.type);
  } catch (err) {
    if (!(err instanceof ExamError)) throw err;
    return null;
  }
  const score = Number(q.score);
  if (!Number.isFinite(score) || score <= 0) return null;
  const difficulty = (q.difficulty === undefined || q.difficulty === null)
    ? 0.55
    : difficultyToNumber(q.difficulty);
  const knowledge = Array.isArray(q.knowledge)
    ? q.knowledge.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim())
    : [];
  const id = (typeof q.id === 'string' && q.id.trim()) ? q.id.trim() : `q#${index}`;
  const needCopy = id !== q.id || type !== q.type;
  const obj = needCopy ? { ...q, id, type } : q;
  return { q: obj, id, type, score, difficulty, knowledge };
}

/** 归一外部传入的蓝图；残缺字段补默认值，不可用分区直接丢弃。 */
function normalizeGivenBlueprint(input) {
  const notes = [];
  const sections = [];
  const rawSections = Array.isArray(input.sections) ? input.sections : [];
  rawSections.forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    let type;
    try {
      type = normalizeType(s.type);
    } catch (err) {
      if (!(err instanceof ExamError)) throw err;
      notes.push(`蓝图第 ${i + 1} 个分区的题型「${String(s.type)}」无法识别，已忽略该分区`);
      return;
    }
    const count = Math.max(0, Math.floor(Number(s.count)));
    if (!Number.isFinite(count) || count <= 0) {
      notes.push(`蓝图分区「${TYPE_LABELS[type] || type}」题量非法或为 0，已忽略该分区`);
      return;
    }
    const scorePer = Number(s.scorePer) > 0 ? Number(s.scorePer) : 0;
    sections.push({
      id: typeof s.id === 'string' && s.id ? s.id : `${i + 1}-${type}`,
      type,
      title: typeof s.title === 'string' && s.title ? s.title : `${TYPE_LABELS[type] || type}`,
      count,
      scorePer,
      score: Number(s.score) > 0 ? Number(s.score) : count * scorePer,
      difficulty: difficultyToNumber(s.difficulty),
      knowledge: Array.isArray(s.knowledge)
        ? s.knowledge.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim())
        : [],
    });
  });

  const kps = Array.isArray(input.knowledgePoints) ? input.knowledgePoints : [];
  const acc = [];
  for (const kp of kps) {
    const name = kp && typeof kp === 'object' ? kp.name : (typeof kp === 'string' ? kp : '');
    if (typeof name !== 'string' || !name.trim()) continue;
    const w = Number(kp && typeof kp === 'object' ? kp.weight : 0);
    acc.push({ name: name.trim(), weight: Number.isFinite(w) && w > 0 ? w : 0 });
  }
  let wSum = acc.reduce((a, k) => a + k.weight, 0);
  let knowledgePoints = [];
  if (acc.length > 0) {
    if (!(wSum > 0)) {
      knowledgePoints = acc.map((k) => ({ name: k.name, weight: 1 / acc.length }));
    } else {
      knowledgePoints = acc.map((k) => ({ name: k.name, weight: k.weight / wSum }));
    }
  }
  wSum = knowledgePoints.reduce((a, k) => a + k.weight, 0);

  const totalScore = Number(input.totalScore) > 0
    ? Number(input.totalScore)
    : sections.reduce((a, s) => a + s.score, 0);

  return {
    bp: {
      title: typeof input.title === 'string' && input.title ? input.title : '考试卷',
      subject: typeof input.subject === 'string' && input.subject ? input.subject : '通用',
      grade: typeof input.grade === 'string' ? input.grade : '',
      totalScore,
      duration: Number(input.duration) > 0 ? Number(input.duration) : 0,
      difficulty: difficultyToNumber(input.difficulty),
      difficultyLabel: 'mixed',
      knowledgePoints,
      sections,
      adjustments: Array.isArray(input.adjustments) ? input.adjustments.slice() : [],
    },
    notes,
  };
}

/** 取得可用蓝图；任何异常都退化为「100 分通用卷」，绝不抛错。 */
function resolveBlueprint(blueprint) {
  if (!blueprint || typeof blueprint !== 'object' || Array.isArray(blueprint)) {
    return { bp: EMPTY_BLUEPRINT(), notes: ['未提供有效蓝图，已退化为 100 分通用卷（无分区）'] };
  }
  if (Array.isArray(blueprint.sections)) {
    const normalized = normalizeGivenBlueprint(blueprint);
    if (normalized.bp.sections.length > 0 || blueprint.sections.length === 0) return normalized;
    // 分区全部不可用：可能传入的其实是「大纲」，按大纲重新编译一次
    const retry = tryCompileOutline(blueprint);
    if (retry) return retry;
    return normalized;
  }
  // 没有 sections：按大纲处理
  const compiled = tryCompileOutline(blueprint);
  if (compiled) return compiled;
  return { bp: EMPTY_BLUEPRINT(), notes: ['传入对象既不是蓝图也不是可编译的大纲，已退化为 100 分通用卷'] };
}

function tryCompileOutline(outline) {
  try {
    return normalizeGivenBlueprint(buildBlueprint(outline));
  } catch (err) {
    if (!(err instanceof ExamError)) throw err;
    return { bp: EMPTY_BLUEPRINT(), notes: [`无法编译传入的大纲：${err.message}`] };
  }
}

function EMPTY_BLUEPRINT() {
  return {
    title: '考试卷',
    subject: '通用',
    grade: '',
    totalScore: 100,
    duration: 80,
    difficulty: 0.55,
    difficultyLabel: 'mixed',
    knowledgePoints: [],
    sections: [],
    adjustments: [],
  };
}

/* ==================================================================== *
 * 组卷上下文
 * ==================================================================== */

function buildContext(records, bp, opts) {
  const pools = new Map();
  for (const rec of records) {
    if (!pools.has(rec.type)) pools.set(rec.type, []);
    pools.get(rec.type).push(rec);
  }
  const kpWeights = new Map();
  for (const kp of bp.knowledgePoints) {
    kpWeights.set(kp.name, (kpWeights.get(kp.name) || 0) + kp.weight);
  }
  return {
    records,
    bp,
    pools,
    kpWeights,
    plannedScore: bp.totalScore,
    allowReuse: opts.allowReuse,
    tolerance: opts.tolerance,
    attempts: opts.attempts,
  };
}

/* ==================================================================== *
 * 单轮构建 + 评价
 * ==================================================================== */

/** 逐题静态效用：知识点契合 + 难度贴合。 */
function baseUtility(rec, sec, kpWeights) {
  let u = 0;
  if (sec.knowledge.length > 0) {
    u += rec.knowledge.some((k) => sec.knowledge.includes(k)) ? U_KNOWLEDGE_MATCH : 0;
  } else {
    let w = 0;
    for (const k of rec.knowledge) w = Math.max(w, kpWeights.get(k) || 0);
    u += U_KNOWLEDGE_WEIGHT * Math.min(1, w / 0.25);
  }
  const fit = 1 - Math.min(1, Math.abs(rec.difficulty - sec.difficulty) / Math.max(0.08, 0.36));
  u += U_DIFFICULTY_FIT * fit;
  // 每题分值贴近分区标准分值（题库存在多套分值时优先匹配，使实际总分贴近计划总分）
  if (sec.scorePer > 0 && rec.score === sec.scorePer) u += U_SCORE_FIT;
  return u;
}

/** 执行一轮贪心组卷。 */
function buildAttempt(ctx, rng, attemptIndex) {
  const { bp, pools, kpWeights, plannedScore, allowReuse, attempts } = ctx;
  const usage = new Map();
  const covered = new Map();
  const jitter = Math.max(0.08, 0.8 * (1 - attemptIndex / Math.max(1, attempts)));
  const order = shuffle(bp.sections.map((_, i) => i), rng);
  /** @type {Array<Array<object>>} */
  const results = new Array(bp.sections.length).fill(null);
  let reused = 0;

  for (const si of order) {
    const sec = bp.sections[si];
    const pool = pools.get(sec.type) || [];
    const scored = pool.map((rec) => {
      let u = baseUtility(rec, sec, kpWeights);
      const used = usage.get(rec) || 0;
      u += (used > 0 && !allowReuse) ? U_REUSE_PENALTY : U_UNUSED;
      for (const tag of rec.knowledge) {
        const target = (kpWeights.get(tag) || 0) * plannedScore;
        if (!(target > 0)) continue;
        const got = covered.get(tag) || 0;
        if (got < target) u += U_DEFICIT_BONUS * (1 - got / target);
      }
      u += jitter * (rng() - 0.5);
      return { rec, u };
    });
    // 稳定排序：效用降序，同效用按 id 字典序，保证确定性
    scored.sort((a, b) => (b.u - a.u) || compareId(a.rec.id, b.rec.id));

    const picked = [];
    const inSection = new Set();
    for (const item of scored) {
      if (picked.length >= sec.count) break;
      if (inSection.has(item.rec)) continue;
      inSection.add(item.rec);
      picked.push(item.rec);
    }
    // 该题型题量不足以填满分区时允许同题重复（会写入 warnings）
    let cursor = 0;
    while (picked.length < sec.count && scored.length > 0) {
      picked.push(scored[cursor % scored.length].rec);
      cursor += 1;
    }

    for (const rec of picked) {
      const used = usage.get(rec) || 0;
      if (used > 0) reused += 1;
      usage.set(rec, used + 1);
      for (const tag of rec.knowledge) covered.set(tag, (covered.get(tag) || 0) + rec.score);
    }
    results[si] = picked;
  }

  return { sections: results, usage, covered, reused };
}

/** 单轮评分（越小越好）。 */
function evaluateAttempt(attempt, ctx) {
  const { bp, plannedScore, kpWeights } = ctx;
  let cost = 0;

  // ③ 题型/数量：填不满是最大扣分项
  let needed = 0;
  let filled = 0;
  for (let i = 0; i < bp.sections.length; i += 1) {
    needed += bp.sections[i].count;
    filled += Math.min(attempt.sections[i].length, bp.sections[i].count);
  }
  cost += W_FILL * ((needed - filled) / Math.max(1, needed));
  cost += W_REUSE * (attempt.reused / Math.max(1, needed));

  // ① 知识点覆盖缺口
  if (plannedScore > 0 && kpWeights.size > 0) {
    let gap = 0;
    let total = 0;
    for (const [tag, w] of kpWeights) {
      const required = w * plannedScore;
      if (!(required > 0)) continue;
      total += required;
      gap += Math.max(0, required - (attempt.covered.get(tag) || 0));
    }
    if (total > 0) cost += W_COVERAGE * (gap / total);
  }

  // ② 难度贴合
  let diffCost = 0;
  let counted = 0;
  for (let i = 0; i < bp.sections.length; i += 1) {
    const qs = attempt.sections[i];
    if (!qs || qs.length === 0) continue;
    const avg = qs.reduce((a, r) => a + r.difficulty, 0) / qs.length;
    const d = Math.min(1, Math.abs(avg - bp.sections[i].difficulty) / 0.5);
    diffCost += d * d;
    counted += 1;
  }
  if (counted > 0) cost += W_DIFFICULTY * (diffCost / counted);

  return cost;
}

function compareId(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/* ==================================================================== *
 * selectQuestions
 * ==================================================================== */

/**
 * 自适应组卷。
 * @param {Array<object>} bank 题库
 * @param {object} blueprint 命题蓝图（buildBlueprint 产物；也接受 Outline）
 * @param {{seed?: number, attempts?: number, allowReuse?: boolean,
 *          difficultyTolerance?: number, now?: Date|string|number}} [options]
 * @returns {{paper: object, report: object}} 绝不抛错
 */
export function selectQuestions(bank, blueprint, options = {}) {
  const opts = normalizeOptions(options);
  const { bp, notes } = resolveBlueprint(blueprint);
  const prepared = prepareBank(bank);
  const ctx = buildContext(prepared.list, bp, opts);
  const generatedAt = resolveGeneratedAt(opts, opts.seed);

  const attempts = Math.max(1, opts.attempts);
  let best = null;
  for (let k = 0; k < attempts; k += 1) {
    const rng = createRng(mixSeed(opts.seed, k));
    const attempt = buildAttempt(ctx, rng, k);
    const cost = evaluateAttempt(attempt, ctx);
    if (!best || cost < best.cost) best = { cost, attempt, index: k };
  }

  const paperSections = bp.sections.map((sec, i) => ({
    ...sec,
    questions: (best.attempt.sections[i] || []).map((rec) => rec.q),
  }));

  const paper = {
    blueprint: bp,
    sections: paperSections,
    totalScore: paperSections.reduce(
      (sum, s) => sum + s.questions.reduce((a, rec) => a + rec.score, 0),
      0,
    ),
    plannedScore: bp.totalScore,
    generatedAt,
    seed: opts.seed,
  };

  const report = buildReport({
    bp,
    prepared,
    paperSections,
    usage: best.attempt.usage,
    ctx,
    seed: opts.seed,
    reused: best.attempt.reused,
    extraWarnings: notes,
  });

  return { paper, report };
}

/* ==================================================================== *
 * 报告
 * ==================================================================== */

function buildReport(args) {
  const { bp, prepared, paperSections, ctx, seed, reused, extraWarnings } = args;
  const warnings = [];
  const suggestions = [];

  const allRecs = paperSections.flatMap((s) => s.questions.map((q) => recOf(q)));
  const actualScore = allRecs.reduce((a, r) => a + r.score, 0);
  const plannedScore = bp.totalScore;

  // ---- 难度 ----
  const histogram = { easy: 0, medium: 0, hard: 0 };
  for (const rec of allRecs) {
    if (rec.difficulty < BAND_EASY_MAX) histogram.easy += 1;
    else if (rec.difficulty < BAND_MEDIUM_MAX) histogram.medium += 1;
    else histogram.hard += 1;
  }
  const actualDifficulty = actualScore > 0
    ? allRecs.reduce((a, r) => a + r.difficulty * r.score, 0) / actualScore
    : 0;

  // ---- 逐分区 ----
  const perSection = paperSections.map((sec, i) => {
    const recs = sec.questions.map((q) => recOf(q));
    const target = bp.sections[i];
    const scoreActual = recs.reduce((a, r) => a + r.score, 0);
    const scorePlanned = target.score > 0 ? target.score : target.count * target.scorePer;
    const avgDifficulty = recs.length > 0
      ? recs.reduce((a, r) => a + r.difficulty, 0) / recs.length
      : 0;
    const filled = recs.length;
    return {
      id: sec.id,
      type: sec.type,
      title: sec.title,
      needed: target.count,
      filled,
      avgDifficulty,
      targetDifficulty: target.difficulty,
      scorePlanned,
      scoreActual,
    };
  });

  // ---- 知识点覆盖 ----
  const coveredMap = new Map();
  for (const rec of allRecs) {
    for (const tag of rec.knowledge) coveredMap.set(tag, (coveredMap.get(tag) || 0) + rec.score);
  }
  const coverage = bp.knowledgePoints.map((kp) => {
    const required = Math.round(kp.weight * plannedScore);
    const used = coveredMap.get(kp.name) || 0;
    return {
      knowledge: kp.name,
      weight: kp.weight,
      required,
      used,
      satisfied: required <= 0 ? true : used >= required * (1 - COVERAGE_GRACE),
    };
  });

  // ---- warnings ----
  for (const w of extraWarnings || []) warnings.push(w);
  if (bp.sections.length === 0) {
    warnings.push('蓝图没有任何题型分区，无法组卷');
  }
  if (prepared.total === 0) {
    warnings.push('题库为空或全部题目不可用，无法组卷');
  } else if (prepared.ignored > 0) {
    warnings.push(`题库中有 ${prepared.ignored} 道题因题型无法识别或分值非法被忽略`);
  }
  for (const s of perSection) {
    if (s.filled < s.needed) {
      const missing = s.needed - s.filled;
      warnings.push(
        `「${s.title}」题量不足：需要 ${s.needed} 道，题库中该题型可用 ${poolSizeOf(ctx, s.type)} 道，`
        + `实得 ${s.filled} 道，缺 ${missing} 道`,
      );
    }
  }
  if (reused > 0) {
    warnings.push(
      `题库题目不足，本卷有 ${reused} 处重复用题（allowReuse=false 时同卷内默认不重复）`,
    );
  }
  for (const c of coverage) {
    if (!c.satisfied) {
      warnings.push(
        `知识点「${c.knowledge}」覆盖不足：目标 ${c.required} 分，实际覆盖 ${round1(c.used)} 分`,
      );
    }
  }
  if (plannedScore > 0 && Math.abs(actualScore - plannedScore) > 1e-9) {
    warnings.push(
      `实际总分 ${round1(actualScore)} 分与计划总分 ${round1(plannedScore)} 分相差 `
      + `${round1(actualScore - plannedScore)} 分`,
    );
  }

  // ---- suggestions ----
  const avgQuestionScore = allRecs.length > 0 ? actualScore / allRecs.length : 5;
  for (const c of coverage) {
    if (c.satisfied) continue;
    const deficit = c.required - c.used;
    const gap = Math.max(1, Math.ceil(deficit / Math.max(1, avgQuestionScore)));
    suggestions.push(
      `知识点「${c.knowledge}」题量不足，建议补充约 ${gap} 道（当前覆盖 ${round1(c.used)} 分 / 目标 ${c.required} 分）`,
    );
  }
  for (const s of perSection) {
    if (s.filled >= s.needed) continue;
    const missing = s.needed - s.filled;
    const poolSize = poolSizeOf(ctx, s.type);
    suggestions.push(
      `「${s.title}」缺 ${missing} 道，建议补充约 ${missing} 道难度接近 ${round2(s.targetDifficulty)} 的`
      + `${TYPE_LABELS[s.type] || s.type}（现有可用 ${poolSize} 道）`,
    );
  }
  if (allRecs.length > 0) {
    for (const s of perSection) {
      if (s.filled === 0) continue;
      const dev = s.avgDifficulty - s.targetDifficulty;
      if (Math.abs(dev) <= ctx.tolerance) continue;
      suggestions.push(
        `「${s.title}」实际平均难度 ${round2(s.avgDifficulty)} ${dev > 0 ? '高于' : '低于'}`
        + `目标 ${round2(s.targetDifficulty)}，建议调整该题型的难度分布`,
      );
    }
  }

  return {
    seed,
    score: {
      planned: plannedScore,
      actual: actualScore,
      deviation: actualScore - plannedScore,
    },
    difficulty: {
      target: bp.difficulty,
      actual: actualDifficulty,
      histogram,
    },
    coverage,
    perSection,
    warnings,
    suggestions,
  };
}

/** 某题型在题库中的可用题目数。 */
function poolSizeOf(ctx, type) {
  return (ctx.pools.get(type) || []).length;
}

/** 从题目对象反查归一记录（用于报告统计）。 */
const REC_CACHE = new WeakMap();
function recOf(q) {
  const cached = REC_CACHE.get(q);
  if (cached) return cached;
  let type = 'choice';
  try {
    type = normalizeType(q.type);
  } catch (err) {
    if (!(err instanceof ExamError)) throw err;
  }
  const rec = {
    q,
    id: typeof q.id === 'string' ? q.id : '',
    type,
    score: Number(q.score) > 0 ? Number(q.score) : 0,
    difficulty: difficultyToNumber(q.difficulty),
    knowledge: Array.isArray(q.knowledge)
      ? q.knowledge.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim())
      : [],
  };
  if (q && typeof q === 'object') REC_CACHE.set(q, rec);
  return rec;
}

/* ==================================================================== *
 * coverageReport
 * ==================================================================== */

/**
 * 只诊断题库能否支撑该蓝图，不组卷。
 * @param {Array<object>} bank 题库
 * @param {object} blueprint 命题蓝图（或 Outline）
 * @param {{difficultyTolerance?: number}} [options]
 * @returns {{
 *   feasible: boolean, totalQuestions: number, usableQuestions: number, ignoredQuestions: number,
 *   score: {available: number, required: number},
 *   sections: Array<object>, knowledge: Array<object>,
 *   warnings: string[], suggestions: string[],
 * }}
 */
export function coverageReport(bank, blueprint, options = {}) {
  const tolerance = Number.isFinite(Number(options && options.difficultyTolerance))
    ? Number(options.difficultyTolerance)
    : DEFAULT_DIFFICULTY_TOLERANCE;
  const { bp, notes } = resolveBlueprint(blueprint);
  const prepared = prepareBank(bank);
  const pools = new Map();
  for (const rec of prepared.list) {
    if (!pools.has(rec.type)) pools.set(rec.type, []);
    pools.get(rec.type).push(rec);
  }

  const warnings = [];
  const suggestions = [];

  const sections = bp.sections.map((sec) => {
    const pool = pools.get(sec.type) || [];
    const matched = pool.filter((rec) => Math.abs(rec.difficulty - sec.difficulty) <= tolerance);
    const knowledgePool = sec.knowledge.length > 0
      ? matched.filter((rec) => rec.knowledge.some((k) => sec.knowledge.includes(k)))
      : matched;
    const needed = sec.count;
    const available = pool.length;
    const difficultyMatched = matched.length;
    const knowledgeMatched = knowledgePool.length;
    const missing = Math.max(0, needed - available);
    const satisfied = available >= needed && difficultyMatched >= needed;
    return {
      id: sec.id,
      type: sec.type,
      title: sec.title,
      needed,
      available,
      difficultyTarget: sec.difficulty,
      difficultyMatched,
      knowledge: sec.knowledge.slice(),
      knowledgeMatched,
      missing,
      satisfied,
    };
  });

  const knowledge = bp.knowledgePoints.map((kp) => {
    const related = prepared.list.filter((rec) => rec.knowledge.includes(kp.name));
    const availableScore = related.reduce((a, r) => a + r.score, 0);
    const required = Math.round(kp.weight * bp.totalScore);
    return {
      knowledge: kp.name,
      weight: kp.weight,
      required,
      available: related.length,
      availableScore,
      satisfied: availableScore >= required,
    };
  });

  const availableScore = prepared.list.reduce((a, r) => a + r.score, 0);

  for (const n of notes) warnings.push(n);
  if (bp.sections.length === 0) warnings.push('蓝图没有任何题型分区，题库无法支撑该蓝图');
  if (prepared.total === 0) warnings.push('题库为空或全部题目不可用');
  else if (prepared.ignored > 0) warnings.push(`题库中有 ${prepared.ignored} 道题因题型无法识别或分值非法被忽略`);

  for (const s of sections) {
    if (s.available < s.needed) {
      warnings.push(
        `「${s.title}」题库可用 ${s.available} 道，蓝图需要 ${s.needed} 道，缺 ${s.missing} 道`,
      );
      suggestions.push(`建议补充约 ${s.missing} 道${TYPE_LABELS[s.type] || s.type}`);
    } else if (s.difficultyMatched < s.needed) {
      warnings.push(
        `「${s.title}」难度接近 ${round2(s.difficultyTarget)}（容差 ±${tolerance}）的题只有 `
        + `${s.difficultyMatched} 道，蓝图需要 ${s.needed} 道`,
      );
      suggestions.push(
        `建议为「${s.title}」补充约 ${s.needed - s.difficultyMatched} 道难度接近 ${round2(s.difficultyTarget)} 的题`,
      );
    }
    if (s.knowledge.length > 0 && s.knowledgeMatched < s.needed) {
      suggestions.push(
        `「${s.title}」指定知识点（${s.knowledge.join('、')}）可用题不足，建议补充约 `
        + `${s.needed - s.knowledgeMatched} 道`,
      );
    }
  }
  for (const k of knowledge) {
    if (k.satisfied) continue;
    warnings.push(
      `知识点「${k.knowledge}」题库可用分值 ${k.availableScore} 分，低于蓝图需求 ${k.required} 分`,
    );
    suggestions.push(
      `建议补充约 ${Math.max(1, Math.ceil((k.required - k.availableScore) / 5))} 道「${k.knowledge}」相关题目`,
    );
  }
  if (availableScore > 0 && availableScore < bp.totalScore) {
    warnings.push(
      `题库可用总分 ${round1(availableScore)} 分，低于蓝图总分 ${round1(bp.totalScore)} 分，必然需要重复用题`,
    );
  }

  const feasible = sections.every((s) => s.satisfied)
    && knowledge.every((k) => k.satisfied)
    && bp.sections.length > 0;

  return {
    feasible,
    totalQuestions: prepared.total,
    usableQuestions: prepared.list.length,
    ignoredQuestions: prepared.ignored,
    score: { available: availableScore, required: bp.totalScore },
    sections,
    knowledge,
    warnings,
    suggestions,
  };
}

/* ==================================================================== *
 * 选项与工具
 * ==================================================================== */

function normalizeOptions(options) {
  const o = (options && typeof options === 'object') ? options : {};
  const seed = Number.isFinite(Number(o.seed)) ? Math.trunc(Number(o.seed)) : DEFAULT_SEED;
  const attemptsRaw = Number(o.attempts);
  const attempts = Number.isFinite(attemptsRaw) && attemptsRaw > 0
    ? Math.min(500, Math.max(1, Math.floor(attemptsRaw)))
    : DEFAULT_ATTEMPTS;
  const tolRaw = Number(o.difficultyTolerance);
  const tolerance = Number.isFinite(tolRaw) && tolRaw >= 0 ? tolRaw : DEFAULT_DIFFICULTY_TOLERANCE;
  return {
    seed,
    attempts,
    allowReuse: o.allowReuse === true,
    tolerance,
    now: o.now !== undefined ? o.now : o.generatedAt,
  };
}

/**
 * 生成时刻：为保证「同 seed + 同输入 ⇒ 完全相同的 paper」，
 * 默认由 seed 确定性推导出一个合法 ISO 时间；需要真实时间时传 options.now。
 */
function resolveGeneratedAt(opts, seed) {
  if (opts.now !== undefined && opts.now !== null) {
    const d = opts.now instanceof Date ? opts.now : new Date(opts.now);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const offsetSeconds = Math.abs(Math.trunc(seed)) % (366 * 24 * 3600);
  return new Date(GENERATED_AT_BASE_MS + offsetSeconds * 1000).toISOString();
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
