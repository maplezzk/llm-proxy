/**
 * 黄金回归：thinking 配置注入行为等价。
 * 用例移植自 legacy-test/proxy/translation.test.ts「thinking 配置注入」describe，
 * 改写为新架构接口（test/helpers/translate.ts），断言保持 legacy 行为规格。
 *
 * 验收 gap5（reasoning 字段级合并）：route.budget > route.effort 查表 > client.effort 查表。
 */
import { describe, expect, it } from 'vitest';
import { makeRoute, type LegacyRouteLike } from '../helpers/route.ts';
import { translate } from '../helpers/translate.ts';

const anthropicRoute: LegacyRouteLike = {
  providerName: 'anthropic-main',
  providerType: 'anthropic',
  apiKey: 'sk-ant-1',
  apiBase: 'https://api.anthropic.com',
  modelId: 'claude-sonnet-4',
};
const openaiRoute: LegacyRouteLike = {
  providerName: 'openai-main',
  providerType: 'openai',
  apiKey: 'sk-openai-1',
  apiBase: 'https://api.openai.com',
  modelId: 'gpt-4o',
};

describe('golden/thinking 配置注入（行为等价）', () => {
  it('同协议 Anthropic 注入 thinking.budget_tokens', () => {
    const route = makeRoute({ ...anthropicRoute, thinking: { budget_tokens: 8192 } });
    const { body } = translate('anthropic', route, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10000,
    });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(body.max_tokens).toBe(10000);
  });

  it('同协议 Anthropic 客户端 max_tokens < budget 被覆盖', () => {
    const route = makeRoute({ ...anthropicRoute, thinking: { budget_tokens: 8192 } });
    const { body } = translate('anthropic', route, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    });
    expect(body.max_tokens).toBe(8192);
  });

  it('同协议 OpenAI 注入 reasoning_effort', () => {
    const route = makeRoute({ ...openaiRoute, thinking: { reasoning_effort: 'medium' } });
    const { body } = translate('openai', route, {
      model: 'o3-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.reasoning_effort).toBe('medium');
  });

  it('跨协议 OpenAI→Anthropic 注入 thinking（客户端未传 max_tokens，兜底 16384）', () => {
    const route = makeRoute({ ...anthropicRoute, thinking: { budget_tokens: 8192 } });
    const { body } = translate('openai', route, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(body.max_tokens).toBe(16384);
  });

  it('跨协议 OpenAI→Anthropic 客户端 max_tokens < budget 被覆盖', () => {
    const route = makeRoute({ ...anthropicRoute, thinking: { budget_tokens: 8192 } });
    const { body } = translate('openai', route, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(body.max_tokens).toBe(8192);
  });

  it('跨协议 route reasoning_effort 查表转 budget（high→16384）', () => {
    const route = makeRoute({ ...anthropicRoute, thinking: { reasoning_effort: 'high' } });
    const { body } = translate('openai', route, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
    expect(body.max_tokens).toBe(16384);
  });

  it('跨协议 客户端 reasoning_effort 查表（xhigh→32768，gap5 字段级 client 回退）', () => {
    // route 不配 thinking，客户端传 reasoning_effort=xhigh → 应查表得 budget 32768
    const route = makeRoute({ ...anthropicRoute });
    const { body } = translate('openai', route, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'xhigh',
    });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 32768 });
    expect(body.max_tokens).toBe(32768);
  });

  it('同协议 Anthropic reasoning_effort 查表（max→65536）', () => {
    const route = makeRoute({ ...anthropicRoute, thinking: { reasoning_effort: 'max' } });
    const { body } = translate('anthropic', route, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 65536 });
    expect(body.max_tokens).toBe(65536);
  });

  it('跨协议 Anthropic→OpenAI 注入 reasoning_effort', () => {
    const route = makeRoute({ ...openaiRoute, thinking: { reasoning_effort: 'high' } });
    const { body } = translate('anthropic', route, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1000,
    });
    expect(body.reasoning_effort).toBe('high');
  });

  it('无 thinking 配置时不注入任何参数', () => {
    const route = makeRoute({ ...anthropicRoute });
    const { body } = translate('anthropic', route, {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.thinking).toBeUndefined();
  });
});
