/**
 * 试卷 → FormSchema。
 *
 * 这一步让考卷复用整条已有的流水线：同一套渲染器渲染试卷，同一套校验器校验作答，
 * 同一套存储与导出处理成绩单。考卷不是特例，它是「一种字段类型为 question 的表单」。
 *
 * 一处有意的决定：**分值以命题蓝图为准**。
 * 题库里每道题自带的 score 只是它的默认值；一旦进入某张卷子的某个大题，
 * 它就值该大题的 `scorePer`。否则「满分 150」会因为题库分值与蓝图不一致而落空——
 * 对考试来说，总分对不上是硬错误，不是警告。
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 题干里下划线空的数量，用于填空题分格。 */
export function countBlanks(stem) {
  const matches = String(stem ?? '').match(/_{2,}|＿{2,}|\\underline\{\s*\}/g);
  return Math.max(1, matches ? matches.length : 1);
}

/**
 * 把题库题目的分值对齐到命题蓝图。
 *
 * 一道题一旦落进某个大题，它就值该大题的 `scorePer`——题库自带的 score 只是「这道题通常值多少分」。
 * 必须在**组卷之前**做这一步：否则选出来的卷子实际总分必然偏离计划总分，
 * 组卷报告只能报警告，而「满分 150 的卷子实际 124 分」对考试来说是硬错误。
 *
 * @param {Array<object>} bank
 * @param {object} blueprint
 */
export function alignBankToBlueprint(bank, blueprint) {
  const byType = new Map();
  for (const section of blueprint?.sections ?? []) {
    if (!byType.has(section.type)) byType.set(section.type, section);
  }
  return (bank ?? []).map(question => {
    const section = byType.get(question.type);
    if (!section || !(Number(section.scorePer) > 0)) return question;
    return { ...question, score: Number(section.scorePer) };
  });
}

/** 选项补上 A/B/C/D 标号；若题库里已带标号则先剥掉，避免出现「A. A. xxx」。 */
export function buildOptions(options) {
  return (options ?? []).map((option, index) => {
    const letter = LETTERS[index] ?? String(index + 1);
    const text = String(option).replace(new RegExp(`^\\s*${letter}\\s*[.、．)）:：]\\s*`), '').trim();
    return { value: letter, label: text || String(option) };
  });
}

/** 取一个稳定且合法的字段 key。 */
function toKey(question, used) {
  const base = `q_${String(question.id ?? '').replace(/[^A-Za-z0-9_\u4e00-\u9fa5]+/g, '_').replace(/^_+|_+$/g, '') || 'item'}`;
  let key = base;
  let n = 2;
  while (used.has(key)) key = `${base}_${n++}`;
  used.add(key);
  return key;
}

/**
 * @param {object} paper selectQuestions 的产出
 * @param {{sourceText?: string, instruction?: string, now?: string}} [options]
 * @returns {object} 可直接交给渲染器/校验器/评分器的 FormSchema
 */
export function paperToSchema(paper, options = {}) {
  const blueprint = paper.blueprint ?? {};
  const used = new Set();
  const groups = [];
  let questionNumber = 0;

  for (const section of paper.sections ?? []) {
    const scorePer = Number(section.scorePer) || 0;
    const fields = [];

    for (const question of section.questions ?? []) {
      questionNumber += 1;
      const isChoice = question.type === 'choice' || question.type === 'multi';
      const blanks = question.type === 'blank' ? countBlanks(question.stem) : undefined;

      fields.push({
        key: toKey(question, used),
        label: `第 ${questionNumber} 题`,
        type: 'question',
        required: false, // 考试允许留空交卷，是否作答由考生决定
        question: {
          id: question.id,
          type: question.type,
          stem: question.stem,
          ...(isChoice ? { options: buildOptions(question.options) } : {}),
          ...(question.answer !== undefined ? { answer: question.answer } : {}),
          ...(question.analysis ? { analysis: question.analysis } : {}),
          score: scorePer || Number(question.score) || 0,
          ...(Number.isFinite(question.difficulty) ? { difficulty: question.difficulty } : {}),
          ...(question.knowledge?.length ? { knowledge: question.knowledge } : {}),
          ...(blanks ? { blanks } : {}),
          ...(question.bank ? { source: question.bank } : {}),
        },
      });
    }

    if (!fields.length) continue;
    groups.push({
      key: section.id ?? `part_${groups.length + 1}`,
      title: section.title || section.type,
      description: `${fields.length} 题，每题 ${scorePer} 分，共 ${fields.length * scorePer} 分`,
      fields,
    });
  }

  if (!groups.length) {
    // 题库为空时也要给出一份可解释的「空卷」，而不是抛错——调用方靠 warnings 提示补充题库。
    groups.push({
      key: 'empty',
      title: '暂无可用题目',
      fields: [{
        key: 'empty_notice',
        label: '题库提示',
        type: 'statement',
        content: '题库中没有能匹配该命题蓝图的题目。请往 `banks/` 目录补充该学科/知识点的题目后重新组卷。',
      }],
    });
  }

  const plannedScore = Number(paper.plannedScore ?? blueprint.totalScore ?? 0);
  const schema = {
    version: 1,
    kind: 'exam',
    title: blueprint.title || options.title || '试卷',
    description: options.instruction ?? `本试卷共 ${groups.reduce((sum, g) => sum + g.fields.length, 0)} 题，满分 ${plannedScore} 分。`,
    locale: 'zh-CN',
    groups,
    settings: {
      submitText: '交卷',
      successMessage: '已交卷。客观题成绩已自动判定，主观题等待老师批阅。',
      allowMultipleSubmissions: true,
      showProgress: true,
      collectMeta: false,
      theme: 'exam',
      notice: blueprint.duration ? `考试时长 ${blueprint.duration} 分钟，请合理安排时间。` : undefined,
    },
    grading: {
      autoGrade: true,
      totalScore: plannedScore,
      ...(blueprint.duration ? { duration: blueprint.duration } : {}),
      blueprint: {
        subject: blueprint.subject,
        grade: blueprint.grade,
        difficulty: blueprint.difficulty,
        difficultyLabel: blueprint.difficultyLabel,
        knowledgePoints: blueprint.knowledgePoints,
        sections: (blueprint.sections ?? []).map(s => ({ type: s.type, title: s.title, count: s.count, scorePer: s.scorePer, score: s.score })),
        adjustments: blueprint.adjustments ?? [],
      },
    },
    meta: {
      createdAt: options.now ?? new Date().toISOString(),
      source: 'exam-pipeline',
      generator: 'blueprint+selection',
      ...(options.sourceText ? { sourceText: options.sourceText } : {}),
      ...(paper.seed !== undefined ? { seed: paper.seed } : {}),
      notes: [
        `按命题蓝图组卷，计划总分 ${plannedScore} 分`,
        ...(blueprint.adjustments ?? []),
      ],
    },
  };

  return schema;
}

/** 试卷的可读文本导出（供老师打印/校对）。 */
export function paperToText(paper) {
  const lines = [];
  const bp = paper.blueprint ?? {};
  lines.push(bp.title ?? '试卷');
  lines.push(`满分 ${bp.totalScore ?? paper.plannedScore} 分${bp.duration ? `　考试时间 ${bp.duration} 分钟` : ''}`);
  lines.push('');
  for (const section of paper.sections ?? []) {
    lines.push(`${section.title ?? section.type}（共 ${section.questions.length} 题，每题 ${section.scorePer} 分）`);
    for (const [index, question] of section.questions.entries()) {
      lines.push(`${index + 1}. ${question.stem}`);
      if (question.options?.length) {
        lines.push(question.options.map((option, i) => `   ${LETTERS[i]}. ${option}`).join('\n'));
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
