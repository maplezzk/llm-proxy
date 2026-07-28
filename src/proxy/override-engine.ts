/**
 * 声明式覆写引擎（U5）。
 *
 * 设计依据：
 * - docs/plans/2026-07-28-001-feat-axonhub-parity-orchestration-plan.md §U5（KTD1/KTD8）；
 * - AxonHub internal/server/orchestrator/override.go（序列化后应用、文本模板条件、白名单、失败开放）。
 *
 * 关键不变量：
 * - 序列化后/fetch 前应用：pipeline 在 outbound.encode 之后、doFetch 之前调用 applyOverrides；
 * - 轻量模板：{{var}} 文本替换，渲染结果 trim 后 === "true" 才应用规则；
 * - 白名单变量：model / logicalModel / provider / providerProtocol / resolvedModel；
 * - 保护字段（运行时双重拦截）：顶级段命中 model / messages / stream / system / tools 即拒绝该 rule；
 * - 失败开放：模板渲染/操作执行错误 → 记录日志并跳过，不阻断请求；
 * - 操作注册表：v1 内置 body set / set_if_absent / delete + header set / delete，
 *   通过 registerBodyOp / registerHeaderOp 扩展（extensibility 验证）。
 */
import type { Logger } from 'pino';
import type { OverrideBodyOp, OverrideHeaderOp, OverrideRule } from '../config/types.ts';
import type { WireBody } from './adapters/index.ts';

/** 覆写上下文：携带供模板渲染使用的路由/请求元信息。 */
export interface OverrideContext {
  /** 客户端 wire body 中的 model（logical model）。 */
  model: string;
  /** 同 model（别名；AxonHub 风格，operator 可读性更好）。 */
  logicalModel: string;
  /** 选中渠道的 provider 名（route.providerId）。 */
  provider: string;
  /** 选中渠道的 provider 协议（route.providerProtocol）。 */
  providerProtocol: string;
  /** 选中渠道的真实模型 ID（route.resolvedModel）。 */
  resolvedModel: string;
  /** P2 R14：当 client 显式关闭 reasoning 时为 true，防止后置 override wire 重新启用。 */
  reasoningDisabled?: boolean;
}

/** applyOverrides 返回值：可能被覆写修改的 body 和 headers（不可变调用语义内部共用同一引用）。 */
export interface OverrideApplyResult {
  body: WireBody;
  headers: Record<string, string>;
}

/** 保护字段（按 R12；运行时双重拦截，配置校验已在 U1 阶段覆盖）。 */
export const PROTECTED_OVERRIDE_PATHS: readonly string[] = [
  'model',
  'messages',
  'stream',
  'system',
  'tools',
];

/**
 * reasoningDisabled 为 true 时，wire 中的 reasoning 相关字段亦受保护（R14）。
 * 覆盖 reasoning_effort/thinking/reasoning 意味着重新启用 reasoning，
 * 故 override 不能 targeting 它们。
 */
const REASONING_WIRE_PATHS = ['reasoning_effort', 'thinking', 'reasoning'];

/** 模板白名单变量（R12：仅这些变量可在覆写条件模板中使用）。 */
const TEMPLATE_VARIABLES = new Set([
  'model',
  'logicalModel',
  'provider',
  'providerProtocol',
  'resolvedModel',
]);

// --- 资源限制常量（A8） ---
const MAX_WHEN_BYTES = 2048; /** when 模板最大字节数 */
const MAX_TOKENS = 512; /** 单个表达式最大 token 数（标识符 + 操作符 + 括号） */
const MAX_BRACKET_DEPTH = 32; /** 表达式括号最大嵌套深度 */

/** body 操作处理函数签名。 */
export type BodyOpHandler = (body: WireBody, op: OverrideBodyOp, ctx: OverrideContext) => void;

/** header 操作处理函数签名。 */
export type HeaderOpHandler = (headers: Record<string, string>, op: OverrideHeaderOp) => void;

/** 内置 body 操作注册表（extensibility：可由外部 registerBodyOp 扩展）。 */
const BODY_OP_REGISTRY = new Map<string, BodyOpHandler>();

/** 内置 header 操作注册表（extensibility：可由外部 registerHeaderOp 扩展）。 */
const HEADER_OP_REGISTRY = new Map<string, HeaderOpHandler>();

/** 跳过信号：当前 op 不可应用（保护字段或路径不可达），让外层继续处理其余 op。 */
class OverrideSkipError extends Error {
  constructor(
    message: string,
    public readonly op: { kind: 'body' | 'header'; name: string; target: string },
  ) {
    super(message);
    this.name = 'OverrideSkipError';
  }
}

/** 规则拒绝信号：保护字段命中，整条 rule 被跳过（AxonHub 的严格语义）。 */
class OverrideRuleRejectError extends Error {
  constructor(
    message: string,
    public readonly rule: OverrideRule,
    public readonly opName: string,
    public readonly target: string,
  ) {
    super(message);
    this.name = 'OverrideRuleRejectError';
  }
}

/** 危险路径段（A1：原型链污染防护）。 */
const DANGEROUS_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

// --- 路径规范化（合并 A1/A2 修复） ---
//
// 关键设计：
// 1. 先 split('.') 保留空段（不 filter），一次统一规范化；
// 2. 规范化后若路径为空（全是空段），抛出 OverrideSkipError；
// 3. 规范化后若任一段为危险段（__proto__/constructor/prototype），抛出 OverrideSkipError；
// 4. 规范化结果供 isProtectedPath、setPath、lookupPath、deletePath 共用。

/**
 * 规范化路径字符串：拒绝空路径和危险段（原型链污染防护 A1）。
 * 返回规范化后的 segments（永不包含空段）。
 * @throws OverrideSkipError 路径为空或包含危险段时
 */
const normalizePath = (path: string): string[] => {
  // split('.') 不过滤空段，保留完整路径结构
  const raw = path.split('.');
  if (raw.length === 0 || raw.every((s) => s.length === 0)) {
    throw new OverrideSkipError('path is empty (no non-empty segments)', {
      kind: 'body',
      name: 'normalize',
      target: path,
    });
  }
  // 过滤空段后检查危险段
  const segments: string[] = [];
  for (const seg of raw) {
    if (seg.length === 0) continue; // 跳过空段（前导/尾随/连续点）
    if (DANGEROUS_PATH_SEGMENTS.has(seg)) {
      throw new OverrideSkipError(
        `dangerous path segment: "${seg}" (prototype pollution attempt)`,
        { kind: 'body', name: 'normalize', target: path },
      );
    }
    segments.push(seg);
  }
  if (segments.length === 0) {
    throw new OverrideSkipError('path has only empty segments', {
      kind: 'body',
      name: 'normalize',
      target: path,
    });
  }
  return segments;
};

/**
 * 检查路径顶级段是否命中保护字段（A2：只基于规范化后首段）。
 * 也检查 reasoningDisabled 模式下 reasoning 相关 wire 字段（R14）。
 * A1：直接检查危险段（不在 isProtectedPath 中调用 normalizePath，避免异常被误当拒绝）。
 */
const isProtectedPath = (
  path: string,
  ctx: OverrideContext,
): { protected: boolean; reason: string } => {
  // A1：先规范化（split 不过滤空段）检查危险段
  const raw = path.split('.');
  for (const seg of raw) {
    if (seg.length === 0) continue; // 跳过空段（前导点）
    if (DANGEROUS_PATH_SEGMENTS.has(seg)) {
      return { protected: true, reason: `dangerous path segment: ${seg}` };
    }
  }
  // 过滤空段后取首段
  const segments = raw.filter((s) => s.length > 0);
  if (segments.length === 0) {
    return { protected: true, reason: 'empty path (all segments are empty)' };
  }
  const top = segments[0];
  if (PROTECTED_OVERRIDE_PATHS.includes(top)) {
    return { protected: true, reason: `protected top-level field: ${top}` };
  }
  // R14：当 client 显式关闭 reasoning 时，wire 中的 reasoning 字段亦受保护
  if (ctx.reasoningDisabled && REASONING_WIRE_PATHS.includes(top)) {
    return { protected: true, reason: `reasoning field blocked by client explicit-off: ${top}` };
  }
  return { protected: false, reason: '' };
};

/**
 * 预扫描规则中所有操作，检查是否有保护字段/危险路径（A4）。
 * 返回 { reject, reason } 或 null（可继续）。
 */
const preScanRule = (
  rule: OverrideRule,
  ctx: OverrideContext,
): { reject: boolean; reason: string; opName?: string; target?: string } | null => {
  if (rule.body) {
    for (const op of rule.body) {
      try {
        const { protected: isProt, reason } = isProtectedPath(op.path, ctx);
        if (isProt) {
          return { reject: true, reason, opName: op.op, target: op.path };
        }
        // A1：normalizePath 会在操作时再做，这里提前扫一遍以覆盖"危险段非首段"场景
        // （实际上 normalizePath 已包含检查，isProtectedPath 已调用了 normalizePath）
      } catch (err) {
        if (err instanceof OverrideSkipError) {
          return {
            reject: true,
            reason: err.message,
            opName: op.op,
            target: op.path,
          };
        }
        throw err;
      }
    }
  }
  return null;
};

/** 沿路径写入值（创建中间对象）。要求 segments 非空。 */
const setPath = (body: WireBody, segments: string[], value: unknown): void => {
  let cursor: Record<string, unknown> = body as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] as string;
    const next = cursor[seg];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      // A1：中间对象用 Object.create(null)，避免 __proto__ 作为自有键的原型污染
      cursor[seg] = Object.create(null);
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = value;
};

/** 探测路径是否存在；返回 { exists, parent, lastKey }。A1：用 Object.hasOwn 不用 in。 */
const lookupPath = (
  body: WireBody,
  segments: string[],
): { exists: boolean; parent?: Record<string, unknown>; lastKey?: string } => {
  let cursor: Record<string, unknown> = body as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] as string;
    // A1：只用 Object.hasOwn 读取自有属性，拒绝继承属性
    if (
      !Object.prototype.hasOwnProperty.call(cursor, seg) ||
      typeof cursor[seg] !== 'object' ||
      cursor[seg] === null ||
      Array.isArray(cursor[seg])
    ) {
      return { exists: false };
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  const lastKey = segments[segments.length - 1] as string;
  if (cursor === null || typeof cursor !== 'object') {
    return { exists: false };
  }
  // A1：只用 Object.hasOwn，不用 `in`
  return {
    exists: Object.prototype.hasOwnProperty.call(cursor, lastKey),
    parent: cursor,
    lastKey,
  };
};

/** 删除路径对应的键（路径不存在时为 no-op）。 */
const deletePath = (body: WireBody, segments: string[]): void => {
  const result = lookupPath(body, segments);
  if (result.exists && result.parent && result.lastKey !== undefined) {
    delete result.parent[result.lastKey];
  }
};

// --- 内置 body 操作注册 ---

BODY_OP_REGISTRY.set('set', (body, op, ctx) => {
  const { protected: isProt, reason } = isProtectedPath(op.path, ctx);
  if (isProt) {
    throw new OverrideRuleRejectError(
      `protected path: ${reason}`,
      { scope: 'adapter-alias', body: [op] },
      op.op,
      op.path,
    );
  }
  const segments = normalizePath(op.path);
  setPath(body, segments, op.value);
});

BODY_OP_REGISTRY.set('set_if_absent', (body, op, ctx) => {
  const { protected: isProt, reason } = isProtectedPath(op.path, ctx);
  if (isProt) {
    throw new OverrideRuleRejectError(
      `protected path: ${reason}`,
      { scope: 'adapter-alias', body: [op] },
      op.op,
      op.path,
    );
  }
  const segments = normalizePath(op.path);
  const result = lookupPath(body, segments);
  if (!result.exists) {
    setPath(body, segments, op.value);
  }
});

BODY_OP_REGISTRY.set('delete', (body, op, ctx) => {
  const { protected: isProt, reason } = isProtectedPath(op.path, ctx);
  if (isProt) {
    throw new OverrideRuleRejectError(
      `protected path: ${reason}`,
      { scope: 'adapter-alias', body: [op] },
      op.op,
      op.path,
    );
  }
  const segments = normalizePath(op.path);
  deletePath(body, segments);
});

// --- 内置 header 操作注册 ---

HEADER_OP_REGISTRY.set('set', (headers, op) => {
  headers[op.name] = op.value ?? '';
});

HEADER_OP_REGISTRY.set('delete', (headers, op) => {
  delete headers[op.name];
});

/** 扩展 body 操作（v1 之外的操作可通过此入口注入；测试也用此验证 extensibility）。 */
export const registerBodyOp = (name: string, handler: BodyOpHandler): void => {
  BODY_OP_REGISTRY.set(name, handler);
};

/** 扩展 header 操作。 */
export const registerHeaderOp = (name: string, handler: HeaderOpHandler): void => {
  HEADER_OP_REGISTRY.set(name, handler);
};

// --- 条件表达式求值器（v1：== / != / && / || / () / 字符串字面量 / 标识符） ---
//
// 设计：模板先经 renderTemplate 变量替换得到「已替换表达式」，再由
// evaluateExpression 求值为 boolean（"true" / "false"）。最终 evaluateCondition
// 把 boolean 折叠成 "true" / "false" 字符串供调用方判定。这样 ==
// / != / && / || 等运算符在 AxonHub 风格 text/template 中通过 eq/neq 等
// 函数表达，而本实现用更接近通用语言的运算符形式，覆盖常见条件场景。

type ExprToken =
  | { kind: 'string'; value: string }
  | { kind: 'eq' }
  | { kind: 'neq' }
  | { kind: 'and' }
  | { kind: 'or' }
  | { kind: 'lparen'; depth: number }
  | { kind: 'rparen'; depth: number };

const tokenizeExpression = (input: string): ExprToken[] => {
  // A8: 字节长度限制
  if (new TextEncoder().encode(input).length > MAX_WHEN_BYTES) {
    throw new OverrideSkipError(`when expression exceeds ${MAX_WHEN_BYTES} bytes`, {
      kind: 'body',
      name: 'tokenize',
      target: input.slice(0, 64),
    });
  }

  const tokens: ExprToken[] = [];
  let i = 0;
  let depth = 0;
  while (i < input.length) {
    // A8: token 数限制
    if (tokens.length >= MAX_TOKENS) {
      throw new OverrideSkipError(`expression exceeds ${MAX_TOKENS} tokens`, {
        kind: 'body',
        name: 'tokenize',
        target: input.slice(0, 64),
      });
    }

    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < input.length && input[j] !== quote) {
        // A5: 支持转义字符
        if (input[j] === '\\' && j + 1 < input.length) j++;
        j++;
      }
      // A5: 引号必须闭合
      if (j >= input.length || input[j] !== quote) {
        throw new OverrideSkipError(`unclosed string literal: "${input.slice(i, j + 1)}"`, {
          kind: 'body',
          name: 'tokenize',
          target: input.slice(i, i + 32),
        });
      }
      tokens.push({ kind: 'string', value: input.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (input.slice(i, i + 2) === '==') {
      tokens.push({ kind: 'eq' });
      i += 2;
      continue;
    }
    if (input.slice(i, i + 2) === '!=') {
      tokens.push({ kind: 'neq' });
      i += 2;
      continue;
    }
    if (input.slice(i, i + 2) === '&&') {
      tokens.push({ kind: 'and' });
      i += 2;
      continue;
    }
    if (input.slice(i, i + 2) === '||') {
      tokens.push({ kind: 'or' });
      i += 2;
      continue;
    }
    if (ch === '(') {
      depth++;
      // A8: 括号深度限制
      if (depth > MAX_BRACKET_DEPTH) {
        throw new OverrideSkipError(`bracket depth exceeds ${MAX_BRACKET_DEPTH}`, {
          kind: 'body',
          name: 'tokenize',
          target: input.slice(i, i + 8),
        });
      }
      tokens.push({ kind: 'lparen', depth });
      i++;
      continue;
    }
    if (ch === ')') {
      // A5: 遇到右括号时必须有对应的左括号（depth > 0）
      if (depth === 0) {
        throw new OverrideSkipError('unexpected ) without matching (', {
          kind: 'body',
          name: 'tokenize',
          target: input.slice(i, i + 8),
        });
      }
      depth--;
      tokens.push({ kind: 'rparen', depth });
      i++;
      continue;
    }
    // 标识符：包含 [A-Za-z0-9_.\-/]（含 - 以承载 model id）
    let j = i;
    while (j < input.length && /[A-Za-z0-9_.\-/]/.test(input[j] as string)) j++;
    if (j === i) {
      throw new OverrideSkipError(`unexpected character at position ${i}: ${JSON.stringify(ch)}`, {
        kind: 'body',
        name: 'tokenize',
        target: input.slice(i, i + 8),
      });
    }
    tokens.push({ kind: 'string', value: input.slice(i, j) });
    i = j;
  }
  // A5: 所有引号必须已闭合（左括号与右括号数量相等由 depth 检验）
  // depth !== 0 已由 unclosed left parens 检测（depth > 0 意味着还有左括号未匹配）
  if (depth > 0) {
    throw new OverrideSkipError(`unclosed ( (missing ${depth} closing ) )`, {
      kind: 'body',
      name: 'tokenize',
      target: input.slice(0, 64),
    });
  }
  return tokens;
};

class ExprParser {
  pos = 0;

  constructor(private readonly tokens: ExprToken[]) {}

  private peek(): ExprToken | undefined {
    return this.tokens[this.pos];
  }

  private consume(): ExprToken | undefined {
    return this.tokens[this.pos++];
  }

  /** or_expr := and_expr ('||' and_expr)* */
  parseOr(): boolean {
    let left = this.parseAnd();
    while (this.peek()?.kind === 'or') {
      this.consume();
      const right = this.parseAnd();
      left = left || right;
    }
    return left;
  }

  /** and_expr := cmp_expr ('&&' cmp_expr)* */
  parseAnd(): boolean {
    let left = this.parseCmp();
    while (this.peek()?.kind === 'and') {
      this.consume();
      const right = this.parseCmp();
      left = left && right;
    }
    return left;
  }

  /** cmp_expr := primary (('==' | '!=') primary)? ；
   *  无运算符的裸 primary：作为 "true" 字符串字面量判定。 */
  parseCmp(): boolean {
    const left = this.parsePrimary();
    const op = this.peek();
    if (op?.kind === 'eq') {
      this.consume();
      const right = this.parsePrimary();
      return left === right;
    }
    if (op?.kind === 'neq') {
      this.consume();
      const right = this.parsePrimary();
      return left !== right;
    }
    return left === 'true';
  }

  /** primary := STRING | '(' or_expr ')' */
  parsePrimary(): string {
    const tok = this.consume();
    if (!tok) {
      throw new OverrideSkipError('unexpected end of expression', {
        kind: 'body',
        name: 'parse',
        target: 'primary',
      });
    }
    if (tok.kind === 'lparen') {
      const result = this.parseOr();
      const close = this.consume();
      if (close?.kind !== 'rparen') {
        throw new OverrideSkipError('expected ) after (', {
          kind: 'body',
          name: 'parse',
          target: 'primary',
        });
      }
      return result ? 'true' : 'false';
    }
    if (tok.kind === 'string') {
      return tok.value;
    }
    throw new OverrideSkipError(`unexpected token: ${tok.kind}`, {
      kind: 'body',
      name: 'parse',
      target: 'primary',
    });
  }
}

/**
 * 求值已替换（变量已展开）后的表达式为 boolean。
 * A5：解析后必须 pos === tokens.length（EOF），否则抛 OverrideSkipError（fail open）。
 */
const evaluateExpression = (rendered: string): boolean => {
  const tokens = tokenizeExpression(rendered.trim());
  if (tokens.length === 0) return false;
  const parser = new ExprParser(tokens);
  const result = parser.parseOr();
  // A5: 检查是否消费了所有 token（EOF）
  if (parser.pos !== tokens.length) {
    const remaining = tokens
      .slice(parser.pos)
      .map((t) => (t as { kind: string }).kind)
      .join(' ');
    throw new OverrideSkipError(
      `trailing tokens after valid expression: ${remaining || 'unknown'}`,
      {
        kind: 'body',
        name: 'evaluate',
        target: rendered.slice(0, 64),
      },
    );
  }
  return result;
};

/**
 * 渲染轻量模板：替换 {{varName}} 为 ctx 中对应值的字符串形式。
 * 未知变量抛 OverrideSkipError（外层 fail open 处理）。
 *
 * 模板在变量替换后会被 evaluateExpression 解析为 boolean：
 * - 支持运算符：== / != / && / || / ()；
 * - 字符串字面量：双引号或单引号包围；
 * - 裸标识符作为值参与比较或被 === 'true' 判定。
 */
const renderTemplate = (template: string, ctx: OverrideContext): string =>
  template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, varName: string) => {
    if (!TEMPLATE_VARIABLES.has(varName)) {
      throw new OverrideSkipError(`unknown template variable: ${varName}`, {
        kind: 'body',
        name: 'render',
        target: varName,
      });
    }
    const value = ctx[varName as keyof OverrideContext];
    return value === undefined || value === null ? '' : String(value);
  });

/**
 * 条件求值结果（A7：可识别的错误信息）。
 * @returns { matched, error } matched 为 true/false，error 存在时表示求值失败原因。
 * 内部使用；applyOverrides 将错误信息记 warn 日志。
 */
export interface EvaluateConditionResult {
  matched: boolean;
  error?: string;
}

/**
 * 评估条件：渲染模板（变量替换）→ 解析表达式 → 折叠为 boolean。
 * A5: 尾随 token / 未闭合引号 / 括号不匹配抛 OverrideSkipError → error。
 * A7: 条件求值失败返回 { matched: false, error }，由 applyOverrides 统一记 warn。
 */
export const evaluateCondition = (
  template: string,
  ctx: OverrideContext,
): EvaluateConditionResult => {
  let rendered: string;
  try {
    rendered = renderTemplate(template, ctx);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { matched: false, error: `template render failed: ${reason}` };
  }
  try {
    const result = evaluateExpression(rendered);
    return { matched: result };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { matched: false, error: `expression evaluation failed: ${reason}` };
  }
};

/**
 * 主入口：把 applicable overrides 应用到序列化后的 body 与上游 headers。
 *
 * 失败开放语义（对齐 AxonHub）：
 * - A4：预扫描整条 rule 保护字段，发现危险路径/字段 → 整条 rule 跳过；
 * - 模板渲染错误 → 跳过整条 rule（A7 记录 warn 日志）；
 * - body op 抛出 OverrideRuleRejectError（保护字段） → 跳过整条 rule（A4 已预扫，此为兜底）；
 * - body op 抛出其他 Error → 跳过该 op，继续同 rule 内其余 op；
 * - header op 错误 → 跳过该 op，继续；
 * - 整体过程不抛异常给调用方。
 */
export const applyOverrides = (
  body: WireBody,
  headers: Record<string, string>,
  rules: OverrideRule[] | undefined,
  ctx: OverrideContext,
  logger?: Logger,
): OverrideApplyResult => {
  if (!rules || rules.length === 0) {
    return { body, headers };
  }

  for (const rule of rules) {
    try {
      // A4: 预扫描整条 rule 的保护字段/危险路径（body + headers 全部预扫）
      const scanResult = preScanRule(rule, ctx);
      if (scanResult?.reject) {
        logger?.warn(
          {
            scope: rule.scope,
            when: rule.when,
            reason: scanResult.reason,
            op: scanResult.opName,
            target: scanResult.target,
          },
          'override rule rejected by pre-scan (protected field or dangerous path)',
        );
        continue; // A4：整条 rule 跳过（不执行 body，也不执行 headers）
      }

      // 1. 条件渲染
      if (rule.when !== undefined && rule.when.length > 0) {
        const condResult = evaluateCondition(rule.when, ctx);
        if (!condResult.matched) {
          if (condResult.error) {
            // A7: 条件求值失败，记录原因，继续下一条 rule
            logger?.warn(
              {
                scope: rule.scope,
                when: rule.when,
                reason: condResult.error,
              },
              'override rule condition failed (fail open)',
            );
          }
          continue;
        }
      }

      // 2. body 操作（A4：已预扫保护字段，此处仅执行；若预扫通过则整条 rule 执行）
      if (rule.body && rule.body.length > 0) {
        for (const op of rule.body) {
          try {
            const handler = BODY_OP_REGISTRY.get(op.op);
            if (!handler) {
              throw new Error(`unknown body op: ${op.op}`);
            }
            handler(body, op, ctx);
          } catch (err) {
            if (err instanceof OverrideRuleRejectError) {
              logger?.warn(
                {
                  op: err.opName,
                  target: err.target,
                  reason: err.message,
                  scope: rule.scope,
                },
                'override rule rejected (protected field)',
              );
              // A4：保护字段命中 → 整条 rule 跳过（break body + 不执行 headers）
              break;
            }
            logger?.warn(
              {
                op: op.op,
                target: op.path,
                reason: err instanceof Error ? err.message : String(err),
                scope: rule.scope,
              },
              'override body op failed',
            );
            // 单 op 失败：继续同 rule 内其余 op（fail open）
          }
        }
      }

      // 3. header 操作（A4：已在预扫阶段检查 headers 中的危险路径）
      if (rule.headers && rule.headers.length > 0) {
        for (const op of rule.headers) {
          try {
            const handler = HEADER_OP_REGISTRY.get(op.op);
            if (!handler) {
              throw new Error(`unknown header op: ${op.op}`);
            }
            handler(headers, op);
          } catch (err) {
            logger?.warn(
              {
                op: op.op,
                target: op.name,
                reason: err instanceof Error ? err.message : String(err),
                scope: rule.scope,
              },
              'override header op failed',
            );
          }
        }
      }
    } catch (err) {
      logger?.warn(
        {
          scope: rule.scope,
          reason: err instanceof Error ? err.message : String(err),
        },
        'override rule failed',
      );
      // 继续下一条 rule（fail open）
    }
  }

  return { body, headers };
};
