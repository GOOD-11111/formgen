#!/usr/bin/env node
/**
 * FormGen 命令行。
 *
 * 设计原则：任何需要人操作的环节都要能**先看见结果再决定**。
 * 因此 `gen` / `exam` 默认打印可读摘要而不是 JSON 大对象，`--json` 才输出机器可读格式。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate, generateByRule, compareChannels } from './gen/index.js';
import { isLlmConfigured, resolveLlmConfig } from './gen/llm.js';
import { buildBlueprint, describeBlueprint } from './exam/blueprint.js';
import { selectQuestions } from './exam/select.js';
import { paperToSchema, paperToText, alignBankToBlueprint } from './exam/paper-schema.js';
import { loadBank, describeBanks } from './exam/bank.js';
import { schemaStats, validateSchemaShape, walkFields } from './core/schema.js';
import { describeError } from './core/errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

const USAGE = `
FormGen — 低代码与智能表单生成引擎

用法：
  formgen gen "<中文需求>" [选项]        自然语言 → 表单 Schema
  formgen exam "<考卷需求>" [选项]       教师大纲 → 组卷 + 自动评分页面
  formgen serve [选项]                   启动微型平台（生成器 / 采集 / 结果）
  formgen bank                           查看可用题库
  formgen doctor                         环境自检

选项：
  --mode <rule|llm|auto|compare>  生成通道（gen 默认 auto）
  --model <name>                  模型名（默认读 FORMGEN_MODEL / DEEPSEEK_MODEL）
  --seed <n>                      组卷随机种子（exam，默认 20240501）
  --out <file>                    把 Schema 写入文件
  --json                          输出 JSON 而不是可读摘要
  --text                          考卷额外输出可打印的纯文本版
  --port <n>                      serve 端口（默认 4321）
  --host <addr>                   serve 监听地址（默认 127.0.0.1）
  --data <dir>                    数据目录（默认 ./data）
  -h, --help                      显示帮助

示例：
  formgen gen "做一个活动报名表：姓名、手机号、参加场次（上午/下午/全天）"
  formgen exam "高一数学期中试卷，满分150，选择10道每题5分、填空4道每题5分、解答5道，覆盖函数、三角函数、数列" --text
  formgen serve --port 4321
`.trim();

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { flags.help = true; continue; }
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[name] = true; continue; }
      flags[name] = next;
      i += 1;
      continue;
    }
    positional.push(arg);
  }
  return { flags, positional };
}

const bold = text => `\u001b[1m${text}\u001b[22m`;
const dim = text => `\u001b[2m${text}\u001b[22m`;
const green = text => `\u001b[32m${text}\u001b[39m`;
const yellow = text => `\u001b[33m${text}\u001b[39m`;
const red = text => `\u001b[31m${text}\u001b[39m`;

function printSchema(schema, understanding) {
  const stats = schemaStats(schema);
  console.log(`\n${bold(schema.title)}  ${dim(`[${schema.kind}]`)}`);
  if (schema.description) console.log(dim(schema.description));
  console.log(dim(`${stats.groups} 个分组 · ${stats.fields} 个字段 · ${stats.required} 个必填`));
  if (stats.questions) console.log(dim(`${stats.questions} 道题 · 总分 ${stats.totalScore}`));

  for (const group of schema.groups) {
    console.log(`\n  ${bold(group.title || '(默认分组)')}`);
    for (const field of group.fields) {
      const marks = [];
      if (field.required) marks.push(red('*'));
      if (field.compute) marks.push(dim('[自动计算]'));
      if (field.visibleWhen) marks.push(dim('[条件显示]'));
      const options = field.options?.length ? dim(` (${field.options.map(o => o.value).join('/')})`) : '';
      console.log(`    ${field.label}${marks.join('')}  ${dim(field.type)}${options}`);
    }
  }

  const issues = validateSchemaShape(schema);
  if (issues.length) {
    console.log(`\n${yellow('Schema 自检发现问题：')}`);
    for (const issue of issues) console.log(`  - ${issue}`);
  }
  const notes = understanding?.notes ?? schema.meta?.notes ?? [];
  if (notes.length && process.env.FORMGEN_VERBOSE) {
    console.log(`\n${dim('推理回放：')}`);
    for (const note of notes.slice(0, 20)) console.log(dim(`  - ${note}`));
  }
}

async function writeOut(file, content) {
  const target = path.resolve(process.cwd(), file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  console.log(green(`\n已写入 ${target}`));
}

async function cmdGen(positional, flags) {
  const text = positional.join(' ').trim();
  if (!text) { console.error(red('请给出需求文本，例如：formgen gen "做一个报名表，含姓名、手机号"')); process.exitCode = 2; return; }

  const mode = flags.mode ?? 'auto';
  const llmOptions = { model: typeof flags.model === 'string' ? flags.model : undefined };

  if (mode === 'compare') {
    const rule = generateByRule(text);
    let llm = null;
    try {
      llm = await generate(text, { ...llmOptions, mode: 'llm' });
    } catch (error) {
      const { code, message } = describeError(error);
      console.log(yellow(`\n大模型通道不可用（${code}）：${message}`));
    }
    printSchema(rule.schema, rule.understanding);
    if (llm) {
      const comparison = compareChannels(rule, llm);
      console.log(`\n${bold('双通道对比')}`);
      console.log(`  规则通道  ：${comparison.rule.fieldCount} 字段 / ${comparison.rule.logicCount} 处逻辑`);
      console.log(`  大模型通道：${comparison.llm.fieldCount} 字段 / ${comparison.llm.logicCount} 处逻辑`);
      if (comparison.onlyInLlm.length) console.log(`  仅大模型识别：${comparison.onlyInLlm.join('、')}`);
      if (comparison.onlyInRule.length) console.log(`  仅规则识别  ：${comparison.onlyInRule.join('、')}`);
      if (comparison.typeDiffs.length) console.log(`  类型分歧    ：${comparison.typeDiffs.map(d => `${d.label}(${d.rule}→${d.llm})`).join('、')}`);
      console.log(`  ${comparison.verdict}`);
    }
    if (flags.json) console.log(`\n${JSON.stringify({ rule: rule.schema, llm: llm?.schema ?? null }, null, 2)}`);
    if (flags.out) await writeOut(String(flags.out), JSON.stringify(rule.schema, null, 2));
    return;
  }

  const result = await generate(text, { ...llmOptions, mode });
  if (result.kind === 'exam') {
    console.log(yellow('检测到考卷类需求，正在切换到考卷通道…'));
    await cmdExam(positional, flags);
    return;
  }

  if (result.fallback) console.log(dim(`\n[${result.fallback.code}] ${result.fallback.reason}`));
  console.log(dim(`生成通道：${result.channel === 'llm' ? `大模型 (${result.llm?.model})` : '规则引擎'}`));
  for (const issue of result.issues ?? []) console.log(yellow(`  ! ${issue}`));

  if (flags.json) console.log(JSON.stringify(result.schema, null, 2));
  else printSchema(result.schema, result.understanding);

  if (flags.out) await writeOut(String(flags.out), JSON.stringify(result.schema, null, 2));
}

async function cmdExam(positional, flags) {
  const text = positional.join(' ').trim();
  if (!text) { console.error(red('请给出考卷需求')); process.exitCode = 2; return; }

  const { planExam } = await import('./gen/index.js');
  const planned = planExam(text);
  const outline = planned.outline;
  const blueprint = buildBlueprint(outline);

  console.log(bold('\n命题蓝图'));
  console.log(describeBlueprint(blueprint));

  const bank = await loadBank({ subject: outline.subject, grade: outline.grade });
  console.log(dim(`\n题库：${bank.length} 道题`));

  const seed = flags.seed !== undefined ? Number(flags.seed) : undefined;
  // 先对齐分值再选材，卷子实际总分才可能与计划总分一致。
  const aligned = alignBankToBlueprint(bank, blueprint);
  const { paper, report } = selectQuestions(aligned, blueprint, Number.isFinite(seed) ? { seed } : {});

  console.log(`\n${bold('组卷结果')}  ${dim(`seed=${paper.seed}`)}`);
  console.log(`  计划总分 ${paper.plannedScore} · 实际总分 ${paper.totalScore}`);
  for (const section of paper.sections) {
    console.log(`  ${section.title ?? section.type}：${section.questions.length} 题 × ${section.scorePer} 分`);
  }
  const coverage = report.coverage ?? [];
  if (coverage.length) {
    console.log(`\n${bold('知识点覆盖')}`);
    for (const item of coverage) {
      const mark = item.satisfied ? green('✓') : red('✗');
      console.log(`  ${mark} ${item.knowledge}：需 ${item.required}，实际 ${item.used}`);
    }
  }
  for (const warning of report.warnings ?? []) console.log(yellow(`  ! ${warning}`));
  for (const suggestion of report.suggestions ?? []) console.log(dim(`  → ${suggestion}`));

  const schema = paperToSchema(paper, { sourceText: text });

  if (flags.json) console.log(`\n${JSON.stringify({ schema, paper, report }, null, 2)}`);
  else printSchema(schema);

  if (flags.text) {
    console.log(`\n${bold('可打印文本版')}\n`);
    console.log(paperToText(paper));
  }
  if (flags.out) await writeOut(String(flags.out), JSON.stringify(schema, null, 2));
}

async function cmdServe(flags) {
  const { startServer } = await import('./server/app.js');
  const port = Number(flags.port ?? process.env.PORT ?? 4321);
  const host = String(flags.host ?? '127.0.0.1');
  const dataDir = flags.data ? path.resolve(process.cwd(), String(flags.data)) : path.join(PROJECT_ROOT, 'data');

  const instance = await startServer({ port, host, dataDir });
  const address = instance.address;
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
  const stats = await instance.store.stats();

  console.log(`\n${bold('FormGen 已启动')}`);
  console.log(`  生成器   http://${shown}:${address.port}/studio`);
  console.log(`  工作台   http://${shown}:${address.port}/`);
  console.log(`  设计说明 http://${shown}:${address.port}/docs`);
  console.log(dim(`  数据目录 ${dataDir}（已有 ${stats.forms} 张表单、${stats.submissions} 条提交）`));
  console.log(dim(`  大模型通道 ${isLlmConfigured() ? green('已接入') : yellow('未接入')}（设置 DEEPSEEK_API_KEY 后自动启用）`));
  console.log(dim('\n  按 Ctrl+C 停止服务。'));

  const shutdown = async () => {
    console.log(dim('\n正在停止…'));
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

async function cmdBank() {
  const banks = await describeBanks();
  if (!banks.length) { console.log(yellow('banks/ 目录下没有题库。放一个 .json 或 .js 数组即可。')); return; }
  console.log(bold('\n可用题库'));
  for (const bank of banks) {
    console.log(`\n  ${bold(bank.name)}  ${dim(`${bank.grade}${bank.subject}`)}`);
    console.log(`    题目 ${bank.count} 道　${Object.entries(bank.byType).map(([t, n]) => `${t}:${n}`).join(' ')}`);
    if (bank.knowledge.length) console.log(dim(`    知识点：${bank.knowledge.join('、')}`));
  }
}

async function cmdDoctor() {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(['Node 版本', `${process.version}`, nodeMajor >= 20]);

  const config = resolveLlmConfig();
  checks.push(['大模型通道', config.apiKey ? `已配置（${config.model} @ ${config.baseUrl}）` : '未配置（设置 DEEPSEEK_API_KEY 即可启用）', true]);

  const banks = await describeBanks();
  checks.push(['题库', banks.length ? `${banks.length} 个，共 ${banks.reduce((sum, b) => sum + b.count, 0)} 道题` : '无', banks.length > 0]);

  let schemaOk = false;
  let schemaDetail = '';
  try {
    const result = generateByRule('测试：姓名、手机号、备注（选填）');
    const issues = validateSchemaShape(result.schema);
    schemaOk = issues.length === 0;
    schemaDetail = schemaOk ? `自检通过（${result.schema.groups.length} 分组）` : issues.join('；');
  } catch (error) {
    schemaDetail = describeError(error).message;
  }
  checks.push(['规则引擎', schemaDetail, schemaOk]);

  let latexOk = false;
  let latexDetail = '';
  try {
    const latex = await import('./latex/mathml.js');
    const output = latex.latexToMathML('\\frac{1}{2}');
    latexOk = typeof output === 'string' && output.includes('<math');
    latexDetail = latexOk ? 'LaTeX → MathML 可用' : '输出了非 MathML 内容';
  } catch (error) {
    latexDetail = `模块不可用：${error.message}`;
  }
  checks.push(['公式渲染', latexDetail, latexOk]);

  console.log(bold('\n环境自检\n'));
  for (const [name, detail, ok] of checks) {
    console.log(`  ${ok ? green('✓') : red('✗')} ${name.padEnd(12, ' ')} ${detail}`);
  }
  const failed = checks.filter(c => !c[2]).length;
  console.log(failed ? red(`\n${failed} 项未通过`) : green('\n全部通过'));
  if (failed) process.exitCode = 1;
  void readFile; void walkFields;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional.shift();

  if (flags.help || !command) { console.log(USAGE); return; }

  switch (command) {
    case 'gen': case 'generate': await cmdGen(positional, flags); break;
    case 'exam': case 'paper': await cmdExam(positional, flags); break;
    case 'serve': case 'start': await cmdServe(flags); break;
    case 'bank': await cmdBank(); break;
    case 'doctor': await cmdDoctor(); break;
    default:
      console.error(red(`未知命令：${command}\n`));
      console.log(USAGE);
      process.exitCode = 2;
  }
}

main().catch(error => {
  const { code, message } = describeError(error);
  console.error(red(`\n[${code}] ${message}`));
  if (process.env.FORMGEN_DEBUG) console.error(error);
  process.exitCode = 1;
});
