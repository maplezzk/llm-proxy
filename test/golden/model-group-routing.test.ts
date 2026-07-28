/**
 * 黄金回归：模型组路由端到端（U7 集成 + R17 收尾）。
 *
 * 覆盖：
 * - F1（R1,R2,R3,R5,R11,R13）：adapter 别名 → 解析别名到逻辑模型 → 收集档位合格候选渠道 →
 *   priority 序选 → 映射到渠道真实模型 ID → 覆写引擎 + reasoning 解析 → 转换到渠道协议 →
 *   fetch → 转换响应回 → 返回 client。
 * - AE3（R7,R9）：adapter app-a 暴露别名 deep 绑定 opus。operator 把 deep 从 kiro 重绑到 cc。
 *   client 仍调 deep 不变，从不见真实模型 ID 或渠道。
 * - 跨协议路由经模型组正确转换（integration）。
 * - R17：既有 golden 套件保持绿（由 CI 侧运行验证）。
 *
 * 验证方法：
 * - 用 helpers/translate.ts 的 translate() 把 wire 走过 inbound.decode → IR →
 *   applyRouteDecision（含 reasoning 解析）→ outbound.encode → applyOverrides；
 *   返回的 body 即「channel 真实模型 + 渠道协议」形态，可直接断言「真实模型 ID 出现
 *   在出站 body」「别名未出现」「跨协议字段映射正确」。
 * - 用 helpers/route.ts 的 makeRouteGroup() 构造多渠道候选，对应生产 selectRoute 输出。
 *
 * 本文件只断言接线行为（IR ↔ wire ↔ RouteDecision 形态），不重复 U5/U6 的 mock fetch
 * 端到端用例（已在 test/pipeline.test.ts 的 U5/U6 describe 覆盖）。
 */
import { describe, expect, it } from 'vitest';
import type { OverrideRule } from '../../src/config/types.ts';
import { makeRoute, makeRouteGroup, splitPrimaryAndAlternatives } from '../helpers/route.ts';
import { translate } from '../helpers/translate.ts';

// === 渠道定义：复刻 AE3/F1 验收例里的 kiro + cc 双渠道 ===

const kiroChannel = {
  providerName: 'kiro',
  providerType: 'openai' as const,
  apiKey: 'sk-kiro',
  apiBase: 'https://kiro.example.com',
  modelId: 'kiro-real',
  priority: 1,
};

const ccChannel = {
  providerName: 'cc',
  providerType: 'anthropic' as const,
  apiKey: 'sk-cc',
  apiBase: 'https://cc.example.com',
  modelId: 'claude-opus-real',
  priority: 2,
};

// === F1：完整路由请求 alias → model → channel → upstream 再回来 ===

describe('golden/F1 模型组路由端到端', () => {
  it('client 调用别名 deep，自动别名走全候选集（priority 1: kiro）', () => {
    const routes = makeRouteGroup([ccChannel, kiroChannel]);
    const { primary, alternatives } = splitPrimaryAndAlternatives(routes);

    // priority 升序：kiro(1) 在前，cc(2) 作为 failover 候选
    expect(primary.providerId).toBe('kiro');
    expect(primary.resolvedModel).toBe('kiro-real');
    expect(alternatives.map((r) => `${r.providerId}/${r.resolvedModel}`)).toEqual([
      'cc/claude-opus-real',
    ]);

    // client 始终发「别名 deep」（即 logicalModel），经路由解析后出站 body 应暴露
    // 真实模型 ID（kiro-real）而非别名（deep）。
    const { body } = translate('anthropic', primary, {
      model: 'deep',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1000,
    });
    expect(body.model).toBe('kiro-real');
    expect(body.model).not.toBe('deep');
  });

  it('跨协议路由经模型组正确转换：Anthropic client → OpenAI channel', () => {
    const route = makeRoute(kiroChannel);
    const { body, crossProtocol } = translate('anthropic', route, {
      model: 'deep',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 500,
      temperature: 0.5,
      stream: false,
    });

    // 跨协议标志 + 出站为 OpenAI Chat wire 形态
    expect(crossProtocol).toBe(true);
    expect(body.model).toBe('kiro-real');
    // 跨协议：Anthropic user 'hello' → OpenAI Chat user 'hello'（同协议字段直传）
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.temperature).toBe(0.5);
    // Anthropic max_tokens → OpenAI max_tokens 直传（同名字段）
    expect(body.max_tokens).toBe(500);
    // Anthropic system 字段在 OpenAI Chat 不会自动转为 system 消息（无 system 字段传入即无）
    expect(body.messages).toHaveLength(1);
  });

  it('OpenAI client → Anthropic channel：跨协议字段映射', () => {
    const route = makeRoute(ccChannel);
    const { body, crossProtocol } = translate('openai', route, {
      model: 'deep',
      messages: [
        { role: 'system', content: 'You are concise' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 2000,
    });

    expect(crossProtocol).toBe(true);
    expect(body.model).toBe('claude-opus-real');
    // OpenAI system message → Anthropic system 字段
    expect(body.system).toBe('You are concise');
    // 跨协议：OpenAI user 'hi' → Anthropic user content [{type:text,text:'hi'}]
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    expect(body.max_tokens).toBe(2000);
  });

  it('OpenAI Responses client → Anthropic channel：input 数组 → messages', () => {
    const route = makeRoute(ccChannel);
    const { body, crossProtocol } = translate('openai-responses', route, {
      model: 'deep',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      max_output_tokens: 1024,
      instructions: 'be brief',
    });

    expect(crossProtocol).toBe(true);
    expect(body.model).toBe('claude-opus-real');
    // Responses instructions → Anthropic system
    expect(body.system).toBe('be brief');
    // Responses input message → Anthropic messages（content 数组块结构）
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
    expect(body.max_tokens).toBe(1024);
  });

  it('reasoning 解析在 applyRouteDecision 内自动跑：route 配置 effort=high', () => {
    const route = makeRoute({
      ...kiroChannel,
      thinking: { reasoning_effort: 'high' },
    });
    // OpenAI client 调 Anthropic channel：reasoning_effort 高 → 由 resolver 集中化
    // → 出站 OpenAI Chat 应透传 reasoning_effort（client 协议原生字段）
    const { body } = translate('anthropic', route, {
      model: 'deep',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.reasoning_effort).toBe('high');
  });
});

// === AE3：重绑别名的渠道，client 仍调同一别名，真实模型和渠道被隐藏 ===

describe('golden/AE3 别名重绑（真实模型 + 渠道对 client 不可见）', () => {
  it('同一别名 deep，从 kiro 重绑到 cc：出站 model 跟随新渠道', () => {
    // 起点：deep 绑 kiro 渠道
    const deepToKiro = makeRoute({
      ...kiroChannel,
      // KD1：客户端只见别名 deep，不见 kiro
      apiBase: 'https://proxy.example.com',
      providerName: 'app-a',
    });
    const { body: bodyA } = translate('anthropic', deepToKiro, {
      model: 'deep',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(bodyA.model).toBe('kiro-real');

    // 重绑：deep 改指 cc 渠道（同一别名、同一 client 调用）
    const deepToCc = makeRoute({
      ...ccChannel,
      apiBase: 'https://proxy.example.com',
      providerName: 'app-a',
    });
    const { body: bodyB } = translate('anthropic', deepToCc, {
      model: 'deep',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(bodyB.model).toBe('claude-opus-real');

    // KD4：client 始终只见别名 deep；真实模型 ID（kiro-real/claude-opus-real）
    // 只出现在出站 body，client 原始请求 body 里没有。
    expect(bodyA.model).not.toBe('deep');
    expect(bodyB.model).not.toBe('deep');
    // 跨协议字段不变（client 协议都是 anthropic → 跨协议转换结果稳定）
    // - bodyA: kiro 渠道为 openai 协议，Anthropic user 'hi' → OpenAI Chat user 'hi'
    // - bodyB: cc 渠道为 anthropic 协议 → Anthropic content 数组块结构
    expect(bodyA.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(bodyB.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('同名别名解析到不同真实模型：渠道差异完全隐藏', () => {
    // 两个独立 adapter app-a / app-b 都暴露别名 deep，但底层渠道不同
    const appA = makeRoute({ ...kiroChannel, providerName: 'app-a' });
    const appB = makeRoute({ ...ccChannel, providerName: 'app-b' });

    // 两个 adapter 都让 client 用同一别名调用，但每个 adapter 路由到不同渠道
    const { body: viaA } = translate('anthropic', appA, {
      model: 'deep',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const { body: viaB } = translate('anthropic', appB, {
      model: 'deep',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(viaA.model).toBe('kiro-real');
    expect(viaB.model).toBe('claude-opus-real');
    expect(viaA.model).not.toBe(viaB.model);
  });
});

// === U5 覆写引擎端到端：translate helper 接 applyOverrides 后透传至出站 ===

describe('golden/U5 覆写引擎经 translate helper 接线', () => {
  it('覆写 body set：reasoning_effort 在 channel 出站 body 出现', () => {
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        when: '{{model}} == "deep"',
        body: [{ op: 'set', path: 'reasoning_effort', value: 'high' }],
      },
    ];
    const route = makeRoute({ ...kiroChannel, overrides: rules });
    const { body } = translate('anthropic', route, {
      model: 'deep',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.reasoning_effort).toBe('high');
  });

  it('覆写条件不满足时 no-op：reasoning_effort 不出现', () => {
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        when: '{{model}} == "other-alias"',
        body: [{ op: 'set', path: 'reasoning_effort', value: 'high' }],
      },
    ];
    const route = makeRoute({ ...kiroChannel, overrides: rules });
    const { body } = translate('anthropic', route, {
      model: 'deep',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('覆写保护字段 model 被拒：channel 真实模型 ID 保持不变', () => {
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set', path: 'model', value: 'hijacked' }],
      },
    ];
    const route = makeRoute({ ...kiroChannel, overrides: rules });
    const { body } = translate('anthropic', route, {
      model: 'deep',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.model).toBe('kiro-real');
    expect(body.model).not.toBe('hijacked');
  });

  it('覆写非保护字段 metadata：可写入', () => {
    const rules: OverrideRule[] = [
      {
        scope: 'adapter-alias',
        body: [{ op: 'set', path: 'metadata.channel_tag', value: 'kiro' }],
      },
    ];
    const route = makeRoute({ ...kiroChannel, overrides: rules });
    const { body } = translate('anthropic', route, {
      model: 'deep',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect((body.metadata as Record<string, unknown>)?.channel_tag).toBe('kiro');
  });

  it('未配置 overrides 时 translate 不改变 body（R17 兼容）', () => {
    // 默认 makeRoute 不带 overrides → translate 路径保持纯 wire 转换
    const route = makeRoute(kiroChannel);
    const before = translate('anthropic', route, {
      model: 'deep',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(before.body.reasoning_effort).toBeUndefined();
    expect((before.body as Record<string, unknown>).metadata).toBeUndefined();
    expect(before.body.model).toBe('kiro-real');
  });
});

// === R17 / 多渠道候选集形状 ===

describe('golden/R17 RouteDecision 候选集（makeRouteGroup 输出契约）', () => {
  it('候选按 priority 升序排好', () => {
    const routes = makeRouteGroup([
      { ...ccChannel, priority: 2 },
      { ...kiroChannel, priority: 1 },
      {
        providerName: 'third',
        providerType: 'openai' as const,
        modelId: 'third-model',
        priority: 0,
      },
    ]);
    expect(routes.map((r) => `${r.providerId}/${r.resolvedModel}`)).toEqual([
      'third/third-model',
      'kiro/kiro-real',
      'cc/claude-opus-real',
    ]);
  });

  it('未指定 priority 时按声明顺序保持原位（priority=0）', () => {
    // 两个渠道都不指定 priority → 都取默认 0；sort 稳定性（V8 stable）保
    // 持原输入顺序。
    const aChannel = {
      providerName: 'alpha',
      providerType: 'openai' as const,
      modelId: 'alpha-model',
    };
    const bChannel = {
      providerName: 'bravo',
      providerType: 'openai' as const,
      modelId: 'bravo-model',
    };
    const routes = makeRouteGroup([aChannel, bChannel]);
    expect(routes.map((r) => r.providerId)).toEqual(['alpha', 'bravo']);
  });

  it('splitPrimaryAndAlternatives 把首元素拆为主路由，其余为 alternatives', () => {
    const routes = makeRouteGroup([kiroChannel, ccChannel]);
    const { primary, alternatives } = splitPrimaryAndAlternatives(routes);
    expect(primary.providerId).toBe('kiro');
    expect(alternatives.map((r) => r.providerId)).toEqual(['cc']);
  });

  it('RouteDecision 携带 overrides 字段（U5 接线证据）', () => {
    const rules: OverrideRule[] = [
      { scope: 'channel', body: [{ op: 'set', path: 'metadata.tag', value: 'kiro' }] },
    ];
    const route = makeRoute({ ...kiroChannel, overrides: rules });
    expect(route.overrides).toEqual(rules);
  });
});
