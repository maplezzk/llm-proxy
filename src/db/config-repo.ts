/**
 * 配置仓库：Config 行束 ↔ PG 持久化（P1.16 增量2）。
 *
 * - `importConfigToPg(db, config)`：幂等导入——事务内按 FK 安全顺序「清旧插新」，
 *   并把行束内的合成 id 重映射为真实自增 id。整个配置作为单一可信快照整体替换。
 * - `loadConfigFromPg(db)`：读回各表（按 id 排序保证顺序确定），组装行束后交给
 *   `rowsToConfig` 还原 Config。
 *
 * 过渡期定位：YAML 仍为读源，本模块服务于「启动导入 + 双写」，为后续切流准备。
 *
 * 已知限制：清旧会删除 providers→provider_models；若 usage_records/requests 已引用旧
 * provider_model（无级联 FK），清旧将因外键约束失败。过渡期导入应在用量数据落库前完成，
 * 后续可改为按 name upsert。
 */
import { asc } from 'drizzle-orm';
import type { Db } from './client.ts';
import {
  adapterModelMappings,
  adapters,
  providerModels,
  providers,
  proxySettings,
  visionSettings,
  type ReasoningEffort,
  type ThinkingType,
} from './schema/index.ts';
import { configToRows, rowsToConfig, type ConfigRowBundle } from '../config/pg-mapper.ts';
import type { Config, ThinkingConfig } from '../config/types.ts';

/**
 * 幂等导入配置到 PG（事务内清旧插新）。
 *
 * 删除顺序遵守外键约束：vision_settings / adapter_model_mappings（引用 provider_models，
 * 无级联）先删，adapters 次之，providers 最后（级联删除 provider_models）。
 * 插入顺序相反：providers → provider_models → adapters → mappings → vision → proxy。
 */
export const importConfigToPg = async (db: Db, config: Config): Promise<void> => {
  const bundle = configToRows(config);

  await db.transaction(async (tx) => {
    // --- 清旧（FK 安全顺序）---
    await tx.delete(visionSettings);
    await tx.delete(adapterModelMappings);
    await tx.delete(adapters);
    await tx.delete(providers); // 级联删除 provider_models
    await tx.delete(proxySettings);

    // --- 插新 + 合成 id → 真实 id 重映射 ---
    const realProviderId = new Map<number, number>();
    for (const p of bundle.providers) {
      const [inserted] = await tx
        .insert(providers)
        .values({
          name: p.name,
          type: p.type,
          apiBase: p.apiBase,
          credentialRef: p.credentialRef,
        })
        .returning({ id: providers.id });
      if (!inserted) throw new Error(`importConfigToPg: 插入 provider "${p.name}" 未返回 id`);
      realProviderId.set(p.id, inserted.id);
    }

    const realModelId = new Map<number, number>();
    for (const m of bundle.providerModels) {
      const providerId = realProviderId.get(m.providerId);
      if (providerId === undefined) {
        throw new Error(
          `importConfigToPg: provider_model "${m.modelId}" 的合成 providerId=${m.providerId} 无法解析`,
        );
      }
      const [inserted] = await tx
        .insert(providerModels)
        .values({
          providerId,
          modelId: m.modelId,
          inputModalities: m.inputModalities,
          thinkingEnabled: m.thinkingEnabled,
          thinkingBudgetTokens: m.thinkingBudgetTokens,
          // Lite 行以 string 承载枚举值（来自已校验 Config），此处收窄为 PG 枚举类型
          thinkingReasoningEffort: m.thinkingReasoningEffort as ReasoningEffort | null,
          thinkingType: m.thinkingType as ThinkingType | null,
        })
        .returning({ id: providerModels.id });
      if (!inserted) throw new Error(`importConfigToPg: 插入 model "${m.modelId}" 未返回 id`);
      realModelId.set(m.id, inserted.id);
    }

    const realAdapterId = new Map<number, number>();
    for (const a of bundle.adapters) {
      const [inserted] = await tx
        .insert(adapters)
        .values({
          name: a.name,
          inboundType: a.inboundType,
          maxTokensOverride: a.maxTokensOverride,
          streamPolicy: a.streamPolicy,
        })
        .returning({ id: adapters.id });
      if (!inserted) throw new Error(`importConfigToPg: 插入 adapter "${a.name}" 未返回 id`);
      realAdapterId.set(a.id, inserted.id);
    }

    for (const mm of bundle.adapterModelMappings) {
      const adapterId = realAdapterId.get(mm.adapterId);
      const providerModelId = realModelId.get(mm.providerModelId);
      if (adapterId === undefined || providerModelId === undefined) {
        throw new Error(
          `importConfigToPg: 映射 "${mm.sourceModelId}" 外键解析失败 (adapterId=${mm.adapterId}, providerModelId=${mm.providerModelId})`,
        );
      }
      await tx.insert(adapterModelMappings).values({
        adapterId,
        sourceModelId: mm.sourceModelId,
        providerModelId,
        thinkingOverride: mm.thinkingOverride,
      });
    }

    if (bundle.visionSettings) {
      const providerModelId = realModelId.get(bundle.visionSettings.providerModelId);
      if (providerModelId === undefined) {
        throw new Error(
          `importConfigToPg: vision 外键解析失败 (providerModelId=${bundle.visionSettings.providerModelId})`,
        );
      }
      await tx.insert(visionSettings).values({
        providerModelId,
        prompt: bundle.visionSettings.prompt,
      });
    }

    await tx.insert(proxySettings).values({
      proxyKeyHash: bundle.proxySettings.proxyKeyHash,
      logLevel: bundle.proxySettings.logLevel,
      locale: bundle.proxySettings.locale,
      port: bundle.proxySettings.port,
      captureMaxSize: bundle.proxySettings.captureMaxSize,
    });
  });
};

/**
 * 从 PG 读回配置。各表按 id 升序读取，保证 providers/models/mappings 顺序与导入时一致
 * （直连路由依赖 provider 声明顺序）。
 */
export const loadConfigFromPg = async (db: Db): Promise<Config> => {
  const providerRows = await db.select().from(providers).orderBy(asc(providers.id));
  const modelRows = await db.select().from(providerModels).orderBy(asc(providerModels.id));
  const adapterRows = await db.select().from(adapters).orderBy(asc(adapters.id));
  const mappingRows = await db
    .select()
    .from(adapterModelMappings)
    .orderBy(asc(adapterModelMappings.id));
  const [visionRow] = await db.select().from(visionSettings);
  const [proxyRow] = await db.select().from(proxySettings);

  if (!proxyRow) {
    throw new Error('loadConfigFromPg: proxy_settings 为空，无法还原配置');
  }

  const bundle: ConfigRowBundle = {
    providers: providerRows.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      apiBase: p.apiBase,
      credentialRef: p.credentialRef,
    })),
    providerModels: modelRows.map((m) => ({
      id: m.id,
      providerId: m.providerId,
      modelId: m.modelId,
      inputModalities: m.inputModalities,
      thinkingEnabled: m.thinkingEnabled,
      thinkingBudgetTokens: m.thinkingBudgetTokens,
      thinkingReasoningEffort: m.thinkingReasoningEffort,
      thinkingType: m.thinkingType,
    })),
    adapters: adapterRows.map((a) => ({
      id: a.id,
      name: a.name,
      inboundType: a.inboundType,
      maxTokensOverride: a.maxTokensOverride,
      streamPolicy: a.streamPolicy,
    })),
    adapterModelMappings: mappingRows.map((mm) => ({
      adapterId: mm.adapterId,
      sourceModelId: mm.sourceModelId,
      providerModelId: mm.providerModelId,
      // jsonb 读回为 unknown，此处还原为 ThinkingConfig（null = 继承 provider_model）
      thinkingOverride: (mm.thinkingOverride as ThinkingConfig | null) ?? null,
    })),
    visionSettings: visionRow
      ? { providerModelId: visionRow.providerModelId, prompt: visionRow.prompt }
      : null,
    proxySettings: {
      proxyKeyHash: proxyRow.proxyKeyHash,
      logLevel: proxyRow.logLevel,
      locale: proxyRow.locale,
      port: proxyRow.port,
      captureMaxSize: proxyRow.captureMaxSize,
    },
  };

  return rowsToConfig(bundle);
};
