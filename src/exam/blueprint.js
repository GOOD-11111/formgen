/**
 * 命题蓝图（Blueprint）构建器 —— 考卷场景内核 ①
 * =====================================================================
 * 职责：把「教学大纲」（上层从自然语言解析出的结构化 Outline）编译成一份
 *       可执行的命题蓝图：题型分区、题量、每小题分值、难度目标、知识点权重，
 *       并硬性保证 `Σ (count × scorePer) === totalScore`。
 *
 * 完全自包含：零依赖，只使用 ECMAScript 内置能力；不认识表单 Schema，
 * 也不认识渲染层。上层（自然语言解析器）只需产出 Outline 形状的对象。
 *
 * 关键设计
 * --------
 * 1. 题型归一：中文别名（选择题/单选/填空/判断/解答/证明/论述…）→ 规范英文类型。
 * 2. 默认蓝图：`sections` 缺省时按「150 分制中学试卷常见配比表」等比推导，
 *    见 DEFAULT_BLUEPRINT_TABLE 注释。
 * 3. 总分配平：以 0.5 分为最小分值粒度做「最小相对偏差搜索」（动态规划），
 *    保持各题型相对分值权重，把余数让分值最大的题型吸收；万一题型题量导致
 *    总分不可达，再微调题量兜底。每一步都写进 `adjustments`（中文）。
 * 4. 非法输入抛 ExamError，`error.code` 为稳定的机器可读码。
 *
 * @typedef {'choice'|'multi'|'blank'|'judge'|'solve'|'proof'|'essay'} CanonicalType
 */

/* ==================================================================== *
 * 错误类型
 * ==================================================================== */

/** 稳定的机器可读错误码。 */
export const EXAM_ERROR_CODES = Object.freeze({
  INVALID_OUTLINE: 'BLUEPRINT_INVALID_OUTLINE',
  INVALID_TOTAL_SCORE: 'BLUEPRINT_INVALID_TOTAL_SCORE',
  EMPTY_SECTIONS: 'BLUEPRINT_EMPTY_SECTIONS',
  UNKNOWN_TYPE: 'BLUEPRINT_UNKNOWN_TYPE',
  INVALID_COUNT: 'BLUEPRINT_INVALID_COUNT',
  INVALID_SCORE: 'BLUEPRINT_INVALID_SCORE',
  UNBALANCEABLE: 'BLUEPRINT_UNBALANCEABLE',
});

/** 蓝图构建失败时抛出的错误；`code` 供上层程序判定，`message` 面向教师。 */
export class ExamError extends Error {
  /**
   * @param {string} code 机器可读错误码（见 EXAM_ERROR_CODES）
   * @param {string} message 中文说明
   * @param {unknown} [details] 附加诊断信息
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'ExamError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/* ==================================================================== *
 * 常量与题型归一
 * ==================================================================== */

/** 规范题型列表（顺序即默认蓝图的排版顺序）。 */
export const CANONICAL_TYPES = Object.freeze([
  'choice', 'multi', 'blank', 'judge', 'solve', 'proof', 'essay',
]);

/** 规范题型 → 中文名。 */
export const TYPE_LABELS = Object.freeze({
  choice: '选择题',
  multi: '多项选择题',
  blank: '填空题',
  judge: '判断题',
  solve: '解答题',
  proof: '证明题',
  essay: '论述题',
});

/** 中文别名 / 英文原样 → 规范题型。键均已 trim + 去空格 + 小写化。 */
const TYPE_ALIASES = new Map(Object.entries({
  // choice
  choice: 'choice', single: 'choice', singlechoice: 'choice',
  选择: 'choice', 选择题: 'choice', 单选: 'choice', 单选题: 'choice',
  单项选择题: 'choice', 单项选择: 'choice', 单选选择题: 'choice',
  // multi
  multi: 'multi', multiple: 'multi', multiplechoice: 'multi', multichoice: 'multi',
  多选: 'multi', 多选题: 'multi', 多项选择: 'multi', 多项选择题: 'multi', 复选题: 'multi',
  // blank
  blank: 'blank', fill: 'blank', fillblank: 'blank', fillintheblank: 'blank',
  填空: 'blank', 填空题: 'blank', 填充题: 'blank',
  // judge
  judge: 'judge', truefalse: 'judge', boolean: 'judge',
  判断: 'judge', 判断题: 'judge', 是非题: 'judge', 对错题: 'judge',
  // solve
  solve: 'solve', solution: 'solve', calculation: 'solve', application: 'solve',
  解答: 'solve', 解答题: 'solve', 计算题: 'solve', 应用题: 'solve',
  大题: 'solve', 综合题: 'solve',
  // proof
  proof: 'proof', prove: 'proof',
  证明: 'proof', 证明题: 'proof',
  // essay
  essay: 'essay', shortanswer: 'essay', writing: 'essay', discussion: 'essay',
  论述题: 'essay', 简答题: 'essay', 简答: 'essay', 作文: 'essay', 作文题: 'essay',
  问答题: 'essay', 问答: 'essay', 论述: 'essay',
}));

/**
 * 题型归一：中文别名 / 英文（大小写不敏感）→ 规范题型。
 * 允许「一、选择题」「2. 填空」这类带序号写法，也兼容全角括号补充说明。
 * @param {string} input
 * @returns {CanonicalType}
 * @throws {ExamError} code = BLUEPRINT_UNKNOWN_TYPE
 */
export function normalizeType(input) {
  if (typeof input !== 'string') {
    throw new ExamError(
      EXAM_ERROR_CODES.UNKNOWN_TYPE,
      `无法识别的题型：${describeValue(input)}`,
      input,
    );
  }
  const key = normalizeTypeKey(input);
  if (!key) {
    throw new ExamError(EXAM_ERROR_CODES.UNKNOWN_TYPE, '题型不能为空', input);
  }
  const hit = TYPE_ALIASES.get(key);
  if (hit) return hit;
  // 形如「选择题（单项）」「解答题(必做)」：只取主体再试一次
  const head = key.replace(/[（(【[].*$/, '');
  if (head && head !== key && TYPE_ALIASES.has(head)) return TYPE_ALIASES.get(head);
  // 形如「单选题型」：去掉尾部「型」再试一次
  if (head.endsWith('型') && TYPE_ALIASES.has(head.slice(0, -1))) {
    return TYPE_ALIASES.get(head.slice(0, -1));
  }
  throw new ExamError(
    EXAM_ERROR_CODES.UNKNOWN_TYPE,
    `无法识别的题型：${input}（支持 选择题/多选/填空/判断/解答/证明/论述 等写法）`,
    input,
  );
}

/** 归一化题型字符串：去序号、去空白、去标点、小写。 */
function normalizeTypeKey(input) {
  return String(input)
    .trim()
    // 去前缀序号：「一、」「1.」「(2)」
    .replace(/^[（(【[]?\s*[0-9一二三四五六七八九十]+\s*[)）】\].、,，:：]\s*/, '')
    .replace(/\s+/g, '')
    .replace(/[、,，。.；;：:]/g, '')
    .toLowerCase();
}

/* ==================================================================== *
 * 难度
 * ==================================================================== */

const DEFAULT_DIFFICULTY = 0.55;

/** 难度词 → 数值。 */
const DIFFICULTY_ALIASES = Object.freeze({
  easy: 0.25, medium: 0.55, hard: 0.82, mixed: 0.55,
  simple: 0.25, normal: 0.55, difficult: 0.82,
  简单: 0.25, 容易: 0.25, 易: 0.25, 基础: 0.28, 低: 0.25,
  中等: 0.55, 中档: 0.55, 一般: 0.55, 适中: 0.55, 普通: 0.55,
  较难: 0.75, 困难: 0.82, 难: 0.82, 高: 0.82,
  混合: 0.55, 综合: 0.6,
});

/**
 * 难度归一：'easy'→0.25 'medium'→0.55 'hard'→0.82 'mixed'→0.55，
 * 数值原样 clamp 到 0..1；无法识别的写法按「中等」处理（蓝图构建不因此报错）。
 * @param {string|number|undefined|null} d
 * @returns {number} 0..1
 */
export function difficultyToNumber(d) {
  if (typeof d === 'number') {
    if (!Number.isFinite(d)) return DEFAULT_DIFFICULTY;
    return clamp01(d);
  }
  if (typeof d === 'string') {
    const key = d.trim().toLowerCase();
    if (!key) return DEFAULT_DIFFICULTY;
    if (Object.prototype.hasOwnProperty.call(DIFFICULTY_ALIASES, key)) return DIFFICULTY_ALIASES[key];
    const n = Number(key);
    if (Number.isFinite(n)) return clamp01(n);
    return DEFAULT_DIFFICULTY;
  }
  return DEFAULT_DIFFICULTY;
}

/** 难度数值 → 标签。 */
function difficultyToLabel(d) {
  if (typeof d === 'string') {
    const key = d.trim().toLowerCase();
    if (key === 'easy' || key === 'medium' || key === 'hard' || key === 'mixed') return key;
  }
  const n = difficultyToNumber(d);
  if (n < 0.4) return 'easy';
  if (n < 0.7) return 'medium';
  return 'hard';
}

const DIFFICULTY_LABELS_CN = Object.freeze({
  easy: '容易', medium: '中等', hard: '较难', mixed: '混合',
});

/**
 * 各题型相对整卷难度的偏移：客观题略易、主观题略难，
 * 让「整卷难度中等」的蓝图天然带出合理的题型难度梯度。
 */
const TYPE_DIFFICULTY_OFFSET = Object.freeze({
  choice: -0.06, multi: 0.0, blank: -0.02, judge: -0.1,
  solve: 0.06, proof: 0.08, essay: 0.04,
});

/* ==================================================================== *
 * 默认蓝图配比表
 * ==================================================================== */

/**
 * 默认蓝图配比表（以「150 分制中学试卷」为基准，含题量与每题分值；`[count, scorePer]`）。
 *
 * 依据（中国中学 150 分制数学/理科卷的常见结构）：
 *  - 中等/混合卷：选择 12×5=60（40%）+ 填空 4×5=20（13.3%）+ 解答 5×14=70（46.7%）= 150，
 *    共 21 题。客观题约占 53%，主观解答题约占 47%，是 150 分制试卷最典型的结构。
 *  - 容易卷：提高客观题比重、降低解答题比重（选择 15×4=60 + 填空 6×5=30 + 解答 4×15=60），
 *    共 25 题，考查面更广、单题权重更低。
 *  - 较难卷：压缩客观题、加入证明题（选择 10×4=40 + 填空 4×5=20 + 解答 4×15=60 + 证明 2×15=30），
 *    共 20 题，主观题占比 60%，符合选拔性考试的结构。
 * 三档在 150 分处均能整分闭合；其他总分按 totalScore/150 等比缩放题量与分值，
 * 再由配平算法做 0.5 分粒度的最小偏差修正。
 */
const DEFAULT_BLUEPRINT_TABLE = Object.freeze({
  easy: Object.freeze([
    Object.freeze({ type: 'choice', count: 15, scorePer: 4 }),
    Object.freeze({ type: 'blank', count: 6, scorePer: 5 }),
    Object.freeze({ type: 'solve', count: 4, scorePer: 15 }),
  ]),
  medium: Object.freeze([
    Object.freeze({ type: 'choice', count: 12, scorePer: 5 }),
    Object.freeze({ type: 'blank', count: 4, scorePer: 5 }),
    Object.freeze({ type: 'solve', count: 5, scorePer: 14 }),
  ]),
  hard: Object.freeze([
    Object.freeze({ type: 'choice', count: 10, scorePer: 4 }),
    Object.freeze({ type: 'blank', count: 4, scorePer: 5 }),
    Object.freeze({ type: 'solve', count: 4, scorePer: 15 }),
    Object.freeze({ type: 'proof', count: 2, scorePer: 15 }),
  ]),
});

/** 配比表的基准总分。 */
const DEFAULT_TABLE_BASE_SCORE = 150;

/** 某题型缺失题量/分值时使用的常见默认值。 */
const TYPE_DEFAULTS = Object.freeze({
  choice: { count: 10, scorePer: 5 },
  multi: { count: 4, scorePer: 6 },
  blank: { count: 4, scorePer: 5 },
  judge: { count: 5, scorePer: 2 },
  solve: { count: 4, scorePer: 15 },
  proof: { count: 1, scorePer: 15 },
  essay: { count: 2, scorePer: 12 },
});

/** 分值最小粒度：0.5 分（0.5 在 IEEE754 中可精确表示，保证 `count*scorePer` 严格等于分区小计）。 */
const SCORE_STEP = 0.5;

/* ==================================================================== *
 * buildBlueprint
 * ==================================================================== */

/**
 * 构建命题蓝图。
 * @param {object} outline 大纲（字段均可缺省）
 * @returns {{
 *   title: string, subject: string, grade: string,
 *   totalScore: number, duration: number,
 *   difficulty: number, difficultyLabel: 'easy'|'medium'|'hard'|'mixed',
 *   knowledgePoints: Array<{name: string, weight: number}>,
 *   sections: Array<{
 *     id: string, type: CanonicalType, title: string,
 *     count: number, scorePer: number, score: number,
 *     difficulty: number, knowledge: string[],
 *   }>,
 *   adjustments: string[],
 * }}
 * @throws {ExamError} 非法输入
 */
export function buildBlueprint(outline) {
  if (outline === null || typeof outline !== 'object' || Array.isArray(outline)) {
    throw new ExamError(EXAM_ERROR_CODES.INVALID_OUTLINE, '大纲必须是一个对象');
  }

  const adjustments = [];
  const difficultyLabel = difficultyToLabel(outline.difficulty);
  const paperDifficulty = difficultyToNumber(outline.difficulty);

  // ---- 1. 分区归一（题型/题量/分值） ----------------------------------
  const rawSections = toRawSectionList(outline.sections);
  const prepared = rawSections.map((raw, i) => prepareSection(raw, i, paperDifficulty, adjustments));

  // ---- 2. 总分 --------------------------------------------------------
  let totalScore = parseExplicitTotalScore(outline.totalScore);
  if (totalScore === undefined) {
    if (prepared.length === 0) {
      throw new ExamError(
        EXAM_ERROR_CODES.EMPTY_SECTIONS,
        '大纲没有任何题型分区，且未给出 totalScore，无法推导命题蓝图',
      );
    }
    totalScore = prepared.reduce((sum, s) => sum + s.scoreTarget, 0);
    adjustments.push(`大纲未给出总分，已按各分区分值合计推导为 ${fmtScore(totalScore)} 分`);
  }
  // 对齐到 0.5 分粒度，保证配平结果可用浮点精确表示
  const aligned = roundScore(totalScore);
  if (aligned !== totalScore) {
    adjustments.push(`总分 ${fmtScore(totalScore)} 分不是 0.5 的整数倍，已就近取整为 ${fmtScore(aligned)} 分`);
  }
  totalScore = aligned;

  // ---- 3. 分区列表：缺省时按配比表推导 ---------------------------------
  const sections = prepared.length > 0
    ? prepared
    : deriveDefaultSections(totalScore, difficultyLabel, paperDifficulty, adjustments);

  // 总分过低时无法做到「每分区每题至少 1 分」，抬到最低可表示总分
  const minRepresentable = sections.length * 1; // 每个分区每题至少 1 分
  if (totalScore < minRepresentable) {
    const raised = roundScore(minRepresentable);
    adjustments.push(
      `总分 ${fmtScore(totalScore)} 分低于 ${sections.length} 个分区「每题至少 1 分」的最低要求，`
      + `已提升为 ${fmtScore(raised)} 分`,
    );
    totalScore = raised;
  }

  // ---- 4. 配平 --------------------------------------------------------
  balanceSections(sections, totalScore, adjustments);

  // ---- 5. 输出 --------------------------------------------------------
  const knowledgePoints = normalizeKnowledgePoints(outline.knowledgePoints, sections);
  const bpSections = sections.map((s, i) => ({
    id: `${i + 1}-${s.type}`,
    type: s.type,
    title: buildSectionTitle(s, i),
    count: s.count,
    scorePer: s.scorePer,
    score: s.count * s.scorePer,
    difficulty: s.difficulty,
    knowledge: s.knowledge.slice(),
  }));

  return {
    title: buildPaperTitle(outline),
    subject: str(outline.subject) || '通用',
    grade: str(outline.grade) || '',
    totalScore,
    duration: parseDuration(outline.duration, totalScore),
    difficulty: paperDifficulty,
    difficultyLabel,
    knowledgePoints,
    sections: bpSections,
    adjustments,
  };
}

/* ==================================================================== *
 * describeBlueprint
 * ==================================================================== */

/**
 * 生成中文人读摘要（多行文本），供教师端直接展示。
 * @param {object} bp buildBlueprint 的产物
 * @returns {string}
 */
export function describeBlueprint(bp) {
  if (!bp || typeof bp !== 'object' || !Array.isArray(bp.sections)) {
    return '（无效的命题蓝图）';
  }
  const lines = [];
  const gradePart = bp.grade ? ` · ${bp.grade}` : '';
  lines.push(`【${bp.title || '未命名试卷'}】${bp.subject || '通用'}${gradePart}`);
  lines.push(
    `总分 ${fmtScore(bp.totalScore)} 分 | 时长 ${fmtScore(bp.duration)} 分钟 | `
    + `整卷难度 ${fmtScore(bp.difficulty)}（${DIFFICULTY_LABELS_CN[bp.difficultyLabel] || '中等'}）`,
  );

  const kps = Array.isArray(bp.knowledgePoints) ? bp.knowledgePoints : [];
  if (kps.length > 0) {
    const parts = kps.map((k) => `${k.name} ${fmtPercent(k.weight)}`);
    lines.push(`知识点权重：${parts.join('、')}`);
  } else {
    lines.push('知识点权重：未指定');
  }

  lines.push('题型结构：');
  let total = 0;
  for (const s of bp.sections) {
    total += s.count * s.scorePer;
    const kn = Array.isArray(s.knowledge) && s.knowledge.length > 0
      ? `，知识点：${s.knowledge.join('、')}`
      : '';
    lines.push(
      `  ${s.title}：${s.count} 题 × ${fmtScore(s.scorePer)} 分 = ${fmtScore(s.count * s.scorePer)} 分`
      + `（难度 ${fmtScore(s.difficulty)}${kn}）`,
    );
  }
  lines.push(`合计 ${fmtScore(total)} 分，与设定总分 ${fmtScore(bp.totalScore)} 分一致`);

  const adj = Array.isArray(bp.adjustments) ? bp.adjustments : [];
  if (adj.length > 0) {
    lines.push(`配平调整（${adj.length} 处）：`);
    for (const a of adj) lines.push(`  - ${a}`);
  } else {
    lines.push('配平调整：无（大纲分值本身已闭合）');
  }
  return lines.join('\n');
}

/* ==================================================================== *
 * 内部：分区准备
 * ==================================================================== */

/** 把 sections 输入统一成对象数组（允许 '选择题' 这类纯字符串写法）。 */
function toRawSectionList(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (typeof raw === 'string') {
      out.push({ type: raw });
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      out.push(raw);
    }
    // 其余（null/数字/数组）静默忽略，不影响其它分区
  }
  return out;
}

/**
 * 归一单个分区：题型、题量、每题分值、难度、知识点，并记录推导过程。
 * @returns {{type: CanonicalType, count: number, scorePer: number, scoreTarget: number,
 *            explicitCount: boolean, explicitScorePer: boolean, difficulty: number,
 *            knowledge: string[], title: string|undefined}}
 */
function prepareSection(raw, index, paperDifficulty, adjustments) {
  const type = normalizeType(raw.type); // 无法识别 → 抛 BLUEPRINT_UNKNOWN_TYPE
  const label = TYPE_LABELS[type] || type;
  const defaults = TYPE_DEFAULTS[type];

  let count = readPositiveNumber(raw.count);
  if (raw.count !== undefined && raw.count !== null && count === undefined) {
    throw new ExamError(
      EXAM_ERROR_CODES.INVALID_COUNT,
      `第 ${index + 1} 个分区（${label}）的题量非法：${describeValue(raw.count)}，题量必须为正数`,
      raw,
    );
  }
  if (count !== undefined && !Number.isInteger(count)) {
    const rounded = Math.max(1, Math.round(count));
    adjustments.push(`${label}题量必须为整数，已由 ${fmtScore(count)} 道取整为 ${rounded} 道`);
    count = rounded;
  }

  let scorePer = readPositiveNumber(raw.scorePer);
  if (raw.scorePer !== undefined && raw.scorePer !== null && scorePer === undefined) {
    throw new ExamError(
      EXAM_ERROR_CODES.INVALID_SCORE,
      `第 ${index + 1} 个分区（${label}）的每题分值非法：${describeValue(raw.scorePer)}`,
      raw,
    );
  }
  let score = readPositiveNumber(raw.score);
  if (raw.score !== undefined && raw.score !== null && score === undefined) {
    throw new ExamError(
      EXAM_ERROR_CODES.INVALID_SCORE,
      `第 ${index + 1} 个分区（${label}）的分值非法：${describeValue(raw.score)}`,
      raw,
    );
  }

  const explicitCount = count !== undefined;
  const explicitScorePer = scorePer !== undefined;

  // 题量 / 分值 / 每题分值三者互相反推
  if (count === undefined && scorePer !== undefined && score !== undefined) {
    count = Math.max(1, Math.round(score / scorePer));
    adjustments.push(
      `${label}题量未给出，已按分值 ${fmtScore(score)} 分 ÷ 每题 ${fmtScore(scorePer)} 分反推为 ${count} 道`,
    );
  }
  if (count === undefined && score !== undefined) {
    count = Math.max(1, Math.round(score / defaults.scorePer));
    adjustments.push(
      `${label}题量未给出，已按分值 ${fmtScore(score)} 分与题型常见每题 ${fmtScore(defaults.scorePer)} 分反推为 ${count} 道`,
    );
  }
  if (scorePer === undefined && count !== undefined && score !== undefined) {
    const derived = score / count;
    scorePer = derived;
    adjustments.push(
      `${label}每题分值未给出，已按分值 ${fmtScore(score)} 分 ÷ ${count} 道推算为 ${fmtScore(derived)} 分`,
    );
  }
  if (count === undefined && scorePer === undefined) {
    count = defaults.count;
    scorePer = defaults.scorePer;
    adjustments.push(
      `${label}既未给出题量也未给出分值，已按题型常见配置 ${count} 道 × ${fmtScore(scorePer)} 分处理`,
    );
  } else if (count === undefined) {
    count = defaults.count;
    adjustments.push(`${label}题量未给出，已按题型常见题量取 ${count} 道`);
  } else if (scorePer === undefined) {
    scorePer = defaults.scorePer;
    adjustments.push(`${label}每题分值未给出，已按题型常见每题 ${fmtScore(scorePer)} 分处理`);
  }

  // 分值目标：显式分值优先，其次 题量 × 每题分值
  const scoreTarget = score !== undefined ? score : count * scorePer;

  const sectionDifficulty = raw.difficulty === undefined || raw.difficulty === null
    ? clamp01(paperDifficulty + (TYPE_DIFFICULTY_OFFSET[type] || 0))
    : difficultyToNumber(raw.difficulty);

  return {
    type,
    count,
    scorePer,
    scoreTarget,
    explicitCount,
    explicitScorePer,
    difficulty: sectionDifficulty,
    knowledge: normalizeKnowledgeList(raw.knowledge),
    title: str(raw.title) || undefined,
  };
}

/** 缺省 sections 时按配比表推导。 */
function deriveDefaultSections(totalScore, difficultyLabel, paperDifficulty, adjustments) {
  const row = DEFAULT_BLUEPRINT_TABLE[difficultyLabel] || DEFAULT_BLUEPRINT_TABLE.medium;
  const scale = totalScore / DEFAULT_TABLE_BASE_SCORE;
  const sections = row.map((item) => ({
    type: item.type,
    count: Math.max(1, Math.round(item.count * scale)),
    scorePer: item.scorePer,
    // 分值目标按比例缩放，保证「保持相对分值权重」
    scoreTarget: item.count * item.scorePer * scale,
    explicitCount: false,
    explicitScorePer: false,
    difficulty: clamp01(paperDifficulty + (TYPE_DIFFICULTY_OFFSET[item.type] || 0)),
    knowledge: [],
    title: undefined,
  }));
  adjustments.push(
    `大纲未给出题型分区，已按「150 分制中学试卷常见配比表（${DIFFICULTY_LABELS_CN[difficultyLabel] || '中等'}档）」`
    + `等比推导出 ${sections.length} 个分区`,
  );
  return sections;
}

/* ==================================================================== *
 * 内部：总分配平
 * ==================================================================== */

/**
 * 总分配平：使 `Σ (count × scorePer) === totalScore`。
 *
 * 策略（与需求一致）：
 *  ① 保持各题型相对分值权重 —— 以各分区的「理想分值」按比例缩放到 totalScore 得到目标；
 *  ② 微调 scorePer 为整数（最小粒度 0.5 分，优先整数分值）；
 *  ③ 余数交给分值最大的题型吸收 —— 目标函数是最小化相对偏差平方和，绝对分值越大、
 *     相对偏差越小，因此余数天然落在分值最大的题型上；
 *  ④ 若题型题量使总分在 0.5 分粒度下不可达（如各分区题量公因数不整除总分），
 *     再微调某个分区的题量兜底。
 * 每一步变更都写入 adjustments（中文）。
 */
function balanceSections(sections, totalScore, adjustments) {
  const U = Math.round(totalScore * 2); // 以 0.5 分为单位的整数总分

  // 快路径：各分区已显式给出题量与每题分值，且小计恰好等于总分 → 原样保留
  const allExplicit = sections.every((s) => s.explicitCount && s.explicitScorePer);
  const explicitSum = sections.reduce((sum, s) => sum + s.count * s.scorePer, 0);
  if (allExplicit && explicitSum === totalScore) {
    return;
  }

  // 理想分值（0.5 分单位的实数）
  let weights = sections.map((s) => s.scoreTarget);
  let weightSum = weights.reduce((a, b) => a + b, 0);
  if (!(weightSum > 0)) {
    weights = sections.map((s) => s.count);
    weightSum = weights.reduce((a, b) => a + b, 0);
  }
  if (!(weightSum > 0)) {
    weights = sections.map(() => 1);
    weightSum = sections.length;
  }
  const targets = weights.map((w) => (U * w) / weightSum);

  // ---- 主搜索 ----
  let h = searchAllocation(sections, U, targets);

  // ---- 兜底：微调题量使总分可达 ----
  let countFix = null;
  if (!h) {
    countFix = repairSectionCount(sections, U, targets);
    if (countFix) h = countFix.h;
  }
  if (!h) {
    // 极端兜底：把分值最大的分区题量调整为剩余需求量的约数（必定存在解）
    const L = pickLargestTargetIndex(targets);
    const others = sumExcept(sections, targets, L, null);
    const need = U - others;
    if (need >= 2) {
      let best = null;
      for (let c = 1; c <= need; c += 1) {
        if (need % c !== 0) continue;
        const hv = need / c;
        if (hv < 2) continue;
        const diff = Math.abs(c - sections[L].count);
        if (!best || diff < best.diff) best = { c, hv, diff };
      }
      if (best) {
        countFix = { L, from: sections[L].count, to: best.c, h: null };
        sections[L].count = best.c;
        h = searchAllocation(sections, U, targets);
      }
    }
  }
  if (!h) {
    throw new ExamError(
      EXAM_ERROR_CODES.UNBALANCEABLE,
      `无法将各题型小计配平到总分 ${fmtScore(totalScore)} 分，请调整题量或总分`,
      { totalScore, sections: sections.map((s) => ({ type: s.type, count: s.count, scorePer: s.scorePer })) },
    );
  }

  // ---- 落地 + 记录调整 ----
  if (countFix) {
    const label = TYPE_LABELS[sections[countFix.L].type] || sections[countFix.L].type;
    adjustments.push(
      `为使总分精确等于 ${fmtScore(totalScore)} 分，${label}题量由 ${countFix.from} 道调整为 ${sections[countFix.L].count} 道`,
    );
  }

  sections.forEach((s, i) => {
    const beforePer = s.scorePer;
    const beforeCount = s.count;
    const newPer = h[i] / 2;
    const label = TYPE_LABELS[s.type] || s.type;
    // 题量可能在 repair 阶段被改过
    if (!countFix || countFix.L !== i) {
      if (s.count !== beforeCount) {
        adjustments.push(`${label}题量由 ${beforeCount} 道调整为 ${s.count} 道以配平总分`);
      }
    }
    s.scorePer = newPer;
    if (beforePer !== newPer) {
      adjustments.push(
        `${label}每小题分值由 ${fmtScore(beforePer)} 分调整为 ${fmtScore(newPer)} 分以配平总分`,
      );
    }
  });
}

/**
 * 动态规划搜索：找一组 h[i]（0.5 分单位的 2 倍，即 h = 2 × scorePer 的整数表示），
 * 使 `Σ count[i] × h[i] === U`，且相对理想分值的偏差平方和最小。
 * @returns {number[]|null} h 数组；无精确解返回 null
 */
function searchAllocation(sections, U, targets) {
  const n = sections.length;
  if (n === 0 || U < 0) return null;
  const INF = Number.POSITIVE_INFINITY;
  let prevCost = new Float64Array(U + 1).fill(INF);
  prevCost[0] = 0;
  /** @type {Int32Array[]} */
  const picks = [];

  for (let i = 0; i < n; i += 1) {
    const c = sections[i].count;
    const ideal = targets[i];
    const hi = Math.max(2, Math.ceil(ideal / c) + 6);
    const curCost = new Float64Array(U + 1).fill(INF);
    const pick = new Int32Array(U + 1);
    for (let j = 0; j <= U; j += 1) {
      const base = prevCost[j];
      if (base === INF) continue;
      const maxH = Math.min(hi, Math.floor((U - j) / c));
      for (let hv = 2; hv <= maxH; hv += 1) {
        const nj = j + c * hv;
        const cost = base + sectionCost(ideal, c, hv, sections[i]);
        if (cost < curCost[nj]) {
          curCost[nj] = cost;
          pick[nj] = hv;
        }
      }
    }
    picks.push(pick);
    prevCost = curCost;
  }

  if (prevCost[U] === INF) return null;
  const h = new Array(n);
  let j = U;
  for (let i = n - 1; i >= 0; i -= 1) {
    const hv = picks[i][j];
    h[i] = hv;
    j -= sections[i].count * hv;
  }
  return j === 0 ? h : null;
}

/** 单分区代价：相对理想分值的偏差平方 + 轻微偏好整数分值。 */
function sectionCost(ideal, count, hv, section) {
  const got = count * hv;
  const dev = (got - ideal) / Math.max(1, ideal);
  let cost = dev * dev;
  // 偏好整数分值（h 为偶数 ⇔ scorePer 为整数），但显式给出的 0.5 分值不做惩罚
  if (hv % 2 !== 0 && !section.explicitScorePer) cost += 0.0025;
  return cost;
}

/** 微调某个分区的题量，使总分在 0.5 分粒度下可达。 */
function repairSectionCount(sections, U, targets) {
  const order = sections
    .map((_, i) => i)
    .sort((a, b) => targets[b] - targets[a] || a - b);
  let budget = 64;
  for (const L of order) {
    for (let k = 1; k <= 24 && budget > 0; k += 1) {
      for (const nc of [sections[L].count + k, sections[L].count - k]) {
        if (nc < 1 || nc === sections[L].count) continue;
        const saved = sections[L].count;
        sections[L].count = nc;
        budget -= 1;
        const h = searchAllocation(sections, U, targets);
        if (h) return { L, from: saved, to: nc, h };
        sections[L].count = saved;
      }
    }
  }
  return null;
}

/** 其余分区的分值合计（h 为 null 时按当前 scorePer 估算）。 */
function sumExcept(sections, targets, skipIndex, h) {
  let sum = 0;
  for (let i = 0; i < sections.length; i += 1) {
    if (i === skipIndex) continue;
    sum += h ? sections[i].count * h[i] : Math.round(targets[i]);
  }
  return sum;
}

/** 理想分值最大的分区下标（并列取靠前者）。 */
function pickLargestTargetIndex(targets) {
  let best = 0;
  for (let i = 1; i < targets.length; i += 1) {
    if (targets[i] > targets[best]) best = i;
  }
  return best;
}

/* ==================================================================== *
 * 内部：知识点、标题、字段读取
 * ==================================================================== */

/** 知识点权重归一（总和为 1）；缺省时从各分区 knowledge 标签推导。 */
function normalizeKnowledgePoints(input, sections) {
  const acc = new Map();
  const push = (name, weight) => {
    const key = str(name);
    if (!key) return;
    const w = typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 0;
    acc.set(key, (acc.get(key) || 0) + w);
  };

  if (Array.isArray(input) && input.length > 0) {
    for (const item of input) {
      if (typeof item === 'string') push(item, 0);
      else if (item && typeof item === 'object') push(item.name, item.weight);
    }
  }

  if (acc.size === 0) {
    // 从各分区知识点标签推导（按出现次数计权）
    for (const s of sections) {
      for (const k of s.knowledge) push(k, 1);
    }
  }

  const names = [...acc.keys()];
  if (names.length === 0) return [];
  let sum = 0;
  for (const name of names) sum += acc.get(name);
  if (!(sum > 0)) {
    // 全部缺省权重 → 等权
    const w = 1 / names.length;
    return names.map((name) => ({ name, weight: w }));
  }
  return names.map((name) => ({ name, weight: acc.get(name) / sum }));
}

/** 分区标题：优先用给定标题，否则「中文序号、题型名」。 */
function buildSectionTitle(section, index) {
  const ordinal = cnOrdinal(index + 1);
  const base = section.title || TYPE_LABELS[section.type] || section.type;
  if (/^[一二三四五六七八九十百]+[、.．]/.test(base)) return base;
  return `${ordinal}、${base}`;
}

/** 中文序号：1..99。 */
function cnOrdinal(n) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (!Number.isFinite(n) || n < 1) return String(n);
  if (n <= 10) return n === 10 ? '十' : digits[n];
  if (n < 20) return `十${digits[n % 10]}`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${digits[tens]}十${ones ? digits[ones] : ''}`;
}

function buildPaperTitle(outline) {
  const explicit = str(outline.title);
  if (explicit) return explicit;
  const subject = str(outline.subject);
  const grade = str(outline.grade);
  if (subject || grade) return `${grade}${subject}考试卷`;
  return '考试卷';
}

function normalizeKnowledgeList(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const item of input) {
    const name = typeof item === 'string'
      ? str(item)
      : (item && typeof item === 'object' ? str(item.name) : '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 解析显式给出的 totalScore；非法（<=0 / 非数字）抛错，未给出返回 undefined。 */
function parseExplicitTotalScore(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^\d.+-]/g, ''));
  if (!Number.isFinite(n)) {
    throw new ExamError(
      EXAM_ERROR_CODES.INVALID_TOTAL_SCORE,
      `总分非法：${describeValue(raw)}，总分必须是正数`,
      raw,
    );
  }
  if (n <= 0) {
    throw new ExamError(
      EXAM_ERROR_CODES.INVALID_TOTAL_SCORE,
      `总分必须大于 0，当前为 ${describeValue(raw)}`,
      raw,
    );
  }
  return n;
}

function parseDuration(raw, totalScore) {
  const n = readPositiveNumber(raw);
  if (n !== undefined) return n;
  // 缺省：按 150 分 ≈ 120 分钟的比例估算，取 5 分钟整数倍，最少 30 分钟
  const guess = Math.max(30, Math.round((totalScore * 0.8) / 5) * 5);
  return guess;
}

/** 读取正数；非正数或非数字返回 undefined。 */
function readPositiveNumber(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function str(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

function clamp01(n) {
  if (!Number.isFinite(n)) return DEFAULT_DIFFICULTY;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** 就近对齐到 0.5 分粒度。 */
function roundScore(n) {
  return Math.round(n / SCORE_STEP) * SCORE_STEP;
}

/** 分值展示：整数不带小数点，其余最多两位小数。 */
function fmtScore(n) {
  if (!Number.isFinite(n)) return String(n);
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}

function fmtPercent(w) {
  if (!Number.isFinite(w)) return '0%';
  return `${Math.round(w * 1000) / 10}%`;
}

function describeValue(v) {
  if (typeof v === 'string') return `“${v}”`;
  if (v === null) return 'null';
  if (Array.isArray(v)) return `数组(长度 ${v.length})`;
  return String(v);
}
