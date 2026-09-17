// 从 DSH 会话事件日志导出 AI 协作对话记录（可重复运行，每次覆盖输出）。
//
// 用法：  node docs/ai-conversation/export-conversation.mjs
// 输出：  对话记录.md                    人读版，0.5 MB 左右
//         对话记录-原始事件.jsonl.zst     逐条原始事件（已脱敏，zstd 压缩）
//
// 为什么压缩：原始事件未压缩约 7.7 MB，而 GitHub 不会渲染这么大的文本文件，
// 它只能当下载件用。压缩后约 1.5 MB，克隆体积可控；人读的内容都在 .md 里，直接可看。
// 解压：  node -e "const z=require('node:zlib'),f=require('node:fs');f.writeFileSync('events.jsonl',z.zstdDecompressSync(f.readFileSync('对话记录-原始事件.jsonl.zst')))"
//
// 日志格式：$DSH_HOME/sessions/<工作区编码>/<会话ID>/session.v3.jsonl.zstd
// 它是**追加写的多帧 zstd**——每次追加一帧，共约 900 帧。
// 因此 zstdDecompressSync 与 createZstdDecompress 都只吃第一帧
// （第一版就栽在这：解出来只有 1 条记录，看起来像空日志）。
// 必须按魔数 28 B5 2F FD 切帧、逐帧解压。

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_MD = join(OUT_DIR, '对话记录.md');
const OUT_JSONL = join(OUT_DIR, '对话记录-原始事件.jsonl.zst');

// --- 定位会话日志 -------------------------------------------------------
function findSessionLog() {
  const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE, '.dsh');
  const sessionsRoot = join(dshHome, 'sessions');
  const wanted = process.env.DSH_SESSION_ID;

  const candidates = [];
  let workspaces = [];
  try { workspaces = readdirSync(sessionsRoot); }
  catch { throw new Error(`找不到会话目录 ${sessionsRoot}（DSH 未安装或 DSH_HOME 未设置？）`); }

  for (const workspace of workspaces) {
    const dir = join(sessionsRoot, workspace);
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const sessionDir of entries) {
      if (wanted && !sessionDir.includes(wanted)) continue;
      const file = join(dir, sessionDir, 'session.v3.jsonl.zstd');
      try { candidates.push({ file, mtime: statSync(file).mtimeMs }); } catch { /* 不是会话目录 */ }
    }
  }
  if (!candidates.length) throw new Error(`未找到会话日志（session=${wanted ?? '未指定'}）`);
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].file;
}

const LOG = findSessionLog();

// --- 脱敏 ---------------------------------------------------------------
// 本会话中出现过一次 GitHub PAT（一次性发布用）。导出件会进入公开仓库，
// 必须抹掉；同时覆盖通用凭据形态，避免以后又漏。
const REDACTIONS = [
  [/ghp_[A-Za-z0-9]{20,}/g, 'ghp_***REDACTED***'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***REDACTED***'],
  [/gho_[A-Za-z0-9]{20,}/g, 'gho_***REDACTED***'],
  [/ghs_[A-Za-z0-9]{20,}/g, 'ghs_***REDACTED***'],
  [/sk-[A-Za-z0-9]{20,}/g, 'sk-***REDACTED***'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA***REDACTED***'],
  // 注意：不要加「13~19 位数字」这类泛化规则。epoch 毫秒时间戳正好是 13 位，
  // 会被一起吃掉，把整份记录的时间轴毁掉。
];
let redactionCount = 0;
function redact(input) {
  let out = String(input ?? '');
  for (const [re, to] of REDACTIONS) {
    re.lastIndex = 0;
    if (re.test(out)) { redactionCount++; re.lastIndex = 0; out = out.replace(re, to); }
  }
  return out;
}

// --- 逐帧解压 -----------------------------------------------------------
const raw = readFileSync(LOG);
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
const offsets = [];
for (let i = 0; ;) {
  const at = raw.indexOf(MAGIC, i);
  if (at < 0) break;
  offsets.push(at);
  i = at + 4;
}
const chunks = [];
for (let f = 0; f < offsets.length; f++) {
  const end = f + 1 < offsets.length ? offsets[f + 1] : raw.length;
  chunks.push(zlib.zstdDecompressSync(raw.subarray(offsets[f], end)).toString('utf8'));
}
const records = chunks.join('').split('\n').filter(l => l.trim())
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

// --- 取值助手 -----------------------------------------------------------
const blocks = c => (Array.isArray(c) ? c : []);
const textOf = c => blocks(c).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim();
const reasoningOf = c => blocks(c).filter(b => b?.type === 'reasoning' && typeof b.text === 'string').map(b => b.text).join('\n').trim();
const resultTextOf = rec => {
  const parts = [];
  for (const block of blocks(rec?.data?.message?.content)) {
    if (block?.type === 'tool-result' && Array.isArray(block.content)) parts.push(textOf(block.content));
    else if (block?.type === 'text') parts.push(block.text);
  }
  return parts.filter(Boolean).join('\n').trim();
};
const fmtTime = ms => {
  try { return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
  catch { return String(ms); }
};
const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length <= n ? t : `${t.slice(0, n)}\n…（此处省略 ${t.length - n} 字）`;
};
const safe = s => String(s ?? '').replace(/<\/details>/gi, '<\\/details>');

const count = t => records.filter(r => r.type === t).length;
const pick = (t, f) => records.filter(r => r.type === t).map(f).filter(Boolean);
const sessionRec = records.find(r => r.type === 'session');
const times = records.map(r => r.time).filter(Number.isFinite);

// --- 头部（脱敏计数在正文遍历时才累加，所以先攒着，最后拼）-----------------
const head = [];
head.push('# FormGen 项目 —— AI 协作对话记录');
head.push('');
head.push('> 本文件由 DSH 会话事件日志机械导出，**未经人工改写**。');
head.push('> 每条记录保留了原始序号与时间戳，可用同目录的 `对话记录-原始事件.jsonl.zst` 逐条核对。');
head.push('> 折叠块内的内容为便于阅读做了截断，原始全文见原始事件文件。');
head.push('');
head.push('## 会话信息');
head.push('');
head.push('| 项 | 值 |');
head.push('| --- | --- |');
head.push(`| 会话 ID | \`${sessionRec?.id ?? '未知'}\` |`);
head.push(`| 工作目录 | \`${sessionRec?.cwd ?? '未知'}\` |`);
head.push(`| 代理预设 | \`${sessionRec?.agentPreset ?? '未知'}\`${pick('agent-preset/selected', r => r.data?.agentPreset).length ? `（切换：${[...new Set(pick('agent-preset/selected', r => r.data?.agentPreset))].join(' → ')}）` : ''} |`);
head.push(`| 模型 | ${[...new Set(pick('model/selection', r => r.data?.selection?.model ?? r.data?.model))].join('、') || '未记录'} |`);
head.push(`| 沙箱模式 | ${[...new Set(pick('sandbox/mode', r => r.data?.mode))].join('、') || '未记录'} |`);
head.push(`| 时间跨度 | ${fmtTime(Math.min(...times))} — ${fmtTime(Math.max(...times))} |`);
head.push(`| 会话标题 | ${[...new Set(pick('session/title', r => r.data?.title))].join(' / ') || '未记录'} |`);
head.push(`| 事件总数 | ${records.length}（原始 zstd 帧 ${offsets.length} 个） |`);
head.push(`| 用户消息 | ${count('user/message')} 条 |`);
head.push(`| 助手消息 | ${count('assistant/message')} 条 |`);
head.push(`| 工具调用 | ${count('tool/call')} 次 |`);
head.push('');
head.push('---');
head.push('');

// --- 正文 ---------------------------------------------------------------
const out = [];

for (const rec of records) {
  const t = rec.type;

  if (t === 'turn/start') {
    out.push('', `## 第 ${rec.data?.turn ?? '?'} 轮　${rec.time ? `（${fmtTime(rec.time)}）` : ''}`, '');
    continue;
  }
  if (t === 'turn/end' || t === 'step/start' || t === 'step/end') continue;

  if (t === 'user/message') {
    const text = redact(textOf(rec.data?.content));
    if (!text) continue;
    // 这些在日志里都落在 user/message 下，但都不是人打的字：
    // 运行时快照、技能目录、模型切换提示，以及子代理的完成/来信通知。
    const injected = /^(Current runtime context|Current DSH file policy|<system-reminder>|\[model changed|Agent [0-9a-f-]+ sent a message|Background subagent )/.test(text);
    if (injected) {
      out.push(`### ⚙️ 系统注入上下文　${rec.time ? `\`${fmtTime(rec.time)}\`` : ''}`, '');
      out.push('<details><summary>展开</summary>', '', safe(clip(text, 700)), '', '</details>', '');
    } else {
      out.push(`### 👤 用户　${rec.time ? `\`${fmtTime(rec.time)}\`` : ''}`, '', text, '');
    }
    continue;
  }

  if (t === 'assistant/message') {
    const content = rec.data?.message?.content;
    const text = redact(textOf(content));
    const reasoning = redact(reasoningOf(content));
    if (!text && !reasoning) continue;
    out.push(`### 🤖 助手　${rec.time ? `\`${fmtTime(rec.time)}\`` : ''}`, '');
    if (text) out.push(text, '');
    if (reasoning) out.push('<details><summary>思考过程（截断）</summary>', '', safe(clip(reasoning, 900)), '', '</details>', '');
    continue;
  }

  if (t === 'tool/call') {
    const args = redact(rec.data?.arguments ?? '');
    out.push(`🔧 **调用工具** \`${rec.data?.name ?? '未知'}\``);
    if (args && args !== '{}') {
      out.push('', '<details><summary>参数</summary>', '', '```json', safe(clip(args, 600)), '```', '', '</details>');
    }
    out.push('');
    continue;
  }

  if (t === 'tool/result') {
    const text = redact(resultTextOf(rec));
    if (!text) continue;
    out.push('<details><summary>📤 工具返回（截断）</summary>', '', '```text', safe(clip(text, 700)), '```', '', '</details>', '');
    continue;
  }
}

// --- 附录：关键系统事件 -------------------------------------------------
const INTERESTING = {
  'approval/asked': r => r.data?.request?.kind ?? r.data?.kind ?? '',
  'approval/decided': r => r.data?.decision ?? r.data?.outcome ?? '',
  'approval/policy': r => String(r.data?.policy ?? ''),
  'goal/change': r => `${r.data?.action ?? ''} ${r.data?.objective ?? ''}`.trim(),
  'todo/write': r => `${(r.data?.todos ?? []).length} 项待办`,
  'sandbox/mode': r => String(r.data?.mode ?? ''),
  'permission/preset': r => String(r.data?.preset ?? ''),
  'model/selection': r => String(r.data?.selection?.model ?? r.data?.model ?? ''),
  'agent-preset/selected': r => String(r.data?.agentPreset ?? ''),
  'session/title': r => String(r.data?.title ?? ''),
  'deliverables/presented': r => `${(r.data?.files ?? []).length} 个交付物`,
  'session/end-seed': () => '',
};

out.push('', '---', '', '## 附录：关键系统事件', '');
out.push('流程性事件，说明协作过程受管控（审批、沙箱、目标、待办）而非无约束生成。', '');
out.push('| 序号 | 时间 | 事件 | 摘要 |', '| --- | --- | --- | --- |');
for (const rec of records) {
  if (!(rec.type in INTERESTING)) continue;
  const summary = redact(INTERESTING[rec.type](rec));
  out.push(`| ${rec.seq} | ${fmtTime(rec.time)} | \`${rec.type}\` | ${String(summary).replace(/\|/g, '\\|').slice(0, 120)} |`);
}
out.push('');

// --- 写出 ---------------------------------------------------------------
const note = `> 导出时已对 **${redactionCount}** 处凭据做过脱敏（含一次性使用的 GitHub Token，已吊销）。`;
// 从日志里抽出的文本可能夹带 CRLF。仓库用 .gitattributes 统一为 LF，
// 不在这里归一的话，工作区与索引的行尾会不一致，git 每次都要警告并重写。
const mdText = (head.join('\n').replace(
  '> 折叠块内的内容为便于阅读做了截断，原始全文见原始事件文件。',
  `> 折叠块内的内容为便于阅读做了截断，原始全文见原始事件文件。\n${note}`,
) + '\n' + out.join('\n')).replace(/\r\n?/g, '\n');

const jsonlText = records.map(r => redact(JSON.stringify(r))).join('\n') + '\n';

writeFileSync(OUT_MD, mdText, 'utf8');
writeFileSync(OUT_JSONL, zlib.zstdCompressSync(Buffer.from(jsonlText, 'utf8')));

console.log(`日志   ${LOG}`);
console.log(`帧数 ${offsets.length}　事件 ${records.length} 条　脱敏 ${redactionCount} 处`);
console.log(`写出   ${OUT_MD}`);
console.log(`       ${(readFileSync(OUT_MD).length / 1024).toFixed(0)} KB`);
console.log(`写出   ${OUT_JSONL}`);
console.log(`       ${(readFileSync(OUT_JSONL).length / 1024).toFixed(0)} KB（压缩前 ${(Buffer.byteLength(jsonlText) / 1024 / 1024).toFixed(2)} MB）`);
