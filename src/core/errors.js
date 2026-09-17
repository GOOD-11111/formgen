/**
 * 统一错误类型。
 *
 * 全项目约定：任何可预期的失败都抛 FormgenError，并带一个**稳定的机器可读 code**，
 * 便于上层（CLI / HTTP / 生成器回退逻辑）区分「用户输入问题」和「代码缺陷」。
 */
export class FormgenError extends Error {
  /**
   * @param {string} code 稳定的错误码，形如 `SCHEMA_FIELD_TYPE_UNKNOWN`
   * @param {string} message 面向使用者的中文说明
   * @param {{detail?: unknown, cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FormgenError';
    this.code = code;
    if (options.detail !== undefined) this.detail = options.detail;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, detail: this.detail };
  }
}

/** 断言帮助函数：条件不成立时抛出带 code 的 FormgenError。 */
export function invariant(condition, code, message, detail) {
  if (!condition) throw new FormgenError(code, message, { detail });
  return condition;
}

/** 把任意异常收敛成 { code, message }，不泄露堆栈给终端用户。 */
export function describeError(error) {
  if (error instanceof FormgenError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
}
