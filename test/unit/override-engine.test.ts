import type { Logger } from 'pino';
/**
 * U5 覆写引擎单元测试。
 *
 * 覆盖：
 * - AE6：设置 reasoning_effort 的规则在条件渲染为 true 时应用。
 * - AE6：targeting 保护字段 model 的规则被拒。
 * - set_if_absent 仅在 path 缺失时写入（edge）。
 * - delete 删除 body path；header set/delete 改 headers（happy）。
 * - false 条件是 no-op（edge）。
 * - 未知模板变量失败开放不崩溃（error）。
 * - 注册新操作扩展注册表（extensibility）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { OverrideBodyOp, OverrideHeaderOp, OverrideRule } from '../../src/config/types.ts';
import type { WireBody } from '../../src/proxy/adapters/index.ts';
import {
  type OverrideContext,
  applyOverrides,
  evaluateCondition,
  registerBodyOp,
  registerHeaderOp,
} from '../../src/proxy/override-engine.ts';

const baseCtx: OverrideContext = {
  model: 'claude-sonnet-4',
  logicalModel: 'claude-sonnet-4',
  provider: 'anthropic-main',
  providerProtocol: 'anthropic',
  resolvedModel: 'claude-sonnet-4-20250514',
};

const silentLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  level: 'info',
} as unknown as Logger;

describe('unit/override-engine: applyOverrides', () => {
  it('AE6: 设置 reasoning_effort 的规则在条件渲染为 true 时应用', () => {
    const body: WireBody = { model: 'claude-sonnet-4' };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        when: '{{model}} == "claude-sonnet-4"',
        body: [{ op: 'set', path: 'reasoning_effort', value: 'high' }],
      },
    ];

    const result = applyOverrides(body, headers, rules, baseCtx, silentLogger);

    expect(result.body.reasoning_effort).toBe('high');
    expect(result.body.model).toBe('claude-sonnet-4');
  });

  it('AE6: targeting 保护字段 model 的规则被拒（运行时双重拦截）', () => {
    const body: WireBody = { model: 'claude-sonnet-4' };
    const headers: Record<string, string> = {};
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set', path: 'model', value: 'hacked' }],
      },
    ];

    const result = applyOverrides(body, headers, rules, baseCtx, silentLogger);

    expect(result.body.model).toBe('claude-sonnet-4');
  });

  it('AE6: 保护字段 messages 同样拒绝', () => {
    const body: WireBody = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set', path: 'messages', value: [] }],
      },
    ];

    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);

    expect(result.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('保护字段是 path 顶级段：metadata.model 仍允许覆盖（只顶级段被保护）', () => {
    const body: WireBody = { model: 'x', metadata: { source: 'old' } };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set', path: 'metadata.model', value: 'override' }],
      },
    ];

    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);

    expect((result.body.metadata as Record<string, unknown>).model).toBe('override');
  });

  it('set_if_absent 仅在 path 缺失时写入', () => {
    const body: WireBody = { model: 'x', temperature: 0.5 };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [
          { op: 'set_if_absent', path: 'temperature', value: 0.9 },
          { op: 'set_if_absent', path: 'top_p', value: 0.95 },
        ],
      },
    ];

    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);

    expect(result.body.temperature).toBe(0.5);
    expect(result.body.top_p).toBe(0.95);
  });

  it('set_if_absent 在嵌套路径缺失时创建父对象并写入', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set_if_absent', path: 'metadata.debug', value: true }],
      },
    ];

    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);

    expect((result.body.metadata as Record<string, unknown>).debug).toBe(true);
  });

  it('delete 移除 body path；header set/delete 改 headers', () => {
    const body: WireBody = {
      model: 'x',
      metadata: { debug: true, keep: 'yes' },
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Internal': 'secret',
    };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'delete', path: 'metadata.debug' }],
        headers: [
          { op: 'set', name: 'X-Channel', value: 'kiro' },
          { op: 'delete', name: 'X-Internal' },
        ],
      },
    ];

    const result = applyOverrides(body, headers, rules, baseCtx, silentLogger);

    expect((result.body.metadata as Record<string, unknown>).debug).toBeUndefined();
    expect((result.body.metadata as Record<string, unknown>).keep).toBe('yes');
    expect(result.headers['X-Channel']).toBe('kiro');
    expect(result.headers['X-Internal']).toBeUndefined();
  });

  it('false 条件是 no-op（edge）', () => {
    const body: WireBody = { model: 'claude-sonnet-4' };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        when: '{{model}} == "other-model"',
        body: [{ op: 'set', path: 'reasoning_effort', value: 'high' }],
      },
    ];

    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);

    expect(result.body.reasoning_effort).toBeUndefined();
  });

  it('当没有 when 字段时规则默认应用', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set', path: 'temperature', value: 0.7 }],
      },
    ];

    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);

    expect(result.body.temperature).toBe(0.7);
  });

  it('未知模板变量失败开放不崩溃（error）', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        when: '{{unknownVar}} == "true"',
        body: [{ op: 'set', path: 'reasoning_effort', value: 'high' }],
      },
    ];

    const expectNoThrow = () => applyOverrides(body, {}, rules, baseCtx, silentLogger);
    expect(expectNoThrow).not.toThrow();

    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);
    // 因 when 渲染失败 → rule 被跳过（fail open）
    expect(result.body.reasoning_effort).toBeUndefined();
  });

  it('当模板渲染结果非 "true" 字符串时规则不应用', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        when: '{{model}} == "other"',
        body: [{ op: 'set', path: 'reasoning_effort', value: 'high' }],
      },
    ];

    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);

    expect(result.body.reasoning_effort).toBeUndefined();
  });

  it('evaluateCondition 接受带空白的 "true"', () => {
    expect(evaluateCondition('  true  ', baseCtx).matched).toBe(true);
    expect(evaluateCondition('true', baseCtx).matched).toBe(true);
    expect(evaluateCondition('false', baseCtx).matched).toBe(false);
    expect(evaluateCondition('  false ', baseCtx).matched).toBe(false);
    // {{model}} == "other-model" 渲染后 "claude-sonnet-4" == "other-model" → false
    expect(evaluateCondition('{{model}} == "other-model"', baseCtx).matched).toBe(false);
  });

  it('evaluateCondition 在模板变量未知时失败开放返回 { matched: false, error }', () => {
    const result = evaluateCondition('{{unknown}}', baseCtx);
    expect(result.matched).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('空规则列表直接返回原 body/headers', () => {
    const body: WireBody = { model: 'x' };
    const headers: Record<string, string> = { A: 'B' };
    const result = applyOverrides(body, headers, [], baseCtx, silentLogger);
    expect(result.body).toEqual(body);
    expect(result.headers).toEqual(headers);
  });

  it('undefined 规则列表（直连路径）直接返回原 body/headers', () => {
    const body: WireBody = { model: 'x' };
    const headers: Record<string, string> = { A: 'B' };
    const result = applyOverrides(body, headers, undefined, baseCtx, silentLogger);
    expect(result.body).toEqual(body);
    expect(result.headers).toEqual(headers);
  });

  it('header set 不带 value 时使用空字符串（fail open）', () => {
    const body: WireBody = { model: 'x' };
    const headers: Record<string, string> = {};
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        headers: [{ op: 'set', name: 'X-Empty', value: '' }],
      },
    ];

    const result = applyOverrides(body, headers, rules, baseCtx, silentLogger);

    expect(result.headers['X-Empty']).toBe('');
  });

  it('extensibility: 注册新 body 操作后引擎识别并应用', () => {
    // 注册 'uppercase' 操作：把 path 指向的字符串值转大写
    registerBodyOp('uppercase', (body, op, _ctx) => {
      const segments = op.path.split('.');
      let cursor: Record<string, unknown> = body as Record<string, unknown>;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i] as string;
        const next = cursor[seg];
        if (typeof next !== 'object' || next === null) {
          throw new Error(`path not navigable: ${op.path}`);
        }
        cursor = next as Record<string, unknown>;
      }
      const last = segments[segments.length - 1] as string;
      const current = cursor[last];
      if (typeof current !== 'string') {
        throw new Error(`uppercase requires string value at ${op.path}`);
      }
      cursor[last] = current.toUpperCase();
    });

    const body: WireBody = { model: 'x', name: 'hello' };
    // 'uppercase' 为 registerBodyOp 扩展的额外 op，类型允许任意字符串
    const op: OverrideBodyOp = { op: 'uppercase', path: 'name' };
    const rules: OverrideRule[] = [{ scope: 'adapter-alias', body: [op] }];

    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);

    expect(result.body.name).toBe('HELLO');
  });

  it('extensibility: 注册新 header 操作后引擎识别并应用', () => {
    registerHeaderOp('lowercase', (headers, op) => {
      if (op.value === undefined) throw new Error('lowercase requires value');
      headers[op.name] = op.value.toLowerCase();
    });

    const headers: Record<string, string> = {};
    const op: OverrideHeaderOp = { op: 'lowercase', name: 'X-Custom', value: 'HELLO' };
    const rules: OverrideRule[] = [{ scope: 'adapter-alias', headers: [op] }];

    const result = applyOverrides({}, headers, rules, baseCtx, silentLogger);

    expect(result.headers['X-Custom']).toBe('hello');
  });

  it('未知 body op 失败开放（fail open）', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        // 类型断言：模拟未知 op
        body: [{ op: 'unknown_op' as unknown as 'set', path: 'temperature', value: 0.7 }],
      },
    ];

    const expectNoThrow = () => applyOverrides(body, {}, rules, baseCtx, silentLogger);
    expect(expectNoThrow).not.toThrow();

    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);
    expect(result.body.temperature).toBeUndefined();
  });

  it('未知 header op 失败开放', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        headers: [{ op: 'unknown_op' as unknown as 'set', name: 'X-Test', value: 'x' }],
      },
    ];

    const expectNoThrow = () => applyOverrides(body, {}, rules, baseCtx, silentLogger);
    expect(expectNoThrow).not.toThrow();
  });

  it('set 操作覆盖嵌套路径（创建中间对象）', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set', path: 'a.b.c', value: 'leaf' }],
      },
    ];

    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);

    const a = result.body.a as Record<string, Record<string, unknown>>;
    expect(a.b.c).toBe('leaf');
  });

  it('不同 scope（adapter-alias / channel）的规则都适用', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set', path: 'reasoning_effort', value: 'high' }],
      },
      {
        scope: 'channel',
        body: [{ op: 'set', path: 'temperature', value: 0.7 }],
      },
    ];

    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);

    expect(result.body.reasoning_effort).toBe('high');
    expect(result.body.temperature).toBe(0.7);
  });

  it('多 rule 多 op 按声明顺序应用', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [
          { op: 'set', path: 'temperature', value: 0.5 },
          { op: 'set', path: 'temperature', value: 0.9 },
        ],
      },
    ];

    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);

    expect(result.body.temperature).toBe(0.9);
  });

  it('模板支持所有白名单变量', () => {
    const body: WireBody = { model: 'x' };
    const ctx: OverrideContext = {
      model: 'm',
      logicalModel: 'lm',
      provider: 'p',
      providerProtocol: 'anthropic',
      resolvedModel: 'rm',
    };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        when: '{{model}} == "m" && {{logicalModel}} == "lm" && {{provider}} == "p" && {{providerProtocol}} == "anthropic" && {{resolvedModel}} == "rm"',
        body: [{ op: 'set', path: 'hit', value: true }],
      },
    ];

    const result = applyOverrides(body, {}, rules, ctx, silentLogger);

    expect(result.body.hit).toBe(true);
  });

// =====================================================================
// A1 回归测试：原型链污染防护（__proto__ / constructor / prototype）
// =====================================================================

  it('A1: set __proto__.polluted 拒绝（原型链污染防护）', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      { scope: 'adapter-alias', body: [{ op: 'set', path: '__proto__.polluted', value: 'hacked' }] },
    ];
    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);
    // A1: Object.prototype 不应被污染（跨请求）
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result.body.model).toBe('x');
    // body['__proto__'] 返回原型链引用，非 own 属性 → 用 hasOwn 验证
    expect(Object.hasOwn(result.body, '__proto__')).toBe(false);
  });

  it('A1: set constructor.prototype.foo 拒绝（原型链污染防护）', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set', path: 'constructor.prototype.foo', value: 'bar' }],
      },
    ];
    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);
    expect(result.body.model).toBe('x');
  });

  it('A1: set a.__proto__.x 拒绝（中间段为 __proto__）', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      { scope: 'adapter-alias', body: [{ op: 'set', path: 'a.__proto__.x', value: 'y' }] },
    ];
    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);
    expect(result.body.model).toBe('x');
  });

  it('A1: delete __proto__ 拒绝（原型链污染防护）', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      { scope: 'adapter-alias', body: [{ op: 'delete', path: '__proto__' }] },
    ];
    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);
    expect(result.body.model).toBe('x');
  });

  it('A1: lookupPath 用 Object.hasOwn 不接受继承属性', () => {
    const body: WireBody = Object.create(null) as WireBody;
    (body as Record<string, unknown>).ownProp = 'mine';
    // __proto__ 作为自有键（Object.create(null) 无原型）
    (body as Record<string, unknown>)['__proto__'] = 'should_not_be_seen';
    const rules: OverrideRule[] = [
      { scope: 'adapter-alias', body: [{ op: 'set', path: 'ownProp', value: 'overwritten' }] },
    ];
    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);
    expect((result.body as Record<string, unknown>).ownProp).toBe('overwritten');
    // A1：__proto__ 保留为自有键（set ownProp 不应改 __proto__）
    expect(Object.hasOwn(result.body, '__proto__')).toBe(true);
    expect((result.body as Record<string, unknown>)['__proto__']).toBe('should_not_be_seen');
  });

  // =====================================================================
  // A2 回归测试：保护字段前导点绕过（.model / ..messages）
  // =====================================================================

  it('A2: .model 拒绝（规范化后首段为 model，受保护）', () => {
    const body: WireBody = { model: 'original' };
    const rules: OverrideRule[] = [
      { scope: 'adapter-alias', body: [{ op: 'set', path: '.model', value: 'hacked' }] },
    ];
    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);
    expect(result.body.model).toBe('original');
  });

  it('A2: ..messages 拒绝（规范化后首段为 messages，受保护）', () => {
    const body: WireBody = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
    const rules: OverrideRule[] = [
      { scope: 'adapter-alias', body: [{ op: 'set', path: '..messages', value: [] }] },
    ];
    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);
    expect(result.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('A2: ...stream 拒绝（三个点，空段后接 stream）', () => {
    const body: WireBody = { model: 'x', stream: true };
    const rules: OverrideRule[] = [
      { scope: 'adapter-alias', body: [{ op: 'delete', path: '...stream' }] },
    ];
    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);
    expect(result.body.stream).toBe(true);
  });

  it('A2: metadata.model 不受保护（顶级段是 metadata，非保护字段）', () => {
    const body: WireBody = { model: 'x', metadata: { source: 'old' } };
    const rules: OverrideRule[] = [
      { scope: 'adapter-alias', body: [{ op: 'set', path: 'metadata.model', value: 'override' }] },
    ];
    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);
    expect((result.body.metadata as Record<string, unknown>).model).toBe('override');
    expect(result.body.model).toBe('x');
  });

  it('A2: leading dot + __proto__ 拒绝（双重防护）', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      { scope: 'adapter-alias', body: [{ op: 'set', path: '.__proto__.x', value: 'y' }] },
    ];
    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);
    expect(result.body.model).toBe('x');
  });

  // =====================================================================
  // A3 回归测试：reasoningDisabled 保护 reasoning 相关字段（R14）
  // =====================================================================

  it('A3: reasoningDisabled=true 时 reasoning_effort 被保护', () => {
    const body: WireBody = { model: 'x' };
    const ctx = { ...baseCtx, reasoningDisabled: true };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set', path: 'reasoning_effort', value: 'high' }],
      },
    ];
    const result = applyOverrides(body, {}, rules, ctx, silentLogger);
    expect(result.body.reasoning_effort).toBeUndefined();
  });

  it('A3: reasoningDisabled=true 时 thinking 被保护', () => {
    const body: WireBody = { model: 'x' };
    const ctx = { ...baseCtx, reasoningDisabled: true };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set', path: 'thinking', value: { type: 'enabled' } }],
      },
    ];
    const result = applyOverrides(body, {}, rules, ctx, silentLogger);
    expect(result.body.thinking).toBeUndefined();
  });

  it('A3: reasoningDisabled=true 时 reasoning（OpenAI）被保护', () => {
    const body: WireBody = { model: 'x' };
    const ctx = { ...baseCtx, reasoningDisabled: true };
    const rules: OverrideRule[] = [
      { scope: 'adapter-alias', body: [{ op: 'set', path: 'reasoning', value: { effort: 'high' } }] },
    ];
    const result = applyOverrides(body, {}, rules, ctx, silentLogger);
    expect((result.body as Record<string, unknown>).reasoning).toBeUndefined();
  });

  it('A3: reasoningDisabled=false 时 reasoning_effort 正常可写', () => {
    const body: WireBody = { model: 'x' };
    const ctx = { ...baseCtx, reasoningDisabled: false };
    const rules: OverrideRule[] = [
      { scope: 'adapter-alias', body: [{ op: 'set', path: 'reasoning_effort', value: 'high' }] },
    ];
    const result = applyOverrides(body, {}, rules, ctx, silentLogger);
    expect(result.body.reasoning_effort).toBe('high');
  });

  it('A3: reasoningDisabled=undefined 时 reasoning_effort 正常可写', () => {
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      { scope: 'adapter-alias', body: [{ op: 'set', path: 'reasoning_effort', value: 'high' }] },
    ];
    const result = applyOverrides(body, {}, rules, baseCtx, silentLogger);
    expect(result.body.reasoning_effort).toBe('high');
  });

  // =====================================================================
  // A4 回归测试：整条 rule 跳过（保护 body op 不执行后续 body，也不执行 headers）
  // =====================================================================

  it('A4: 保护 body op + 同 rule header op → header 不执行（整条 rule 跳过）', () => {
    const headers: Record<string, string> = {};
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set', path: 'model', value: 'hacked' }], // 保护，rule 被拒
        headers: [{ op: 'set', name: 'X-Should-Not-Be-Set', value: 'BAD' }],
      },
    ];
    const result = applyOverrides({ model: 'x' }, headers, rules, baseCtx, silentLogger);
    expect(result.body.model).toBe('x');
    expect(result.headers['X-Should-Not-Be-Set']).toBeUndefined();
  });

  it('A4: set_if_absent 保护字段 → 同 rule headers 不执行', () => {
    const headers: Record<string, string> = {};
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set_if_absent', path: '.messages', value: [] }], // 保护
        headers: [{ op: 'set', name: 'X-Block-This', value: 'blocked' }],
      },
    ];
    const result = applyOverrides({ model: 'x' }, headers, rules, baseCtx, silentLogger);
    expect(result.headers['X-Block-This']).toBeUndefined();
  });

  it('A4: delete 保护字段 → 同 rule headers 不执行', () => {
    const headers: Record<string, string> = {};
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'delete', path: '..stream' }], // 保护
        headers: [{ op: 'set', name: 'X-Block-Also', value: 'blocked' }],
      },
    ];
    const result = applyOverrides({ model: 'x', stream: true }, headers, rules, baseCtx, silentLogger);
    expect(result.headers['X-Block-Also']).toBeUndefined();
  });

  it('A4: __proto__ 危险路径 → 同 rule headers 不执行', () => {
    const headers: Record<string, string> = {};
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set', path: '__proto__.evil', value: 'X' }], // 危险
        headers: [{ op: 'set', name: 'X-Evil-Header', value: 'blocked' }],
      },
    ];
    const result = applyOverrides({ model: 'x' }, headers, rules, baseCtx, silentLogger);
    expect(result.headers['X-Evil-Header']).toBeUndefined();
  });

  // =====================================================================
  // A5 回归测试：表达式解析 EOF 检查（尾随 token / 未闭合引号）
  // =====================================================================

  it('A5: 尾随 token "true garbage" 不解析为 true（返回 matched: false）', () => {
    const result = evaluateCondition('true garbage', baseCtx);
    expect(result.matched).toBe(false);
    expect(result.error).toContain('trailing tokens');
  });

  it('A5: 尾随 token "true)" 不解析为 true（tokenizer 拒绝）', () => {
    const result = evaluateCondition('true)', baseCtx);
    expect(result.matched).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('A5: 未闭合引号 "hello 报错（matched: false）', () => {
    const result = evaluateCondition('"hello', baseCtx);
    expect(result.matched).toBe(false);
    expect(result.error).toContain('unclosed string literal');
  });

  it('A5: 未闭合单引号 \'world 报错（matched: false）', () => {
    const result = evaluateCondition("'world", baseCtx);
    expect(result.matched).toBe(false);
    expect(result.error).toContain('unclosed string literal');
  });

  it('A5: 未闭合括号 1 && (2 报错（matched: false）', () => {
    const result = evaluateCondition('1 && (2', baseCtx);
    expect(result.matched).toBe(false);
    expect(result.error).toContain('unclosed');
  });

  it('A5: 多余右括号报错（tokenizer depth=0 时拒绝）', () => {
    const result = evaluateCondition('true))', baseCtx);
    expect(result.matched).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('A5: 有效表达式 "deep" == "deep" 解析为 true', () => {
    const ctx = { ...baseCtx, model: 'deep' };
    const result = evaluateCondition('"deep" == "deep"', ctx);
    expect(result.matched).toBe(true);
  });

  it('A5: 尾随标识符 "true extra" 被拒绝（需 pos===tokens.length）', () => {
    const result = evaluateCondition('true extra', baseCtx);
    expect(result.matched).toBe(false);
    expect(result.error).toContain('trailing tokens');
  });

  // =====================================================================
  // A7 回归测试：条件求值失败 → { matched: false, error } + warn 日志
  // =====================================================================

  it('A7: evaluateCondition 未知变量返回 { matched: false, error }', () => {
    const result = evaluateCondition('{{unknown_var}}', baseCtx);
    expect(result.matched).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('unknown template variable');
  });

  it('A7: evaluateCondition 表达式解析失败返回 { matched: false, error }', () => {
    const result = evaluateCondition('@@@invalid@@@', baseCtx);
    expect(result.matched).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('A7: 条件失败时 applyOverrides 记录 warn 日志（模板变量未知）', () => {
    const logger = { ...silentLogger, warn: vi.fn() };
    const body: WireBody = { model: 'x' };
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        when: '{{unknown_var_that_does_not_exist}}', // 渲染失败
        body: [{ op: 'set', path: 'temperature', value: 0.5 }],
      },
    ];
    applyOverrides(body, {}, rules, baseCtx, logger);
    // 模板渲染失败 → Outer catch block → logger.warn({...}, 'override rule failed')
    expect(logger.warn).toHaveBeenCalled();
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    // warn 签名：warn(contextObj, messageString)，message 在第二个参数
    const ruleFailCalls = warnCalls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('rule'),
    );
    expect(ruleFailCalls.length).toBeGreaterThan(0);
  });

  // =====================================================================
  // A8 回归测试：when 资源上限（字节长度 / token 数 / 括号深度）
  // =====================================================================

  it('A8: when 超过 MAX_WHEN_BYTES（2048 字节）被拒绝', () => {
    const result = evaluateCondition('x'.repeat(3000), baseCtx);
    expect(result.matched).toBe(false);
    expect(result.error).toContain('exceeds');
    expect(result.error).toContain('bytes');
  });

  it('A8: when 括号深度超过 MAX_BRACKET_DEPTH（32）被拒绝', () => {
    const depth = 35;
    const expr = '('.repeat(depth) + 'true' + ')'.repeat(depth);
    const result = evaluateCondition(expr, baseCtx);
    expect(result.matched).toBe(false);
    expect(result.error).toContain('bracket depth');
  });

  it('A8: 正常嵌套括号（深度 5）在限制内通过', () => {
    const expr = '(((((' + 'true' + ')))))';
    const result = evaluateCondition(expr, baseCtx);
    expect(result.matched).toBe(true);
  });
});
