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
import { type ConfigRowBundle, configToRows, rowsToConfig } from '../config/pg-mapper.ts';
import type { AdapterOnFailure, Config, OverrideRule, ThinkingConfig } from '../config/types.ts';
import type { Db } from './client.ts';
import {
  type ReasoningEffort,
  type ThinkingType,
  adapterModelMappings,
  adapters,
  modelGroupChannels,
  modelGroups,
  providerModels,
  providers,
  proxySettings,
  visionSettings,
} from './schema/index.ts';

const readContextWindow = (metadata: unknown): number | null => {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).contextWindow;
  return typeof value === 'number' ? value : null;
};

const readOnFailure = (metadata: unknown): AdapterOnFailure | null => {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).onFailure;
  return value === 'hard_fail' || value === 'fallback' ? value : null;
};

/**
 * 幂等导入配置到 PG（事务内清旧插新）。
 *
 * 删除顺序遵守外键约束：vision_settings / adapter_model_mappings（引用 provider_models，
 * 无级联）先删，adapters 与 model_groups 次之，providers 最后（级联删除 provider_models）。
 * 插入顺序相反：providers → provider_models → model_groups/channels → adapters → mappings → vision → proxy。
 */
export const importConfigToPg = async (db: Db, config: Config): Promise<void> => {
  const bundle = configToRows(config);

  await db.transaction(async (tx) => {
    // --- 清旧（FK 安全顺序）---
    await tx.delete(visionSettings);
    await tx.delete(adapterModelMappings);
    await tx.delete(adapters);
    await tx.delete(modelGroups); // 级联删除 model_group_channels
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
          priority: p.priority,
          enabled: p.enabled,
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
          metadata: m.contextWindow === null ? {} : { contextWindow: m.contextWindow },
        })
        .returning({ id: providerModels.id });
      if (!inserted) throw new Error(`importConfigToPg: 插入 model "${m.modelId}" 未返回 id`);
      realModelId.set(m.id, inserted.id);
    }

    const realModelGroupId = new Map<number, number>();
    for (const group of bundle.modelGroups) {
      const [inserted] = await tx
        .insert(modelGroups)
        .values({
          name: group.name,
          contextWindow: group.contextWindow,
          maxOutputTokens: group.maxOutputTokens,
          enabled: group.enabled,
          metadata: group.metadata,
        })
        .returning({ id: modelGroups.id });
      if (!inserted) {
        throw new Error(`importConfigToPg: 插入 model_group "${group.name}" 未返回 id`);
      }
      realModelGroupId.set(group.id, inserted.id);
    }

    for (const channel of bundle.modelGroupChannels) {
      const modelGroupId = realModelGroupId.get(channel.modelGroupId);
      const providerModelId = realModelId.get(channel.providerModelId);
      if (modelGroupId === undefined || providerModelId === undefined) {
        throw new Error(
          `importConfigToPg: model_group channel 外键解析失败 (modelGroupId=${channel.modelGroupId}, providerModelId=${channel.providerModelId})`,
        );
      }
      await tx.insert(modelGroupChannels).values({
        modelGroupId,
        providerModelId,
        priority: channel.priority,
        contextWindow: channel.contextWindow,
        maxOutputTokens: channel.maxOutputTokens,
        enabled: channel.enabled,
      });
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
          metadata: a.onFailure === null ? {} : { onFailure: a.onFailure },
        })
        .returning({ id: adapters.id });
      if (!inserted) throw new Error(`importConfigToPg: 插入 adapter "${a.name}" 未返回 id`);
      realAdapterId.set(a.id, inserted.id);
    }

    for (const mm of bundle.adapterModelMappings) {
      const adapterId = realAdapterId.get(mm.adapterId);
      const providerModelId =
        mm.providerModelId === null ? null : realModelId.get(mm.providerModelId);
      const modelGroupId = mm.modelGroupId === null ? null : realModelGroupId.get(mm.modelGroupId);
      if (
        adapterId === undefined ||
        (mm.providerModelId !== null && providerModelId === undefined) ||
        (mm.modelGroupId !== null && modelGroupId === undefined)
      ) {
        throw new Error(
          `importConfigToPg: 映射 "${mm.sourceModelId}" 外键解析失败 (adapterId=${mm.adapterId}, providerModelId=${mm.providerModelId}, modelGroupId=${mm.modelGroupId})`,
        );
      }
      await tx.insert(adapterModelMappings).values({
        adapterId,
        sourceModelId: mm.sourceModelId,
        providerModelId,
        modelGroupId,
        thinkingOverride: mm.thinkingOverride,
        generationOverrides: mm.generationOverrides,
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
  const modelGroupRows = await db.select().from(modelGroups).orderBy(asc(modelGroups.id));
  const channelRows = await db
    .select()
    .from(modelGroupChannels)
    .orderBy(asc(modelGroupChannels.id));
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
      priority: p.priority,
      enabled: p.enabled,
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
      contextWindow: readContextWindow(m.metadata),
    })),
    modelGroups: modelGroupRows.map((group) => ({
      id: group.id,
      name: group.name,
      contextWindow: group.contextWindow,
      maxOutputTokens: group.maxOutputTokens,
      enabled: group.enabled,
      metadata:
        group.metadata !== null &&
        typeof group.metadata === 'object' &&
        !Array.isArray(group.metadata)
          ? (group.metadata as Record<string, unknown>)
          : {},
    })),
    modelGroupChannels: channelRows.map((channel) => ({
      id: channel.id,
      modelGroupId: channel.modelGroupId,
      providerModelId: channel.providerModelId,
      priority: channel.priority,
      contextWindow: channel.contextWindow,
      maxOutputTokens: channel.maxOutputTokens,
      enabled: channel.enabled,
    })),
    adapters: adapterRows.map((a) => ({
      id: a.id,
      name: a.name,
      inboundType: a.inboundType,
      maxTokensOverride: a.maxTokensOverride,
      streamPolicy: a.streamPolicy,
      onFailure: readOnFailure(a.metadata),
    })),
    adapterModelMappings: mappingRows.map((mm) => ({
      adapterId: mm.adapterId,
      sourceModelId: mm.sourceModelId,
      providerModelId: mm.providerModelId,
      modelGroupId: mm.modelGroupId,
      // JSONB 读回为 unknown；mapper 接收已由配置 validator 校验的结构。
      thinkingOverride: (mm.thinkingOverride as ThinkingConfig | null) ?? null,
      generationOverrides: (mm.generationOverrides as OverrideRule[] | null) ?? null,
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
