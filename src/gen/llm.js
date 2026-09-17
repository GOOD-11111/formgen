/**
 * 自然语言 → FormSchema（大模型通道）。
 *
 * 定位：处理规则引擎覆盖不了的表达——「帮我设计一份能筛出高意向客户的问卷，
 * 问题要能让销售在 30 秒内判断跟进优先级」这类**意图性**需求，
 * 规则词典无能为力，但模型的语义理解可以。
 *
 * 工程上的克制：
 *   - 模型只被允许产出 FormSchema JSON，不产出代码、不产出 HTML；
 *     渲染与校验始终由本引擎负责，模型无法把不可控的东西塞进运行时。
 *   - 产出必须通过与规则通道完全相同的 `normalizeSchema` 校验；
 *     失败时把**具体错误**回灌给模型重试一次（自修复），再失败就交给上层降级。
 *   - 不配置 key 时整条链路静默不可用，绝不影响离线能力。
 */

import { normalizeSchema, FIELD_TYPES } from '../core/schema.js';
import { FormgenError } from '../core/errors.js';

export const DEFAULT_LLM_CONFIG = Object.freeze({
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  timeoutMs: 90_000,
  temperature: 0.2,
});

/** 合并配置：显式参数 > 环境变量 > 默认值。 */
export function resolveLlmConfig(overrides = {}) {
  const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
  return {
    apiKey: overrides.apiKey || env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || '',
    baseUrl: (overrides.baseUrl || env.FORMGEN_BASE_URL || env.DEEPSEEK_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_LLM_CONFIG.baseUrl).replace(/\/+$/, ''),
    model: overrides.model || env.FORMGEN_MODEL || env.DEEPSEEK_MODEL || DEFAULT_LLM_CONFIG.model,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_LLM_CONFIG.timeoutMs,
    temperature: overrides.temperature ?? DEFAULT_LLM_CONFIG.temperature,
  };
}

/** 是否具备调用条件。上层据此决定走 LLM 还是直接走规则通道。 */
export function isLlmConfigured(overrides = {}) {
  return Boolean(resolveLlmConfig(overrides).apiKey);
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

const CONTRACT = `
你是一个表单架构师。用户会用自然语言描述他想要的一个数据收集工具，
你要把它翻译成一份 **FormSchema JSON**。你只输出 JSON，不输出任何解释、注释或 Markdown 代码块标记。

## FormSchema 结构

{
  "title": "表单标题（简短、具体，如「员工入职信息收集表」）",
  "kind": "form | survey | exam | registration | feedback | collection",
  "description": "一句话说明这张表的用途（可选）",
  "groups": [
    {
      "key": "分组英文key，小写字母下划线（可选，会自动生成）",
      "title": "分组标题，如「基本信息」（可选）",
      "fields": [ Field, ... ]
    }
  ],
  "settings": { "submitText": "提交按钮文案", "successMessage": "提交成功提示" }
}

## Field 结构

{ "key": "英文字段名", "label": "中文字段标签", "type": "字段类型", ...类型专属属性 }

必填：key、label、type。

字段类型只能是以下 ${FIELD_TYPES.length} 种之一：
${FIELD_TYPES.join(', ')}

各类型的专属属性：
- text / textarea：minLength, maxLength, placeholder, rows(textarea), pattern(正则字符串), patternMessage
- number / integer：min, max, step, unit, precision
- tel：placeholder（手机号，引擎已内置 11 位校验）
- email / url / idcard：无额外属性
- date / datetime / time：minDate, maxDate
- select：options, multiple(布尔，true 时下拉多选)
- radio：options, inline
- checkbox：options, min, max, inline
- switch：onLabel, offLabel
- rating：min, max（如 1-5 星）
- slider：min, max, step, unit
- file：accept(MIME 或扩展名，多个用逗号), multiple, maxSizeMB, maxFiles
- section：仅作分组小标题，不收集数据
- statement：仅作说明文字，用 content 属性给出内容
- matrix：rows(行数组), options(列选项)，用于满意度矩阵量表
- question：考卷题目，用 question 属性承载 { id, type, stem, options, answer, analysis, score, difficulty, knowledge }

所有字段通用属性：
- required: true 表示必填
- help: 填写说明
- placeholder: 占位提示
- defaultValue: 默认值
- visibleWhen: **字符串表达式**，满足时该字段才显示
- compute: **字符串表达式**，该字段为自动计算（只读）

## 表达式语法（visibleWhen / compute / rules 用）

- 变量就是字段 key，例如 \`department == "技术部"\`
- 支持：\`+ - * / %\`、\`== != < <= > >=\`、\`&& || !\`、\`in\`、\`not in\`、\`? :\` 不支持（用 if()）
- 函数：len, sum, avg, min, max, abs, round(x,n), floor, ceil, num, str, bool, empty, includes, startsWith, endsWith, matches, if(c,a,b), int, join, upper, lower, trim
- 例：\`round(price * quantity * 0.9, 2)\`、\`if(score >= 90, "优秀", "合格")\`

## 生成要求

1. 字段要**完整**：用户提到的东西一个都不能少；用户没说但这类表单显然需要的（如报名表的姓名、联系方式），可以补充，但不要堆砌。
2. 类型要**贴切**：手机号→tel，身份证→idcard，日期→date，金额→number(precision 2, unit 元)，
   有限枚举→select 或 radio，多选→checkbox，是否类→switch，长文本意见→textarea，上传→file。
3. 枚举取值要从用户描述里提取；用户没给取值但显然是枚举的（如「部门」），给 3-6 个合理取值。
4. 中文需求里含「如果…就…」「选择 X 时」这类条件，必须落成 visibleWhen 表达式，而不是写在 help 里。
5. 「自动计算/合计/小计」落成 compute 表达式。
6. key 用英文小写下划线，语义清晰；label 保持用户的中文用词。
7. 不要输出 question 类型字段，除非用户明确要一份考卷。
`.trim();

const FEW_SHOT = [
  {
    role: 'user',
    content: '做一个报销申请表，包含申请人姓名、所在部门（技术部、市场部、财务部）、报销金额（元）、费用发生日期、费用类型（差旅/餐饮/办公用品/其他）、发票附件上传、备注。如果是差旅，还要填写出差城市。',
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      title: '报销申请表',
      kind: 'form',
      groups: [{
        title: '报销信息',
        fields: [
          { key: 'applicantName', label: '申请人姓名', type: 'text', required: true, maxLength: 30 },
          { key: 'department', label: '所在部门', type: 'select', required: true, options: ['技术部', '市场部', '财务部'] },
          { key: 'amount', label: '报销金额', type: 'number', required: true, min: 0, precision: 2, unit: '元' },
          { key: 'expenseDate', label: '费用发生日期', type: 'date', required: true },
          { key: 'expenseType', label: '费用类型', type: 'radio', required: true, options: ['差旅', '餐饮', '办公用品', '其他'] },
          { key: 'travelCity', label: '出差城市', type: 'text', visibleWhen: 'expenseType == "差旅"' },
          { key: 'invoice', label: '发票附件', type: 'file', multiple: true, accept: '.pdf,.jpg,.png', maxSizeMB: 10 },
          { key: 'remark', label: '备注', type: 'textarea', rows: 3 },
        ],
      }],
      settings: { submitText: '提交报销', successMessage: '报销申请已提交，等待审批。' },
    }),
  },
  {
    role: 'user',
    content: '店庆活动报名表：姓名、手机号、参加场次（上午/下午/全天）、参加人数、是否需要停车位，需要的话填车牌号，最后写一句想对店长说的话。',
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      title: '店庆活动报名表',
      kind: 'registration',
      groups: [{
        title: '报名信息',
        fields: [
          { key: 'name', label: '姓名', type: 'text', required: true, maxLength: 30 },
          { key: 'phone', label: '手机号', type: 'tel', required: true },
          { key: 'session', label: '参加场次', type: 'radio', required: true, options: ['上午', '下午', '全天'], inline: true },
          { key: 'headcount', label: '参加人数', type: 'integer', required: true, min: 1, max: 20 },
          { key: 'needParking', label: '是否需要停车位', type: 'switch' },
          { key: 'plateNumber', label: '车牌号', type: 'text', visibleWhen: 'needParking == true', placeholder: '如：京A12345' },
          { key: 'message', label: '想对店长说的话', type: 'textarea', rows: 3, placeholder: '欢迎留下你的建议' },
        ],
      }],
      settings: { submitText: '提交报名', successMessage: '报名成功，我们已收到你的信息！' },
    }),
  },
];

/** 组装对话消息。`repairHint` 非空时表示这是自修复重试。 */
export function buildMessages(requirement, repairHint) {
  const messages = [
    { role: 'system', content: CONTRACT },
    ...FEW_SHOT,
    { role: 'user', content: requirement },
  ];
  if (repairHint) {
    messages.push({
      role: 'user',
      content: `你上一次的输出无法通过校验：${repairHint}\n请重新输出一份**完整**的 FormSchema JSON，修正上述问题。只输出 JSON。`,
    });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// 调用与解析
// ---------------------------------------------------------------------------

/**
 * 从模型回复里抠出 JSON。模型经常包 ```json 围栏或加前后缀寒暄。
 */
export function extractJson(content) {
  const text = String(content ?? '').trim();
  if (!text) throw new FormgenError('LLM_EMPTY_RESPONSE', '模型返回了空内容');

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [];
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(text);

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value;
    } catch { /* 试下一个候选 */ }
  }
  throw new FormgenError('LLM_MALFORMED_JSON', '模型返回的内容不是合法 JSON', { detail: { preview: text.slice(0, 400) } });
}

async function chatCompletion(config, messages, options = {}) {
  const url = `${config.baseUrl}/chat/completions`;
  const body = {
    model: config.model,
    messages,
    temperature: config.temperature,
    response_format: { type: 'json_object' },
    stream: false,
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? '请求超时' : (error?.message ?? String(error));
    throw new FormgenError('LLM_UNREACHABLE', `无法访问模型服务（${url}）：${reason}`, { cause: error });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new FormgenError('LLM_HTTP_ERROR', `模型服务返回 ${response.status}：${detail.slice(0, 200)}`, { detail: { status: response.status } });
  }

  const payload = await response.json().catch(error => {
    throw new FormgenError('LLM_BAD_ENVELOPE', `模型响应不是 JSON：${error.message}`, { cause: error });
  });

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new FormgenError('LLM_NO_CONTENT', '模型响应里没有 choices[0].message.content', { detail: { keys: Object.keys(payload ?? {}) } });
  }
  return { content, usage: payload.usage };
}

/**
 * 用大模型生成 FormSchema。
 *
 * @param {string} requirement 自然语言需求
 * @param {{apiKey?: string, baseUrl?: string, model?: string, timeoutMs?: number,
 *          retries?: number, onEvent?: (event: object) => void}} [options]
 * @returns {Promise<{schema: object, issues: string[], model: string, attempts: number, usage?: object}>}
 */
export async function generateWithLlm(requirement, options = {}) {
  const config = resolveLlmConfig(options);
  const emit = typeof options.onEvent === 'function' ? options.onEvent : () => {};

  if (!config.apiKey) {
    throw new FormgenError('LLM_NOT_CONFIGURED', '未配置模型 API Key（可设置环境变量 DEEPSEEK_API_KEY），已跳过 LLM 通道');
  }
  const text = String(requirement ?? '').trim();
  if (!text) throw new FormgenError('NLP_EMPTY_INPUT', '需求文本为空');

  const maxAttempts = Math.max(1, (options.retries ?? 1) + 1);
  let repairHint;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    emit({ type: 'attempt', attempt, maxAttempts, repair: Boolean(repairHint) });
    try {
      const { content, usage } = await chatCompletion(config, buildMessages(text, repairHint), options);
      const parsed = extractJson(content);
      const { schema, issues } = normalizeSchema(parsed, { source: 'llm' });

      // 模型可能产出「空壳」Schema（有结构但没字段），这不算成功。
      const fieldCount = schema.groups.reduce((sum, g) => sum + g.fields.length, 0);
      if (fieldCount === 0) throw new FormgenError('LLM_EMPTY_SCHEMA', '模型生成的 Schema 没有任何字段');

      schema.meta.source = 'llm';
      schema.meta.generator = `llm:${config.model}`;
      schema.meta.model = config.model;
      schema.meta.sourceText = text;
      schema.meta.attempts = attempt;

      emit({ type: 'success', attempt, fieldCount, issues: issues.length });
      return { schema, issues, model: config.model, attempts: attempt, usage };
    } catch (error) {
      lastError = error;
      // 网络/鉴权类错误重试没有意义，直接抛出交给上层降级。
      if (error instanceof FormgenError && !['LLM_MALFORMED_JSON', 'LLM_EMPTY_SCHEMA', 'SCHEMA_INVALID', 'SCHEMA_EMPTY', 'SCHEMA_FIELD_INVALID', 'SCHEMA_FIELD_TYPE_UNKNOWN', 'SCHEMA_QUESTION_MISSING'].includes(error.code)) {
        emit({ type: 'fatal', attempt, code: error.code, message: error.message });
        throw error;
      }
      repairHint = error instanceof Error ? error.message : String(error);
      emit({ type: 'repair', attempt, reason: repairHint });
    }
  }

  throw new FormgenError('LLM_INVALID_SCHEMA', `模型连续 ${maxAttempts} 次未能产出合法 Schema：${lastError?.message ?? ''}`, { cause: lastError });
}
