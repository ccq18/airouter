/** Fixed public pool model and explicit credential references; no auto-route special case. */
const POOL_PRESETS = new Set(['opencode-free', 'openrouter-free']);
const FREE_MODEL = { id: 'free', protocols: ['chat_completions'] };
const DEFAULT_POOL = { sync_interval_seconds: 900, max_stale_seconds: 3600, max_attempts: 8, strategy: 'quality_first', tiers: {} };
const isFreePool = config => Boolean(config && POOL_PRESETS.has(config.preset));

function normalizePoolOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('pool 必须是对象');
  if (Object.keys(value).some(key => !Object.hasOwn(DEFAULT_POOL, key))) throw new Error('pool 包含未知设置');
  const result = { ...DEFAULT_POOL, ...value };
  for (const [key, min, max] of [['sync_interval_seconds', 60, 86400], ['max_stale_seconds', 60, 86400], ['max_attempts', 1, 32]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new Error(`pool.${key} 必须为 ${min}-${max} 的整数`);
  }
  if (result.max_stale_seconds < result.sync_interval_seconds) throw new Error('免费资格有效期不能短于同步周期');
  if (!['quality_first', 'fastest'].includes(result.strategy)) throw new Error('pool.strategy 不支持');
  if (!result.tiers || typeof result.tiers !== 'object' || Array.isArray(result.tiers)) throw new Error('pool.tiers 必须是模型 ID 到分级的对象');
  for (const [id, tier] of Object.entries(result.tiers)) {
    if (!id.trim() || !Number.isInteger(tier) || tier < 1 || tier > 10) throw new Error('pool.tiers 分级必须为 1-10，数字越小优先级越高');
  }
  return { ...result, tiers: { ...result.tiers } };
}

function credentialSource(config, configs) {
  return config.credential_ref ? configs.find(item => item.id === config.credential_ref) : config;
}

function validateFreePools(configs) {
  for (const config of configs) {
    if (!isFreePool(config)) {
      if (config.credential_ref !== undefined || config.pool !== undefined) throw new Error('credential_ref / pool 仅用于免费模型池');
      continue;
    }
    if (config.type !== 'apikey') throw new Error('免费模型池必须使用 API Key');
    normalizePoolOptions(config.pool);
    if (config.models !== undefined && (config.models.length !== 1 || config.models[0]?.id !== 'free' || config.models[0]?.protocols?.length !== 1 || config.models[0].protocols[0] !== 'chat_completions')) throw new Error('免费模型池只暴露 free / chat_completions');
    if (config.protocol_paths || config.models_endpoint || config.quota_url) throw new Error('免费模型池使用内置目录和协议，不支持自定义覆盖');
    if (config.credential_ref !== undefined && (typeof config.credential_ref !== 'string' || !config.credential_ref.trim())) throw new Error('credential_ref 必须为账号 ID');
    const source = credentialSource(config, configs);
    if (!source || source.type !== 'apikey' || (config.credential_ref && isFreePool(source))) throw new Error('免费池凭证须引用普通 API Key 账号');
    const allowed = config.preset === 'openrouter-free' ? ['openrouter'] : ['opencode-go', 'opencode-zen'];
    if (config.credential_ref && !allowed.includes(source.preset)) throw new Error('免费池仅能复用对应平台账号');
    if (config.credential_ref && config.apikey) throw new Error('请选择复用账号或独立凭证之一');
    if (!source.apikey) throw new Error('免费池缺少转发凭证');
  }
}

module.exports = { isFreePool, FREE_MODEL, DEFAULT_POOL, normalizePoolOptions, credentialSource, validateFreePools };
