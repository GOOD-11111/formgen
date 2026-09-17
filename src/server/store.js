/**
 * 存储层：JSON 文件。
 *
 * 刻意选最朴素的做法。理由：本项目要验证的是**生成与渲染范式**，
 * 不是数据库选型；把存储做成可替换的小接口，读者能一眼看完，
 * 也方便换成 SQLite/Postgres 而不牵动引擎。
 *
 * 写入策略：先写临时文件再 rename——避免进程中断留下半截 JSON。
 */

import { mkdir, readFile, writeFile, rename, readdir, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { FormgenError } from '../core/errors.js';

export class FileStore {
  /** @param {string} rootDir 数据目录 */
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.formsDir = path.join(rootDir, 'forms');
    this.submissionsDir = path.join(rootDir, 'submissions');
    this.indexFile = path.join(rootDir, 'index.json');

    /** 草稿只存在内存里：它们是「还没决定要发布的东西」，不该落盘。 */
    this.drafts = new Map();
    this.draftTtlMs = 6 * 60 * 60 * 1000;
    this.loaded = false;
    /** @type {Map<string, object>} */
    this.index = new Map();
  }

  async init() {
    await mkdir(this.formsDir, { recursive: true });
    await mkdir(this.submissionsDir, { recursive: true });
    await this.#loadIndex();
    this.loaded = true;
    return this;
  }

  async #loadIndex() {
    if (!existsSync(this.indexFile)) return;
    try {
      const parsed = JSON.parse(await readFile(this.indexFile, 'utf8'));
      for (const form of parsed.forms ?? []) this.index.set(form.id, form);
    } catch (error) {
      // 索引损坏不该让服务起不来，重命名留档后重建。
      const backup = `${this.indexFile}.corrupt-${Date.now()}`;
      await rename(this.indexFile, backup).catch(() => {});
      process.emitWarning?.(`index.json 解析失败，已备份到 ${backup}：${error.message}`);
    }
  }

  async #writeJson(file, value) {
    const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    await rename(temp, file);
  }

  async #saveIndex() {
    await this.#writeJson(this.indexFile, { version: 1, forms: [...this.index.values()] });
  }

  // -------------------------------------------------------------------------
  // 表单
  // -------------------------------------------------------------------------

  async createForm(schema, options = {}) {
    const id = options.id ?? newFormId(schema.title);
    const record = {
      id,
      title: schema.title,
      description: schema.description ?? '',
      kind: schema.kind ?? 'form',
      generator: schema.meta?.generator ?? 'manual',
      fieldCount: schema.groups.reduce((sum, g) => sum + g.fields.length, 0),
      createdAt: new Date().toISOString(),
      fileName: `${id}.json`,
    };
    const stored = { ...schema, id };
    await this.#writeJson(path.join(this.formsDir, record.fileName), stored);
    this.index.set(id, record);
    await this.#saveIndex();
    void options;
    return record;
  }

  async getForm(id) {
    const record = this.index.get(id);
    if (!record) return null;
    try {
      const schema = JSON.parse(await readFile(path.join(this.formsDir, record.fileName), 'utf8'));
      return { ...record, schema };
    } catch {
      return null;
    }
  }

  listForms() {
    return [...this.index.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async deleteForm(id) {
    const record = this.index.get(id);
    if (!record) return false;
    this.index.delete(id);
    await unlink(path.join(this.formsDir, record.fileName)).catch(() => {});
    await unlink(this.#submissionFile(id)).catch(() => {});
    await this.#saveIndex();
    return true;
  }

  // -------------------------------------------------------------------------
  // 提交
  // -------------------------------------------------------------------------

  #submissionFile(formId) {
    return path.join(this.submissionsDir, `${formId}.json`);
  }

  async listSubmissions(formId) {
    const file = this.#submissionFile(formId);
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      return Array.isArray(parsed.submissions) ? parsed.submissions : [];
    } catch { return []; }
  }

  async addSubmission(formId, payload) {
    const submissions = await this.listSubmissions(formId);
    const record = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...payload,
    };
    submissions.push(record);
    await this.#writeJson(this.#submissionFile(formId), { formId, submissions });
    return record;
  }

  /** 汇总统计，供首页与 CLI 使用。 */
  async stats() {
    let submissions = 0;
    let questions = 0;
    for (const record of this.index.values()) {
      const list = await this.listSubmissions(record.id);
      submissions += list.length;
      if (record.kind === 'exam') questions += record.fieldCount;
    }
    return { forms: this.index.size, submissions, questions };
  }

  async submissionCount(formId) {
    return (await this.listSubmissions(formId)).length;
  }

  // -------------------------------------------------------------------------
  // 草稿（内存）
  // -------------------------------------------------------------------------

  putDraft(schema) {
    this.#sweepDrafts();
    const id = randomUUID().slice(0, 12);
    this.drafts.set(id, { schema, at: Date.now() });
    return id;
  }

  getDraft(id) {
    const draft = this.drafts.get(id);
    if (!draft) return null;
    if (Date.now() - draft.at > this.draftTtlMs) { this.drafts.delete(id); return null; }
    return draft.schema;
  }

  #sweepDrafts() {
    const now = Date.now();
    for (const [id, draft] of this.drafts) {
      if (now - draft.at > this.draftTtlMs) this.drafts.delete(id);
    }
  }
}

/** 由标题生成可读 id：尽量保留中文，冲突由调用方兜底。 */
export function newFormId(title) {
  const slug = String(title ?? '').trim().replace(/[\s/\\?#%&]+/g, '-').slice(0, 24) || 'form';
  return `${slug}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 判断目录里是否已有数据，供 CLI 提示。 */
export async function storeLooksEmpty(rootDir) {
  if (!existsSync(rootDir)) return true;
  const entries = await readdir(rootDir).catch(() => []);
  return entries.length === 0;
}

export async function ensureDir(dir) {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new FormgenError('STORE_NOT_A_DIRECTORY', `${dir} 不是目录`);
  return dir;
}
