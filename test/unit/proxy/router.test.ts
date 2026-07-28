// P1.12 阶段 A：从 legacy-test/adapter/router.test.ts 机械迁移（node:test → vitest）
// P1.15 切流：被测对象改指 src 新模块（src/proxy/router.ts，合并了直连 + 适配器路由）。
// U3（model-centric router）：补充 routeLogicalModel / selectRoute / 重构 resolveAdapterRoute 的用例。
//
// 适配说明（U3 新契约）：
// - resolveAdapterRoute 返回 routes[]（候选列表），不再返回单 route；
//   入站协议与 onFailure 仍在 AdapterRouteResult 上。
// - selectRoute(decisions) 返回 { selected, alternatives }，selected.alternatives 也挂载。
// - RouteDecision 新增 priority / contextWindow / maxOutputTokens / alternatives 字段。
// - 新错误码：ROUTE_GROUP_NOT_FOUND / ROUTE_NO_ELIGIBLE_CHANNEL / ROUTE_ALL_FAILED。
//
// 旧错误码语义保留：ADAPTER_NOT_FOUND / MODEL_MAPPING_NOT_FOUND / PROVIDER_NOT_FOUND / MODEL_NOT_FOUND。
import { describe, expect, it } from 'vitest';
import { ConfigStore } from '../../../src/config/store.ts';
import type { Config } from '../../../src/config/types.ts';
import {
  type AdapterError,
  resolveAdapterRoute,
  routeLogicalModel,
  selectRoute,
} from '../../../src/proxy/router.ts';

function createStore(): ConfigStore {
  const config: Config = {
    providers: [
      {
        name: 'anthropic-main',
        type: 'anthropic',
        apiKey: 'sk-ant-1',
        models: [{ id: 'claude-sonnet-4-20250514' }],
      },
      {
        name: 'openai-main',
        type: 'openai',
        apiKey: 'sk-openai-1',
        apiBase: 'https://api.openai.com',
        models: [{ id: 'gpt-4o' }],
      },
    ],
    adapters: [
      {
        name: 'claude-code',
        type: 'anthropic',
        models: [
          {
            sourceModelId: 'sonnet',
            provider: 'anthropic-main',
            targetModelId: 'claude-sonnet-4-20250514',
          },
          { sourceModelId: 'fast', provider: 'openai-main', targetModelId: 'gpt-4o' },
        ],
      },
    ],
  };
  return new ConfigStore('/fake', config);
}

// 捕获 fn 抛出的错误，便于断言其错误码（等价于原 assert.throws 的 predicate 校验）
function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

// ===================== 旧适配器路由回归（U3 适配） =====================

describe('proxy/router（适配器路由 - 回归）', () => {
  it('同协议映射到 Anthropic Provider', () => {
    const store = createStore();
    const result = resolveAdapterRoute(store, 'claude-code', 'sonnet');
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.providerId).toBe('anthropic-main');
    expect(result.routes[0]?.providerProtocol).toBe('anthropic');
    expect(result.routes[0]?.resolvedModel).toBe('claude-sonnet-4-20250514');
    expect(result.inboundType).toBe('anthropic');
    expect(result.isPinnedChannel).toBe(false);
  });

  it('跨协议映射到 OpenAI Provider（Anthropic 格式 → OpenAI 上游）', () => {
    const store = createStore();
    const result = resolveAdapterRoute(store, 'claude-code', 'fast');
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.providerId).toBe('openai-main');
    expect(result.routes[0]?.providerProtocol).toBe('openai');
    expect(result.routes[0]?.resolvedModel).toBe('gpt-4o');
    expect(result.inboundType).toBe('anthropic'); // 适配器格式不变
  });

  it('适配器名称不存在时抛错', () => {
    const store = createStore();
    const err = catchError(() =>
      resolveAdapterRoute(store, 'nonexistent', 'sonnet'),
    ) as AdapterError;
    expect(err?.code).toBe('ADAPTER_NOT_FOUND');
  });

  it('工具模型名在适配器映射中不存在时抛错', () => {
    const store = createStore();
    const err = catchError(() =>
      resolveAdapterRoute(store, 'claude-code', 'nonexistent'),
    ) as AdapterError;
    expect(err?.code).toBe('MODEL_MAPPING_NOT_FOUND');
  });

  it('映射的 Provider 不存在时抛错', () => {
    const config: Config = {
      providers: [],
      adapters: [
        {
          name: 'test-adapter',
          type: 'openai',
          models: [{ sourceModelId: 'm', provider: 'nonexistent-provider', targetModelId: 'm' }],
        },
      ],
    };
    const store = new ConfigStore('/fake', config);
    const err = catchError(() => resolveAdapterRoute(store, 'test-adapter', 'm')) as AdapterError;
    expect(err?.code).toBe('PROVIDER_NOT_FOUND');
  });

  it('映射的 Model 在 Provider 中不存在时抛错', () => {
    const config: Config = {
      providers: [{ name: 'p', type: 'openai', apiKey: 'k', models: [{ id: 'real' }] }],
      adapters: [
        {
          name: 'a',
          type: 'openai',
          models: [{ sourceModelId: 'm', provider: 'p', targetModelId: 'nonexistent-model' }],
        },
      ],
    };
    const store = new ConfigStore('/fake', config);
    const err = catchError(() => resolveAdapterRoute(store, 'a', 'm')) as AdapterError;
    expect(err?.code).toBe('MODEL_NOT_FOUND');
  });

  it('legacy 映射保留：onFailure 默认 hard_fail', () => {
    const store = createStore();
    const result = resolveAdapterRoute(store, 'claude-code', 'sonnet');
    expect(result.onFailure).toBe('hard_fail');
  });

  it('legacy 映射保留：onFailure 显式 fallback', () => {
    const config: Config = {
      providers: [{ name: 'p', type: 'openai', apiKey: 'k', models: [{ id: 'real' }] }],
      adapters: [
        {
          name: 'a',
          type: 'openai',
          onFailure: 'fallback',
          models: [{ sourceModelId: 'm', provider: 'p', targetModelId: 'real' }],
        },
      ],
    };
    const store = new ConfigStore('/fake', config);
    const result = resolveAdapterRoute(store, 'a', 'm');
    expect(result.onFailure).toBe('fallback');
  });
});

// ===================== U3: routeLogicalModel =====================

/**
 * 构造多个 provider + 一个或多个 model groups 的 config。
 * - provider 默认带 gp1/gp2/kiro/cc 几个 provider
 * - model groups 通过参数注入
 */
function makeModelGroupStore(
  modelGroups: NonNullable<Config['modelGroups']>,
  extraAdapters: Config['adapters'] = [],
): ConfigStore {
  const config: Config = {
    providers: [
      {
        name: 'gpt',
        type: 'openai',
        apiKey: 'sk-gpt',
        models: [
          { id: 'gpt-1m', contextWindow: 1_000_000 },
          { id: 'gpt-255k', contextWindow: 255_000 },
        ],
      },
      {
        name: 'kiro',
        type: 'openai',
        apiKey: 'sk-kiro',
        models: [{ id: 'kiro-255k', contextWindow: 255_000 }],
      },
      {
        name: 'cc',
        type: 'anthropic',
        apiKey: 'sk-cc',
        models: [{ id: 'cc-255k', contextWindow: 255_000 }],
      },
    ],
    modelGroups,
    adapters: extraAdapters,
  };
  return new ConfigStore('/fake', config);
}

describe('proxy/router（U3 routeLogicalModel）', () => {
  it('happy: 多渠道模型按 priority 升序返回候选', () => {
    const store = makeModelGroupStore([
      {
        id: 'gpt-5.6-fast',
        channels: [
          { provider: 'kiro', model: 'kiro-255k', priority: 2 },
          { provider: 'cc', model: 'cc-255k', priority: 1 },
        ],
      },
    ]);
    const decisions = routeLogicalModel(store, 'gpt-5.6-fast');
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.providerId).toBe('cc');
    expect(decisions[0]?.priority).toBe(1);
    expect(decisions[0]?.resolvedModel).toBe('cc-255k');
    expect(decisions[1]?.providerId).toBe('kiro');
    expect(decisions[1]?.priority).toBe(2);
    expect(decisions[1]?.resolvedModel).toBe('kiro-255k');
  });

  it('AE1: 1M 模型带 1M + 255k 渠道，只路由到 1M 渠道（R5 档位过滤）', () => {
    const store = makeModelGroupStore([
      {
        id: 'gpt-5.6-1m',
        contextWindow: 1_000_000,
        channels: [
          { provider: 'gpt', model: 'gpt-1m', priority: 1, contextWindow: 1_000_000 },
          { provider: 'kiro', model: 'kiro-255k', priority: 2, contextWindow: 255_000 },
          { provider: 'cc', model: 'cc-255k', priority: 3, contextWindow: 255_000 },
        ],
      },
    ]);
    const decisions = routeLogicalModel(store, 'gpt-5.6-1m');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.providerId).toBe('gpt');
    expect(decisions[0]?.resolvedModel).toBe('gpt-1m');
    expect(decisions[0]?.priority).toBe(1);
    expect(decisions[0]?.contextWindow).toBe(1_000_000);
  });

  it('渠道无 contextWindow 时回退到模型默认；仍低于组档位的被丢弃', () => {
    const config: Config = {
      providers: [
        {
          name: 'gpt',
          type: 'openai',
          apiKey: 'sk',
          models: [
            { id: 'gpt-1m', contextWindow: 1_000_000 },
            { id: 'gpt-255k', contextWindow: 255_000 },
          ],
        },
      ],
      modelGroups: [
        {
          id: 'gpt-5.6-1m',
          contextWindow: 500_000,
          channels: [
            // 渠道未声明 contextWindow，回退到模型默认 1_000_000 → 保留
            { provider: 'gpt', model: 'gpt-1m', priority: 1 },
            // 渠道未声明 contextWindow，回退到模型默认 255_000 → 低于 500k → 丢弃
            { provider: 'gpt', model: 'gpt-255k', priority: 2 },
          ],
        },
      ],
    };
    const store = new ConfigStore('/fake', config);
    const decisions = routeLogicalModel(store, 'gpt-5.6-1m');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.resolvedModel).toBe('gpt-1m');
  });

  it('未找到逻辑模型抛 ROUTE_GROUP_NOT_FOUND', () => {
    const store = makeModelGroupStore([]);
    const err = catchError(() => routeLogicalModel(store, 'nonexistent')) as AdapterError;
    expect(err?.code).toBe('ROUTE_GROUP_NOT_FOUND');
  });

  it('渠道都低于档位抛 ROUTE_NO_ELIGIBLE_CHANNEL', () => {
    const store = makeModelGroupStore([
      {
        id: 'gpt-5.6-1m',
        contextWindow: 1_000_000,
        channels: [
          { provider: 'kiro', model: 'kiro-255k', priority: 1, contextWindow: 255_000 },
          { provider: 'cc', model: 'cc-255k', priority: 2, contextWindow: 255_000 },
        ],
      },
    ]);
    const err = catchError(() => routeLogicalModel(store, 'gpt-5.6-1m')) as AdapterError;
    expect(err?.code).toBe('ROUTE_NO_ELIGIBLE_CHANNEL');
  });

  it('档位过滤排除所有低档渠道（edge：单一低档渠道也清空候选）', () => {
    const store = makeModelGroupStore([
      {
        id: 'gpt-5.6-1m',
        contextWindow: 1_000_000,
        channels: [{ provider: 'kiro', model: 'kiro-255k', priority: 1, contextWindow: 255_000 }],
      },
    ]);
    const err = catchError(() => routeLogicalModel(store, 'gpt-5.6-1m')) as AdapterError;
    expect(err?.code).toBe('ROUTE_NO_ELIGIBLE_CHANNEL');
  });

  it('capacities 透传：contextWindow 与 maxOutputTokens 出现在 RouteDecision 上', () => {
    const store = makeModelGroupStore([
      {
        id: 'gpt-5.6-fast',
        channels: [
          {
            provider: 'kiro',
            model: 'kiro-255k',
            priority: 1,
            contextWindow: 255_000,
            maxOutputTokens: 8192,
          },
        ],
      },
    ]);
    const decisions = routeLogicalModel(store, 'gpt-5.6-fast');
    expect(decisions[0]?.contextWindow).toBe(255_000);
    expect(decisions[0]?.maxOutputTokens).toBe(8192);
  });

  it('priority 缺失时回退到 provider.priority，再回退到 0', () => {
    const config: Config = {
      providers: [
        { name: 'p1', type: 'openai', apiKey: 'k', priority: 5, models: [{ id: 'm1' }] },
        { name: 'p2', type: 'openai', apiKey: 'k', priority: 1, models: [{ id: 'm2' }] },
        { name: 'p3', type: 'openai', apiKey: 'k', models: [{ id: 'm3' }] },
      ],
      modelGroups: [
        {
          id: 'g-fast',
          channels: [
            { provider: 'p1', model: 'm1' }, // priority = 5
            { provider: 'p2', model: 'm2' }, // priority = 1
            { provider: 'p3', model: 'm3' }, // priority = 0
          ],
        },
      ],
    };
    const store = new ConfigStore('/fake', config);
    const decisions = routeLogicalModel(store, 'g-fast');
    expect(decisions.map((d) => d.priority)).toEqual([0, 1, 5]);
    expect(decisions.map((d) => d.providerId)).toEqual(['p3', 'p2', 'p1']);
  });

  it('provider 被禁用时该渠道被丢弃（enabled=false）', () => {
    const config: Config = {
      providers: [
        { name: 'p1', type: 'openai', apiKey: 'k', models: [{ id: 'm1' }] },
        { name: 'p2', type: 'openai', apiKey: 'k', enabled: false, models: [{ id: 'm2' }] },
      ],
      modelGroups: [
        {
          id: 'g',
          channels: [
            { provider: 'p1', model: 'm1', priority: 1 },
            { provider: 'p2', model: 'm2', priority: 2 },
          ],
        },
      ],
    };
    const store = new ConfigStore('/fake', config);
    const decisions = routeLogicalModel(store, 'g');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.providerId).toBe('p1');
  });
});

// ===================== U3: selectRoute =====================

describe('proxy/router（U3 selectRoute）', () => {
  const makeDecision = (providerId: string, priority: number) => ({
    providerId,
    providerProtocol: 'openai' as const,
    apiBase: 'https://api.example.com',
    credentialHandle: 'sk',
    resolvedModel: 'm',
    thinking: { source: 'route' as const },
    streamPolicy: 'passthrough' as const,
    priority,
  });

  it('选 priority 最小为 selected，其余为 alternatives', () => {
    const decisions = [makeDecision('p1', 2), makeDecision('p2', 1), makeDecision('p3', 3)];
    const result = selectRoute(decisions);
    expect(result.selected.providerId).toBe('p2');
    expect(result.alternatives).toHaveLength(2);
    expect(result.alternatives.map((d) => d.providerId)).toEqual(['p1', 'p3']);
  });

  it('selected 上挂载 alternatives 字段（U6 failover 入口）', () => {
    const decisions = [makeDecision('p1', 1), makeDecision('p2', 2)];
    const result = selectRoute(decisions);
    expect(result.selected.alternatives).toHaveLength(1);
    expect(result.selected.alternatives?.[0]?.providerId).toBe('p2');
  });

  it('单候选时 alternatives 为空，selected.alternatives 为 undefined', () => {
    const decisions = [makeDecision('p1', 1)];
    const result = selectRoute(decisions);
    expect(result.selected.providerId).toBe('p1');
    expect(result.alternatives).toHaveLength(0);
    expect(result.selected.alternatives).toBeUndefined();
  });

  it('空候选列表抛 ROUTE_ALL_FAILED', () => {
    const err = catchError(() => selectRoute([])) as AdapterError;
    expect(err?.code).toBe('ROUTE_ALL_FAILED');
  });

  it('不支持的策略抛错（strategy seam 预留）', () => {
    const err = catchError(() =>
      selectRoute([makeDecision('p1', 1)], {}, 'weight' as 'priority'),
    ) as Error;
    expect(err instanceof Error).toBe(true);
    expect(err.message).toMatch(/策略/);
  });
});

// ===================== U3: resolveAdapterRoute 新形态（model-centric） =====================

describe('proxy/router（U3 resolveAdapterRoute model-centric）', () => {
  /** 共享 store：包含 gpt-5.6-1m、gpt-5.6-fast 两个 model group。 */
  function makeStore(): ConfigStore {
    return makeModelGroupStore(
      [
        {
          id: 'gpt-5.6-1m',
          contextWindow: 1_000_000,
          channels: [
            { provider: 'gpt', model: 'gpt-1m', priority: 1, contextWindow: 1_000_000 },
            { provider: 'kiro', model: 'kiro-255k', priority: 2, contextWindow: 255_000 },
          ],
        },
        {
          id: 'gpt-5.6-fast',
          channels: [
            { provider: 'kiro', model: 'kiro-255k', priority: 1 },
            { provider: 'cc', model: 'cc-255k', priority: 2 },
          ],
        },
      ],
      [
        {
          name: 'deep',
          type: 'anthropic',
          // AE4：deep 钉死到 kiro
          onFailure: 'hard_fail',
          models: [{ sourceModelId: 'deep', model: 'gpt-5.6-1m', channel: 'kiro/kiro-255k' }],
        },
        {
          name: 'opus',
          type: 'anthropic',
          // AE4：opus 自动到 gpt-5.6-1m 全渠道集
          models: [{ sourceModelId: 'opus', model: 'gpt-5.6-1m' }],
        },
      ],
    );
  }

  it('AE4 钉死：精确返回其钉死渠道（即使该渠道低于档位）', () => {
    const store = makeStore();
    const result = resolveAdapterRoute(store, 'deep', 'deep');
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.providerId).toBe('kiro');
    expect(result.routes[0]?.resolvedModel).toBe('kiro-255k');
    expect(result.isPinnedChannel).toBe(true);
    expect(result.onFailure).toBe('hard_fail');
  });

  it('AE4 自动：返回该模型组档位过滤后的全候选列表', () => {
    const store = makeStore();
    const result = resolveAdapterRoute(store, 'opus', 'opus');
    // gpt-5.6-1m 配置里有 1M + 255k，档位过滤后只保留 1M
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.providerId).toBe('gpt');
    expect(result.routes[0]?.resolvedModel).toBe('gpt-1m');
    expect(result.isPinnedChannel).toBe(false);
  });

  it('自动别名：候选多的模型组返回多个候选（priority 序）', () => {
    const store2 = makeModelGroupStore(
      [
        {
          id: 'gpt-5.6-fast',
          channels: [
            { provider: 'kiro', model: 'kiro-255k', priority: 2 },
            { provider: 'cc', model: 'cc-255k', priority: 1 },
          ],
        },
      ],
      [
        {
          name: 'opus',
          type: 'anthropic',
          models: [{ sourceModelId: 'fast', model: 'gpt-5.6-fast' }],
        },
      ],
    );
    const result = resolveAdapterRoute(store2, 'opus', 'fast');
    expect(result.routes).toHaveLength(2);
    expect(result.routes[0]?.providerId).toBe('cc');
    expect(result.routes[1]?.providerId).toBe('kiro');
    expect(result.isPinnedChannel).toBe(false);
  });

  it('model 引用指向不存在的 model_group 抛 ROUTE_GROUP_NOT_FOUND', () => {
    const config: Config = {
      providers: [{ name: 'p', type: 'openai', apiKey: 'k', models: [{ id: 'm' }] }],
      modelGroups: [],
      adapters: [
        { name: 'a', type: 'openai', models: [{ sourceModelId: 'm', model: 'no-such-group' }] },
      ],
    };
    const store = new ConfigStore('/fake', config);
    const err = catchError(() => resolveAdapterRoute(store, 'a', 'm')) as AdapterError;
    expect(err?.code).toBe('ROUTE_GROUP_NOT_FOUND');
  });

  it('model 引用下钉死的 channel 不在 model_group channels 列表中时抛 CHANNEL_NOT_FOUND', () => {
    const config: Config = {
      providers: [
        { name: 'p1', type: 'openai', apiKey: 'k', models: [{ id: 'm1' }] },
        { name: 'p2', type: 'openai', apiKey: 'k', models: [{ id: 'm2' }] },
      ],
      modelGroups: [{ id: 'g', channels: [{ provider: 'p1', model: 'm1' }] }],
      adapters: [
        {
          name: 'a',
          type: 'openai',
          models: [{ sourceModelId: 'm', model: 'g', channel: 'p2/m2' }],
        },
      ],
    };
    const store = new ConfigStore('/fake', config);
    const err = catchError(() => resolveAdapterRoute(store, 'a', 'm')) as AdapterError;
    expect(err?.code).toBe('CHANNEL_NOT_FOUND');
  });

  it('钉死别名 + onFailure=fallback 透传给 AdapterRouteResult', () => {
    const config: Config = {
      providers: [{ name: 'p', type: 'openai', apiKey: 'k', models: [{ id: 'm' }] }],
      modelGroups: [{ id: 'g', channels: [{ provider: 'p', model: 'm' }] }],
      adapters: [
        {
          name: 'a',
          type: 'openai',
          onFailure: 'fallback',
          models: [{ sourceModelId: 'm', model: 'g', channel: 'p/m' }],
        },
      ],
    };
    const store = new ConfigStore('/fake', config);
    const result = resolveAdapterRoute(store, 'a', 'm');
    expect(result.isPinnedChannel).toBe(true);
    expect(result.onFailure).toBe('fallback');
  });
});

// ===================== Batch B: 路由修复回归 =====================
// 覆盖 findings B1（钉死路径绕过 disabled provider）/ B2（钉死/fallback 漏 group 默认上限）/
// B3（全部低档 + pin 控制流矛盾）/ B4（pinned 被 priority 选择器改掉）。

describe('proxy/router（B1: 钉死路径校验 disabled provider）', () => {
  it('钉死到被禁用的 provider：抛错（CHANNEL_NOT_FOUND 类），不返回 routes', () => {
    // pin 到 enabled=false 的 provider，pinned 路径必须显式拦截，
    // 否则禁用 provider 仍被 pinned adapter 调用（C-P1-2）。
    const config: Config = {
      providers: [
        { name: 'live', type: 'openai', apiKey: 'k', models: [{ id: 'live-m' }] },
        { name: 'dead', type: 'openai', apiKey: 'k', enabled: false, models: [{ id: 'dead-m' }] },
      ],
      modelGroups: [
        {
          id: 'g',
          channels: [
            { provider: 'live', model: 'live-m', priority: 1 },
            { provider: 'dead', model: 'dead-m', priority: 2 },
          ],
        },
      ],
      adapters: [
        {
          name: 'a',
          type: 'openai',
          models: [{ sourceModelId: 'm', model: 'g', channel: 'dead/dead-m' }],
        },
      ],
    };
    const store = new ConfigStore('/fake', config);
    const err = catchError(() => resolveAdapterRoute(store, 'a', 'm')) as AdapterError;
    expect(err?.code).toBe('CHANNEL_NOT_FOUND');
  });
});

describe('proxy/router（B2: 钉死/fallback 漏 group 默认上限）', () => {
  it('钉死路径：channel 未配 maxOutputTokens 时回退到 group.maxOutputTokens', () => {
    // 验证 group 级 maxOutputTokens 默认上限能被钉死渠道继承。
    const config: Config = {
      providers: [{ name: 'p', type: 'openai', apiKey: 'k', models: [{ id: 'm' }] }],
      modelGroups: [
        {
          id: 'g',
          maxOutputTokens: 4096,
          // channel 未声明 maxOutputTokens → 应回退到 group 的 4096。
          channels: [{ provider: 'p', model: 'm', priority: 1 }],
        },
      ],
      adapters: [
        {
          name: 'a',
          type: 'openai',
          models: [{ sourceModelId: 'm', model: 'g', channel: 'p/m' }],
        },
      ],
    };
    const store = new ConfigStore('/fake', config);
    const result = resolveAdapterRoute(store, 'a', 'm');
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.maxOutputTokens).toBe(4096);
  });

  it('钉死 + fallback：fallback 渠道未配 maxOutputTokens 时回退到 group 默认', () => {
    const config: Config = {
      providers: [
        { name: 'p1', type: 'openai', apiKey: 'k', models: [{ id: 'm1' }] },
        { name: 'p2', type: 'openai', apiKey: 'k', models: [{ id: 'm2' }] },
      ],
      modelGroups: [
        {
          id: 'g',
          maxOutputTokens: 2048,
          channels: [
            { provider: 'p1', model: 'm1', priority: 1 }, // 无 maxOutputTokens
            { provider: 'p2', model: 'm2', priority: 2 },
          ],
        },
      ],
      adapters: [
        {
          name: 'a',
          type: 'openai',
          onFailure: 'fallback',
          models: [{ sourceModelId: 'm', model: 'g', channel: 'p1/m1' }],
        },
      ],
    };
    const store = new ConfigStore('/fake', config);
    const result = resolveAdapterRoute(store, 'a', 'm');
    expect(result.routes).toHaveLength(2);
    // pinned 渠道继承 group 上限
    expect(result.routes[0]?.providerId).toBe('p1');
    expect(result.routes[0]?.maxOutputTokens).toBe(2048);
    // fallback 渠道也继承 group 上限
    const fallback = result.routes.find((r) => r.providerId === 'p2');
    expect(fallback?.maxOutputTokens).toBe(2048);
  });

  it('钉死 + fallback：contextWindow 回退到 group 默认', () => {
    const config: Config = {
      providers: [{ name: 'p', type: 'openai', apiKey: 'k', models: [{ id: 'm' }] }],
      modelGroups: [
        {
          id: 'g',
          contextWindow: 128_000,
          channels: [{ provider: 'p', model: 'm', priority: 1 }],
        },
      ],
      adapters: [
        {
          name: 'a',
          type: 'openai',
          models: [{ sourceModelId: 'm', model: 'g', channel: 'p/m' }],
        },
      ],
    };
    const store = new ConfigStore('/fake', config);
    const result = resolveAdapterRoute(store, 'a', 'm');
    expect(result.routes[0]?.contextWindow).toBe(128_000);
  });
});

describe('proxy/router（B3: 全渠道低档 + 显式 pin 控制流矛盾）', () => {
  it('组内所有渠道被档位过滤 + 显式 pin：仍按 pin 解析钉死渠道（不抛 ROUTE_NO_ELIGIBLE_CHANNEL）', () => {
    // pin 是操作员显式意图：应绕过 routeLogicalModel 的 tier filter，
    // 否则 routeLogicalModel 提前抛 ROUTE_NO_ELIGIBLE_CHANNEL，pin 分支永不执行（C-P1-4）。
    const config: Config = {
      providers: [
        { name: 'gpt', type: 'openai', apiKey: 'k', models: [{ id: 'gpt-1m' }] },
        { name: 'kiro', type: 'openai', apiKey: 'k', models: [{ id: 'kiro-255k' }] },
      ],
      modelGroups: [
        {
          id: 'gpt-5.6-1m',
          contextWindow: 1_000_000, // 极高门槛
          channels: [
            // 所有渠道 effective contextWindow 都低于组档位。
            { provider: 'kiro', model: 'kiro-255k', priority: 1, contextWindow: 255_000 },
          ],
        },
      ],
      adapters: [
        {
          name: 'a',
          type: 'openai',
          // 显式 pin 到低档渠道（操作员覆盖档位语义）
          models: [{ sourceModelId: 'm', model: 'gpt-5.6-1m', channel: 'kiro/kiro-255k' }],
        },
      ],
    };
    const store = new ConfigStore('/fake', config);
    // 不应抛 ROUTE_NO_ELIGIBLE_CHANNEL；应成功解析出钉死渠道
    const result = resolveAdapterRoute(store, 'a', 'm');
    expect(result.isPinnedChannel).toBe(true);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.providerId).toBe('kiro');
    expect(result.routes[0]?.resolvedModel).toBe('kiro-255k');
  });
});

describe('proxy/router（B4: pinned 不被 selectRoute 改掉）', () => {
  // R-P1-3：appendFallbackAlternatives 把 pinnedRoute 放首位，
  // 但 adapterHandler 随后 selectRoute 按 priority 重排 → pinned priority 高时 selected 变成 fallback。
  // 修复后：adapterHandler 对 pinned 直接用 routes[0] 作 selected，跳过 selectRoute 重排。
  // 单元层验证 resolveAdapterRoute 返回 routes[0] 是 pinned。
  it('pinned + fallback：routes[0] 始终是 pinned 渠道（不依赖 priority）', () => {
    const config: Config = {
      providers: [
        { name: 'p1', type: 'openai', apiKey: 'k', models: [{ id: 'm1' }] },
        { name: 'p2', type: 'openai', apiKey: 'k', models: [{ id: 'm2' }] },
      ],
      modelGroups: [
        {
          id: 'g',
          channels: [
            { provider: 'p1', model: 'm1', priority: 10 }, // fallback priority 更高（数值小）
            { provider: 'p2', model: 'm2', priority: 1 }, // pinned priority 较低（数值大）
          ],
        },
      ],
      adapters: [
        {
          name: 'a',
          type: 'openai',
          onFailure: 'fallback',
          models: [{ sourceModelId: 'm', model: 'g', channel: 'p2/m2' }],
        },
      ],
    };
    const store = new ConfigStore('/fake', config);
    const result = resolveAdapterRoute(store, 'a', 'm');
    expect(result.isPinnedChannel).toBe(true);
    // pinned 必须在 routes[0]，不被 selectRoute 的 priority 重排改掉
    expect(result.routes[0]?.providerId).toBe('p2');
    expect(result.routes[0]?.resolvedModel).toBe('m2');
  });
});
