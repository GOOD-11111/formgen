/**
 * 生成通道编排：规则引擎与 LLM 如何协作。
 *
 * 三条策略，对应三种真实场景：
 *   rule    —— 内网/无 key/需要确定性与可解释性时。永远可用。
 *   llm     —— 需求表达自由、需要语义理解时。
 *   auto    —— 默认：LLM 可用就用，失败则**带原因**降级到规则通道，用户总能拿到表单。
 *
 * 两条通道产出同一种 FormSchema，因此可以互相比较——这是本项目想验证的一件事：
 * 大模型不是「更聪明的手」，规则也不是「过时的兜底」，二者在同一个 IR 上是可以协作的。
 */

import { parseRequirement, detectDomain } from './nlp.js';
import { generateWithLlm, isLlmConfigured, resolveLlmConfig } from './llm.js';
import { parseExamOutline } from './exam-intent.js';
import { walkFields } from '../core/schema.js';
import { FormgenError } from '../core/errors.js';

/** 只走规则通道（同步、确定性）。 */
export function generateByRule(requirement, options = {}) {
  const result = parseRequirement(requirement, options);
  return {
    kind: 'form',
    schema: result.schema,
    issues: result.issues,
    understanding: result.understanding,
    channel: 'rule',
  };
}

/** 解析考卷需求为命题大纲（不组卷，组卷由 exam 模块负责）。 */
export function planExam(requirement, options = {}) {
  const outline = parseExamOutline(requirement);
  return {
    kind: 'exam',
    outline,
    channel: 'rule',
    issues: [],
    understanding: {
      domain: 'exam',
      domainLabel: '考卷',
      title: outline.title,
      fieldCount: 0,
      groupCount: 0,
      notes: [],
      sourceText: String(requirement ?? '').trim(),
      ...(options.extra ?? {}),
    },
  };
}

/**
 * 统一入口。
 *
 * @param {string} requirement
 * @param {{mode?: 'auto'|'rule'|'llm'|'exam', onEvent?: (e: object) => void,
 *          apiKey?: string, baseUrl?: string, model?: string, allowFallback?: boolean}} [options]
 */
export async function generate(requirement, options = {}) {
  const text = String(requirement ?? '').trim();
  if (!text) throw new FormgenError('NLP_EMPTY_INPUT', '需求文本为空');

  const emit = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const mode = options.mode ?? 'auto';
  const domain = detectDomain(text);

  // 考卷需求走独立流水线（组卷需要题库，见 exam/ 目录）
  if (mode === 'exam' || (mode === 'auto' && domain.domain === 'exam')) {
    return planExam(text, options);
  }

  if (mode === 'rule') return generateByRule(text, options);

  if (mode === 'llm') {
    const { schema, issues, model, attempts, usage } = await generateWithLlm(text, options);
    return { kind: 'form', schema, issues, channel: 'llm', llm: { model, attempts, usage }, understanding: summarize(schema, text) };
  }

  // auto：先试 LLM，失败降级到规则，并把失败原因如实带回去。
  if (!isLlmConfigured(options)) {
    const result = generateByRule(text, options);
    result.fallback = {
      from: 'llm',
      code: 'LLM_NOT_CONFIGURED',
      reason: '未配置模型 API Key（环境变量 DEEPSEEK_API_KEY），已使用内置规则引擎解析',
    };
    emit({ type: 'fallback', ...result.fallback });
    return result;
  }

  try {
    const { schema, issues, model, attempts, usage } = await generateWithLlm(text, options);
    return { kind: 'form', schema, issues, channel: 'llm', llm: { model, attempts, usage }, understanding: summarize(schema, text) };
  } catch (error) {
    if (options.allowFallback === false) throw error;
    const result = generateByRule(text, options);
    result.fallback = {
      from: 'llm',
      code: error instanceof FormgenError ? error.code : 'LLM_FAILED',
      reason: error instanceof Error ? error.message : String(error),
    };
    emit({ type: 'fallback', ...result.fallback });
    return result;
  }
}

function summarize(schema, sourceText) {
  let fieldCount = 0;
  for (const _ of walkFields(schema)) fieldCount += 1;
  return {
    domain: 'form',
    domainLabel: '表单',
    title: schema.title,
    fieldCount,
    groupCount: schema.groups.length,
    notes: schema.meta?.notes ?? [],
    sourceText,
  };
}

/**
 * 对比两条通道的产出。
 *
 * 这个函数本身就是项目主张的一部分：同一份需求，规则通道与大模型通道各自理解成什么？
 * 差异恰恰暴露了模型的自由度与规则的天花板——对做低代码产品的人来说，这比「谁更好」有用。
 */
export function compareChannels(ruleResult, llmResult) {
  const flatten = result => {
    const map = new Map();
    if (!result?.schema) return map;
    for (const { field } of walkFields(result.schema)) map.set(field.label, field);
    return map;
  };

  const ruleFields = flatten(ruleResult);
  const llmFields = flatten(llmResult);

  const onlyInRule = [...ruleFields.keys()].filter(label => !llmFields.has(label));
  const onlyInLlm = [...llmFields.keys()].filter(label => !ruleFields.has(label));
  const typeDiffs = [];
  for (const [label, ruleField] of ruleFields) {
    const llmField = llmFields.get(label);
    if (llmField && llmField.type !== ruleField.type) {
      typeDiffs.push({ label, rule: ruleField.type, llm: llmField.type });
    }
  }

  const logicCount = map => [...map.values()].filter(f => f.visibleWhen || f.compute).length;

  return {
    rule: {
      title: ruleResult?.schema?.title,
      fieldCount: ruleFields.size,
      logicCount: logicCount(ruleFields),
      optionsCount: [...ruleFields.values()].filter(f => (f.options ?? []).length).length,
    },
    llm: {
      title: llmResult?.schema?.title,
      fieldCount: llmFields.size,
      logicCount: logicCount(llmFields),
      optionsCount: [...llmFields.values()].filter(f => (f.options ?? []).length).length,
    },
    onlyInRule,
    onlyInLlm,
    typeDiffs,
    verdict: buildVerdict(ruleFields.size, llmFields.size, onlyInLlm.length, logicCount(llmFields) - logicCount(ruleFields)),
  };
}

function buildVerdict(ruleCount, llmCount, extraFromLlm, extraLogic) {
  const parts = [];
  if (llmCount > ruleCount) parts.push(`大模型补充了 ${llmCount - ruleCount} 个规则引擎未识别的字段`);
  else if (llmCount < ruleCount) parts.push(`规则引擎多识别出 ${ruleCount - llmCount} 个字段`);
  else parts.push('两条通道字段数量一致');

  if (extraFromLlm > 0) parts.push(`其中 ${extraFromLlm} 个是规则词典没有覆盖的表达`);
  if (extraLogic > 0) parts.push(`大模型多产出了 ${extraLogic} 处条件/计算逻辑`);
  else if (extraLogic < 0) parts.push(`规则引擎多产出了 ${-extraLogic} 处条件/计算逻辑`);

  return parts.join('；') + '。';
}
