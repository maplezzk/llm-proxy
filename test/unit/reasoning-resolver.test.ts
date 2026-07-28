import { describe, expect, it } from 'vitest';
import type { ReasoningSpec } from '../../src/proxy/ir/types.ts';
import { resolveReasoning } from '../../src/proxy/reasoning-resolver.ts';

const spec = (source: ReasoningSpec['source'], values: Omit<ReasoningSpec, 'source'>): ReasoningSpec => ({
  source,
  ...values,
});

describe('unit/reasoning-resolver', () => {
  it('route effort 胜过 client effort，并通过共享表映射 budget', () => {
    const result = resolveReasoning(
      spec('client', { enabled: true, effort: 'low', clientEffort: 'low' }),
      spec('route', { effort: 'high' }),
    );

    expect(result).toMatchObject({
      enabled: true,
      effort: 'high',
      budgetTokens: 16384,
      source: 'route',
      clientEffort: 'low',
    });
  });

  it('client explicit-off 不被 route 重新启用', () => {
    expect(
      resolveReasoning(
        spec('client', { enabled: false, type: 'disabled', budgetTokens: 4096 }),
        spec('route', { effort: 'high', type: 'enabled' }),
      ),
    ).toEqual({ enabled: false, type: 'disabled', source: 'client' });
  });

  it('budget 小于 maxTokens，不反向放大 maxTokens', () => {
    expect(
      resolveReasoning(undefined, spec('route', { budgetTokens: 8192 }), undefined, 100),
    ).toMatchObject({ budgetTokens: 99 });
  });

  it('保留 clientEffort', () => {
    expect(
      resolveReasoning(
        spec('client', { effort: 'xhigh', clientEffort: 'xhigh' }),
        spec('route', {}),
      ).clientEffort,
    ).toBe('xhigh');
  });

  it('override reasoning 标注 source=override', () => {
    expect(
      resolveReasoning(
        spec('client', { effort: 'low' }),
        spec('route', { effort: 'medium' }),
        spec('override', { effort: 'max', summary: 'detailed' }),
      ),
    ).toMatchObject({ source: 'override', effort: 'max', summary: 'detailed' });
  });
});
