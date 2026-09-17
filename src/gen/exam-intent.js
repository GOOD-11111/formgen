/**
 * 考卷类自然语言需求 → 命题蓝图输入（Outline）。
 *
 * 这是「教师大纲自适应生成考卷」的第一段：把老师随口说的一段话，
 * 变成结构化命题约束（题型/题量/分值/知识点/难度/时长），再交给 exam/blueprint.js 组卷。
 */

import { normalizeType } from '../exam/blueprint.js';

const SUBJECTS = ['数学', '语文', '英语', '物理', '化学', '生物', '历史', '地理', '政治', '信息技术', '科学'];
const GRADES = ['高一', '高二', '高三', '初一', '初二', '初三', '七年级', '八年级', '九年级', '小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级', '大学'];

/** 难度词 → 蓝图难度。 */
const DIFFICULTY_WORDS = [
  { re: /(非常难|极难|竞赛|压轴|拔高)/, value: 'hard' },
  { re: /(中等偏难|偏难|较难|有点难|提高)/, value: 'hard' },
  { re: /(中等偏易|偏易|较易|基础|容易|简单|入门)/, value: 'easy' },
  { re: /(中等|常规|一般|普通)/, value: 'medium' },
  { re: /(难易结合|梯度|混合|分层|由易到难)/, value: 'mixed' },
];

/** 中文数字 → 阿拉伯数字（题量、分值时常用）。 */
const CN_NUMBERS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十二: 12, 十五: 15, 二十: 20, 三十: 30 };

function toNumber(token) {
  if (token === undefined || token === null) return undefined;
  const text = String(token).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  if (CN_NUMBERS[text] !== undefined) return CN_NUMBERS[text];
  if (/^十[一二三四五六七八九]$/.test(text)) return 10 + CN_NUMBERS[text[1]];
  if (/^[二三]十[一二三四五六七八九]?$/.test(text)) {
    const tens = CN_NUMBERS[text[0]] * 10;
    return text[1] ? tens + CN_NUMBERS[text[1]] : tens;
  }
  return undefined;
}

/**
 * 解析题型段落。
 *
 * 覆盖这些说法：
 *   「选择题10道每题5分」「10道选择题，每小题5分」
 *   「填空 4 题 × 5 分」「解答题5题共60分」
 *   「包含选择题、填空题、解答题」（只有题型，没有数量 → 交给蓝图推导）
 *
 * 实现方式：先定位题型词，再取其**前后一个短窗口**做抽取。
 * 早先写成一个巨型正则试图一次命中所有词序，结果是「每题5分」永远落不到具体题型上，
 * 只能靠全局兜底给所有题型都盖 5 分——这会让总分配平彻底算错。
 */
export function parseSections(text) {
  const source = String(text ?? '');
  const TYPE_WORD = /(单项选择题|多项选择题|选择题|单选题|多选题|填空题|判断题|解答题|计算题|证明题|应用题|简答题|论述题|问答题|作文)/g;

  /** @type {Array<{type: string, count?: number, scorePer?: number, score?: number, title?: string}>} */
  const sections = [];
  const seen = new Set();

  let match;
  while ((match = TYPE_WORD.exec(source)) !== null) {
    const word = match[1];
    let canonical;
    try { canonical = normalizeType(word); }
    catch { continue; }
    // 同一题型只取第一次出现，避免「选择题要难一点」这类补充说明被当成第二段。
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    const start = match.index;
    const end = start + word.length;
    const before = source.slice(Math.max(0, start - 12), start);
    const after = source.slice(end, end + 22);

    const countAfter = /([一二三四五六七八九十两\d]+)\s*(?:道|题|个|小题)/.exec(after)?.[1];
    const countBefore = /([一二三四五六七八九十两\d]+)\s*(?:道|题|个|小题)?\s*$/.exec(before)?.[1];
    const count = toNumber(countAfter) ?? toNumber(countBefore);

    // 分值只看**题型词之后**的文本。「解答题5道」前面的窗口里躺着上一段的「每题5分」，
    // 一旦把它算进来，解答题就会被错误地钉死成 5 分/题，总分也就永远配不平。
    const perQuestion = /每(?:小)?题\s*([\d.]+)\s*分/.exec(after)?.[1]
      ?? /([\d.]+)\s*分\s*[/／]\s*(?:每)?(?:小)?题/.exec(after)?.[1];
    // 「共 N 分」/「总计 N 分」——这是该题型总分，不是每题分值
    const sectionTotal = /(?:共|总计|合计)\s*([\d.]+)\s*分/.exec(after)?.[1];

    const entry = { type: canonical, title: word };
    if (count !== undefined && count > 0) entry.count = count;

    const perValue = toNumber(perQuestion);
    const sumValue = toNumber(sectionTotal);
    if (perValue !== undefined && perValue > 0) entry.scorePer = perValue;
    else if (sumValue !== undefined && sumValue > 0 && count) entry.scorePer = Math.round((sumValue / count) * 100) / 100;
    if (sumValue !== undefined && sumValue > 0) entry.score = sumValue;

    sections.push(entry);
  }

  return sections;
}

/**
 * 按列举标点切分知识点。
 *
 * 「与 / 及 / 和」需要额外判断：它们既用于并列两个知识点（「函数与数列」），
 * 也出现在课程标准术语内部（「集合与常用逻辑用语」）。
 * 判断依据是两侧长度——「集合」+「常用逻辑用语」这种一侧明显更长的情况，
 * 说明它们是一个整体术语，不能切开。
 */
function splitKnowledgeList(raw) {
  const parts = String(raw).split(/[、,，\/]/);
  const out = [];

  for (const part of parts) {
    const text = part.trim();
    if (!text) continue;
    const segments = text.split(/(以及|和|与|及)/);
    if (segments.length <= 1) { out.push(text); continue; }

    const chunks = [];
    let buffer = [];
    for (const segment of segments) {
      if (['以及', '和', '与', '及'].includes(segment)) { chunks.push(buffer.join('')); buffer = []; }
      else buffer.push(segment);
    }
    chunks.push(buffer.join(''));

    const words = chunks.map(s => s.trim()).filter(Boolean);
    const shortEnough = words.length >= 2 && words.every(w => w.length <= 4);
    if (shortEnough) out.push(...words);
    else out.push(text);
  }
  return out;
}

/**
 * 解析知识点。
 *
 * 只认「覆盖 / 考查 / 涉及 / 知识点」这些**专指**触发词：
 * 「包含」太泛——「包含选择题10道每题5分」里的「包含」后面跟的是题型结构，不是知识点。
 * 因此这里既限定触发词，又对结果做题型/数量/难度词的过滤。
 */
export function parseKnowledgePoints(text) {
  const source = String(text ?? '');

  // 从后往前找：知识点通常在句末（「…覆盖函数、三角函数、数列」）。
  const TRIGGER = /(?:知识点[是为：:]?|覆盖|考查|考察|涉及)\s*([^。；;！!]+)/g;
  const captures = [];
  let match;
  while ((match = TRIGGER.exec(source)) !== null) captures.push(match[1]);
  if (!captures.length) return [];

  // 取最后一个捕获：越靠后越可能是真正的知识点列表。
  const raw = captures[captures.length - 1];

  return splitKnowledgeList(raw)
    .map(s => s.replace(/^(以及|还有|等|主要|重点|难点)+/, '').replace(/(等|部分|内容|知识|考点)+$/, '').trim())
    .filter(s => s.length >= 2 && s.length <= 12)
    // 把题型结构、分值、难度、格式要求一律排除
    .filter(s => !/(\d+\s*[道题个]|每(?:小)?题|每题|满分|总分|时长|分钟|难度|偏难|偏易|中等|简单|容易|基础|拔高|latex|公式|符号|排版)/i.test(s))
    .filter(s => !/^(选择|填空|判断|解答|计算|证明|应用|简答|论述|作文|题|道|分|\d+)$/.test(s))
    .slice(0, 12);
}

/** 解析考卷需求。 */
export function parseExamOutline(requirement) {
  const source = String(requirement ?? '').trim();
  if (!source) return { title: '', subject: '', grade: '', sections: [], knowledgePoints: [] };

  const subject = SUBJECTS.find(s => source.includes(s)) ?? '';
  const grade = GRADES.find(g => source.includes(g)) ?? '';

  const totalScoreMatch = /(?:满分|总分|共计|总计|共)\s*([\d]+)\s*分/.exec(source) ?? /([\d]{2,3})\s*分(?:的|制)?(?:试卷|考卷|卷子)/.exec(source);
  const durationMatch = /(?:考试时间|时长|时间|限时)\s*([\d]+)\s*(?:分钟|min)/.exec(source) ?? /([\d]+)\s*分钟/.exec(source);

  const difficulty = DIFFICULTY_WORDS.find(d => d.re.test(source))?.value;

  const titleMatch = /([^\s，,。；;]{2,24}?(?:测试卷|试卷|考卷|测验|期中卷|期末卷|卷子))/.exec(source);
  const title = titleMatch?.[1]?.replace(/^(?:帮我|请|给我|生成|出|做|来|要|需要|一份|一张|一个|个|份)+/, '').trim();

  const wantsLatex = /(latex|公式|数学公式|符号|方程|函数图像)/i.test(source);

  const outline = {
    title: title || ([grade, subject, '试卷'].filter(Boolean).join('') || '试卷'),
    subject,
    grade,
    sections: parseSections(source),
    knowledgePoints: parseKnowledgePoints(source),
  };

  const totalScore = toNumber(totalScoreMatch?.[1]);
  if (totalScore && totalScore >= 10 && totalScore <= 300) outline.totalScore = totalScore;

  const duration = toNumber(durationMatch?.[1]);
  if (duration && duration >= 10 && duration <= 300) outline.duration = duration;

  if (difficulty) outline.difficulty = difficulty;
  if (wantsLatex) outline.requiresLatex = true;

  fillMissingScorePer(outline);
  return outline;
}

/**
 * 补齐没写分值的题型。
 *
 * 这一步很关键：用户明确说了「选择题10道**每题5分**」，那 5 分就是硬约束，
 * 不能被总分配平算法改掉。正确做法是让**没写分值的题型**去吸收剩余分值——
 * 这也正是老师在脑子里算的那笔账：150 − 10×5 − 4×5 = 80，80 ÷ 5 = 每题 16 分。
 *
 * 不在这里补，蓝图就会为了凑 150 分把 5 分的选择题改成 8 分，直接违背用户明示。
 */
export function fillMissingScorePer(outline) {
  const total = outline.totalScore;
  const sections = outline.sections ?? [];
  if (!total || !sections.length) return outline;

  const pinned = sections.filter(s => s.scorePer !== undefined && s.count !== undefined);
  const unpinned = sections.filter(s => s.scorePer === undefined && s.count !== undefined);
  if (!unpinned.length || !pinned.length) return outline;

  const pinnedTotal = pinned.reduce((sum, s) => sum + s.count * s.scorePer, 0);
  const remaining = total - pinnedTotal;
  if (remaining <= 0) return outline;

  const unpinnedCount = unpinned.reduce((sum, s) => sum + s.count, 0);
  if (unpinnedCount <= 0) return outline;

  // 按题量比例分配，并把分值对齐到 0.5 分粒度（与蓝图配平算法的粒度一致）。
  let assigned = 0;
  unpinned.forEach((section, index) => {
    const isLast = index === unpinned.length - 1;
    const share = isLast
      ? remaining - assigned
      : Math.round((remaining * (section.count / unpinnedCount)) * 2) / 2;
    section.scorePer = Math.max(0.5, Math.round(share / section.count * 2) / 2);
    assigned += section.scorePer * section.count;
  });
  return outline;
}

/** 人读摘要，用于 CLI / API 回显「我理解到了什么」。 */
export function describeExamIntent(outline) {
  const bits = [];
  if (outline.grade || outline.subject) bits.push(`科目：${outline.grade}${outline.subject}`);
  if (outline.totalScore) bits.push(`满分：${outline.totalScore} 分`);
  if (outline.duration) bits.push(`时长：${outline.duration} 分钟`);
  if (outline.difficulty) bits.push(`难度：${outline.difficulty}`);
  if (outline.sections.length) {
    bits.push(`题型：${outline.sections.map(s => `${s.title ?? s.type}${s.count ? ` ${s.count} 题` : ''}${s.scorePer ? ` × ${s.scorePer} 分` : ''}`).join('，')}`);
  }
  if (outline.knowledgePoints.length) bits.push(`知识点：${outline.knowledgePoints.join('、')}`);
  if (outline.requiresLatex) bits.push('要求：含 LaTeX 公式');
  return bits;
}
