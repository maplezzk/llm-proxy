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
    expect(evaluateCondition('  true  ', baseCtx)).toBe(true);
    expect(evaluateCondition('true', baseCtx)).toBe(true);
    expect(evaluateCondition('false', baseCtx)).toBe(false);
    expect(evaluateCondition('  false ', baseCtx)).toBe(false);
    // {{model}} == "other-model" 渲染后 "claude-sonnet-4" == "other-model" → false
    expect(evaluateCondition('{{model}} == "other-model"', baseCtx)).toBe(false);
  });

  it('evaluateCondition 在模板变量未知时失败开放返回 false', () => {
    expect(evaluateCondition('{{unknown}}', baseCtx)).toBe(false);
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
});
