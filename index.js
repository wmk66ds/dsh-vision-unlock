/**
 * dsh-vision-unlock —— 去掉「模型未声明多模态能力」导致的图片拒绝限制。
 *
 * DSH 判定某条路由能否吃图片，依据两处：
 *
 *   A. `LlmRuntime.resolveModelInfo()` 返回的 `LlmModelInfo.inputModalities`
 *      （可选字段；缺这个字段或不含 "image" 即视为纯文本模型）。
 *      这是所有**门禁**的唯一判定来源：
 *        · 会话控制器 prompt()      → 抛 MODEL_DOES_NOT_SUPPORT_IMAGES
 *        · 子代理 assertImageCapable → 抛 MODEL_DOES_NOT_SUPPORT_IMAGES
 *        · read_file 读图            → 抛 "does not declare image input"
 *        · MCP / ACP 图片注入        → 同上
 *
 *   B. 适配器**自己**持有的模型表（不经过 A）。pi-ai 在真正发请求前会查
 *      `model.input.includes("image")`，deepseek 适配器在序列化前会查
 *      `connection.models[].inputModalities`。这两处不读 A，光改 A 不够。
 *
 * 本插件不改 asar 里的任何一行代码，也不改配置树，只用两个运行时接缝：
 *   1. 包装 `llm.resolveModelInfo`，给结果补上 "image" → 拆掉所有门禁 A。
 *   2. 遍历 `llm.adapters`，把适配器模型表里的 `input` / `inputModalities`
 *      补上 "image" → 拆掉 B。适配器换快照（配置热更新）时自动重做。
 *
 * 已知边界：deepseek 适配器的模型表来自它自己的 plugin config，不经过
 * `llm.adapters` 暴露的对象，本插件改不到。该路由如需图片，请在配置里给
 * 模型声明 `inputModalities: [text, image]`（设置页勾选 Image 等价）。
 */

export const name = 'vision-unlock';
export const inject = ['llm'];

const IMAGE = 'image';

/** 合并默认配置并做最基本的类型校验。 */
export function resolveConfig(raw = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  return {
    providers: Array.isArray(cfg.providers) ? cfg.providers.filter((x) => typeof x === 'string') : [],
    models: Array.isArray(cfg.models) ? cfg.models.filter((x) => typeof x === 'string') : [],
  };
}

/**
 * 一条 provider/model 路由是否放行图片。
 * 两个白名单都为空 = 全部放行；非空时需同时命中。
 */
function allows(config, provider, model) {
  if (config.providers.length > 0 && !config.providers.includes(provider)) return false;
  if (config.models.length > 0 && !config.models.includes(model)) return false;
  return true;
}

/** 返回补上了 image 的 modalities 数组，不改动入参。 */
function withImage(modalities) {
  const list = Array.isArray(modalities) ? [...modalities] : [];
  if (!list.includes(IMAGE)) list.push(IMAGE);
  return list;
}

/** 给 modelInfo 补上 image 输入能力；入参可能被 freeze，故一律返回新对象。 */
function grantImage(info) {
  if (!info || typeof info !== 'object') return info;
  return { ...info, inputModalities: withImage(info.inputModalities) };
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const log = (...args) => ctx.logger?.info?.('[vision-unlock]', ...args);
  const warn = (...args) => ctx.logger?.warn?.('[vision-unlock]', ...args);

  // ---------- 接缝 B：适配器自己的模型表 ------------------------------------
  // llm.adapters: Map<providerId, { adapter, provider, retryPolicy }>
  // pi-ai 的 adapter.current() 返回 { profiles, models }，models 是 pi-ai 的
  // Models 集合：getModels(provider) 返回该路由的模型对象（可变，未 freeze）。
  let touched = 0;
  const patchAdapterModels = () => {
    const llm = ctx.get('llm');
    const registrations = llm?.adapters;
    if (!(registrations instanceof Map)) return 0;
    let count = 0;
    for (const [providerId, registration] of registrations) {
      const adapter = registration?.adapter;
      if (typeof adapter?.current !== 'function') continue;
      let snapshot;
      try {
        snapshot = adapter.current();
      } catch {
        continue; // 该适配器这一代配置不可用，跳过
      }
      const models = snapshot?.models;
      if (typeof models?.getModels !== 'function') continue;
      let list;
      try {
        list = models.getModels(providerId);
      } catch {
        continue;
      }
      if (!Array.isArray(list)) continue;
      for (const model of list) {
        if (!model || typeof model !== 'object') continue;
        if (!allows(config, providerId, model.id)) continue;
        // pi-ai 用 input，deepseek 用 inputModalities；两个都补，谁存在补谁。
        for (const field of ['input', 'inputModalities']) {
          if (model[field] === undefined) continue;
          if (!model[field].includes(IMAGE)) {
            model[field] = withImage(model[field]);
            count += 1;
          }
        }
      }
    }
    return count;
  };

  // ---------- 接缝 A：能力查询 ----------------------------------------------
  const wrapped = new WeakSet();
  const decorateResolve = (llm) => {
    if (typeof llm?.resolveModelInfo !== 'function') return false;
    const original = llm.resolveModelInfo;
    if (wrapped.has(original)) return true; // 已包装过，不叠加
    const replacement = function (provider, model, signal) {
      const settle = (info) => (allows(config, provider, model) ? grantImage(info) : info);
      let result;
      try {
        result = original.call(this, provider, model, signal);
      } catch (error) {
        return Promise.reject(error); // 同步 throw 也算失败，保持抛出语义
      }
      return result && typeof result.then === 'function' ? result.then(settle) : settle(result);
    };
    wrapped.add(replacement);
    llm.resolveModelInfo = replacement;
    return true;
  };

  const attach = (scope) => {
    const llm = scope?.llm ?? scope?.get?.('llm');
    if (!llm) return false;
    decorateResolve(llm);
    return true;
  };

  ctx.inject(['llm'], (scope) => {
    if (!attach(scope)) {
      warn('未取到 llm 服务，能力放行未生效');
      return;
    }
    touched += patchAdapterModels();
  });

  // 适配器换快照 / 路由重注册后，模型表是新对象，需要重做一次。
  const rescan = () => {
    try {
      touched += patchAdapterModels();
    } catch (error) {
      warn('扫描适配器模型表失败：', error?.message ?? error);
    }
  };
  ctx.on('llm/adapters-updated', rescan);
  ctx.on('loader/volatile-update', rescan);

  const scopeText = `providers=${config.providers.join(',') || '*'} models=${config.models.join(',') || '*'}`;
  log(`已加载：放行范围 ${scopeText}`);

  return {
    snapshot: () => ({
      providers: [...config.providers],
      models: [...config.models],
      patchedModelEntries: touched,
    }),
    rescan,
  };
}

export default { name, inject, apply };
