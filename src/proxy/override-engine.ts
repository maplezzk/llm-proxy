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
import type {
  OverrideBodyOp,
  OverrideHeaderOp,
  OverrideRule,
} from '../config/types.ts';
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

/** 模板白名单变量（与 config/validator.ts 的 VALID_OVERRIDE_VARIABLES 对齐）。 */
const TEMPLATE_VARIABLES = new Set([
  'model',
  'logicalModel',
  'provider',
  'providerProtocol',
  'resolvedModel',
]);

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

/** 检查路径顶级段是否命中保护字段。 */
const isProtectedPath = (path: string): boolean => {
  const top = path.split('.')[0] ?? '';
  return PROTECTED_OVERRIDE_PATHS.includes(top);
};

/** 把路径按 '.' 拆分为 segments；空 segments 过滤掉。 */
const splitPath = (path: string): string[] => path.split('.').filter((s) => s.length > 0);

/** 沿路径写入值（创建中间对象）。要求 path 非空。 */
const setPath = (body: WireBody, path: string, value: unknown): void => {
  const segments = splitPath(path);
  if (segments.length === 0) {
    throw new Error('empty path');
  }
  let cursor: Record<string, unknown> = body as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] as string;
    const next = cursor[seg];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = value;
};

/** 探测路径是否存在；返回 { exists, parent, lastKey }。 */
const lookupPath = (
  body: WireBody,
  path: string,
): { exists: boolean; parent?: Record<string, unknown>; lastKey?: string } => {
  const segments = splitPath(path);
  if (segments.length === 0) return { exists: false };
  let cursor: Record<string, unknown> = body as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] as string;
    const next = cursor[seg];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      return { exists: false };
    }
    cursor = next as Record<string, unknown>;
  }
  const lastKey = segments[segments.length - 1] as string;
  if (cursor === null || typeof cursor !== 'object') {
    return { exists: false };
  }
  return { exists: lastKey in cursor, parent: cursor, lastKey };
};

/** 删除路径对应的键（路径不存在时为 no-op）。 */
const deletePath = (body: WireBody, path: string): void => {
  const result = lookupPath(body, path);
  if (result.exists && result.parent && result.lastKey !== undefined) {
    delete result.parent[result.lastKey];
  }
};

// --- 内置 body 操作注册 ---

BODY_OP_REGISTRY.set('set', (body, op, _ctx) => {
  if (isProtectedPath(op.path)) {
    throw new OverrideRuleRejectError(
      `protected path: ${op.path}`,
      { scope: 'adapter-alias', body: [op] },
      op.op,
      op.path,
    );
  }
  setPath(body, op.path, op.value);
});

BODY_OP_REGISTRY.set('set_if_absent', (body, op, _ctx) => {
  if (isProtectedPath(op.path)) {
    throw new OverrideRuleRejectError(
      `protected path: ${op.path}`,
      { scope: 'adapter-alias', body: [op] },
      op.op,
      op.path,
    );
  }
  const result = lookupPath(body, op.path);
  if (!result.exists) {
    setPath(body, op.path, op.value);
  }
});

BODY_OP_REGISTRY.set('delete', (body, op, _ctx) => {
  if (isProtectedPath(op.path)) {
    throw new OverrideRuleRejectError(
      `protected path: ${op.path}`,
      { scope: 'adapter-alias', body: [op] },
      op.op,
      op.path,
    );
  }
  deletePath(body, op.path);
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
  | { kind: 'lparen' }
  | { kind: 'rparen' };

const tokenizeExpression = (input: string): ExprToken[] => {
  const tokens: ExprToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < input.length && input[j] !== quote) {
        if (input[j] === '\\' && j + 1 < input.length) j++;
        j++;
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
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    // 标识符：包含 [A-Za-z0-9_.\-/]（含 - 以承载 model id）
    let j = i;
    while (j < input.length && /[A-Za-z0-9_.\-/]/.test(input[j] as string)) j++;
    if (j === i) {
      throw new Error(`unexpected character at position ${i}: ${JSON.stringify(ch)}`);
    }
    tokens.push({ kind: 'string', value: input.slice(i, j) });
    i = j;
  }
  return tokens;
};

class ExprParser {
  private pos = 0;

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
      throw new Error('unexpected end of expression');
    }
    if (tok.kind === 'lparen') {
      const result = this.parseOr();
      const close = this.consume();
      if (close?.kind !== 'rparen') {
        throw new Error('expected )');
      }
      return result ? 'true' : 'false';
    }
    if (tok.kind === 'string') {
      return tok.value;
    }
    throw new Error(`unexpected token: ${tok.kind}`);
  }
};

/**
 * 求值已替换（变量已展开）后的表达式为 boolean。
 * 解析失败抛 Error，由 evaluateCondition 转为 fail open。
 */
const evaluateExpression = (rendered: string): boolean => {
  const tokens = tokenizeExpression(rendered.trim());
  if (tokens.length === 0) return false;
  const parser = new ExprParser(tokens);
  const result = parser.parseOr();
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
 * 评估条件：渲染模板（变量替换）→ 解析表达式 → 折叠为 boolean。
 * 渲染或解析异常返回 false（fail open；applyOverrides 会另外打日志）。
 * 暴露此函数便于单测和未来复用。
 */
export const evaluateCondition = (template: string, ctx: OverrideContext): boolean => {
  let rendered: string;
  try {
    rendered = renderTemplate(template, ctx);
  } catch {
    // fail open: 未知模板变量 → 视作条件不满足（U5 设计原则，调用方会另行打日志）
    return false;
  }
  try {
    return evaluateExpression(rendered);
  } catch {
    // fail open: 表达式解析失败 → 视作条件不满足（U5 设计原则，调用方会另行打日志）
    return false;
  }
};

/**
 * 主入口：把 applicable overrides 应用到序列化后的 body 与上游 headers。
 *
 * 失败开放语义（对齐 AxonHub）：
 * - 模板渲染错误 → 跳过整条 rule；
 * - body op 抛出 OverrideRuleRejectError（保护字段） → 跳过整条 rule；
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
      // 1. 条件渲染
      if (rule.when !== undefined && rule.when.length > 0) {
        if (!evaluateCondition(rule.when, ctx)) {
          continue;
        }
      }

      // 2. body 操作
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
                },
                'override rule rejected (protected field)',
              );
              // 拒绝整条 rule：跳出 body 循环，再跳出本 rule
              break;
            }
            logger?.warn(
              {
                op: op.op,
                target: op.path,
                reason: err instanceof Error ? err.message : String(err),
              },
              'override body op failed',
            );
            // 单 op 失败：继续同 rule 内其余 op（fail open）
          }
        }
      }

      // 3. header 操作
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