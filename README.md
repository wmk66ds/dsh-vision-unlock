# dsh-vision-unlock

去掉 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）「当前模型不支持图片」的拒绝限制，让未声明多模态能力的模型也能发送和读取图片。

不修改 `app.asar` 里任何一行代码，也不改配置树——纯运行时接缝，随 DSH 升级继续可用。

## 为什么会被拒绝

DSH 判定一条路由能否吃图片，依据两处能力声明：

- **`LlmModelInfo.inputModalities`**（可选字段）。缺这个字段，或数组里没有 `"image"`，
  就被当成纯文本模型。这是**所有门禁**的唯一判定来源：

  | 位置 | 表现 |
  |---|---|
  | 会话控制器 `prompt()` | 发送时弹「当前模型不支持图片，请切换支持图片的模型」 |
  | 子代理 `assertImageCapable` | 向子代理发图被拒 |
  | `read_file` 读图 | `does not declare image input` |
  | MCP / ACP 图片注入 | 同上 |

- **适配器自己持有的模型表**（不经过上面那处）。pi-ai 在发请求前查
  `model.input.includes("image")`；deepseek 适配器序列化前查
  `connection.models[].inputModalities`。

**典型触发场景**：自定义/本地网关路由（如 Agent2API、自建 OpenAI 兼容网关）在配置里只写了
`id / name / contextWindow / maxTokens`，没写 `input`，于是落到默认值 `["text"]`，
被判定为不支持图片——哪怕上游模型其实支持。

## 本插件怎么做

只用两个运行时接缝：

1. 包装 `llm.resolveModelInfo`，给结果补上 `"image"` → 拆掉上表中所有门禁。
2. 遍历 `llm.adapters`，把适配器模型表里的 `input` / `inputModalities` 补上
   `"image"` → 拆掉 pi-ai 的自检。适配器换快照（配置热更新）时自动重做。

## 安装

**方式 A：用 `plugin_manager` 工具（推荐）**

把本仓库 clone 到本地，然后在 DSH 里执行：

```
plugin_manager  action: install_bundle  target: <本仓库的绝对路径>
```

**方式 B：手动安装**

1. 把本目录放到一个稳定的路径，例如 `D:\workbench\dsh-vision-unlock`。
2. 在你的 profile 目录（默认 `~/.dsh/profiles/desktop/`）的 `node_modules` 下建立指向它的链接：

   ```powershell
   cmd /c "mklink /J `"%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-vision-unlock`" `"D:\workbench\dsh-vision-unlock`""
   ```

3. 编辑该 profile 的 `package.json`，在 `dsh.profile.bundles` 数组加入 `"dsh-vision-unlock"`，
   并在 `dependencies` 加入 `"dsh-vision-unlock": "link:D:/workbench/dsh-vision-unlock"`。
4. 重启 DSH。

> Windows 上用 **junction**（`mklink /J`）而不是符号链接——后者需要管理员权限。

## 配置

`cordis.patch.yml` 里的 `config`：

```yaml
- insert:
    - id: vision-unlock
      name: 'dsh-vision-unlock'
      config:
        providers: []   # 留空 = 所有 provider；否则只放行列出的
        models: []      # 留空 = 所有模型；否则只放行列出的
```

两个白名单都为空时全部放行；非空时需**同时**命中才放行。

## 已知边界

- deepseek 适配器的模型表来自它自己的 plugin config，不经由 `llm.adapters` 暴露，
  本插件改不到。该路由如需图片，请在设置页给模型勾选 Image（等价于写
  `inputModalities: [text, image]`）。
- 放行后图片**真的会发出去**。若上游实际不支持多模态，报错会从模型侧返回，
  不再是 DSH 本地拒绝——这是预期行为，不是 bug。

## 卸载

从 profile 的 `package.json` 中删掉 `dsh-vision-unlock`（`bundles` 与 `dependencies` 两处），
删除 `node_modules/dsh-vision-unlock`，重启 DSH。

## 适用版本

针对 DSH 桌面版（含 `dsh-llm` / `dsh-llm-pi-ai` / `dsh-api-session-controller`）验证。
依赖的是 `llm.resolveModelInfo` 与 `llm.adapters` 这两个接口，若上游改动需要同步调整。

## 许可证

MIT
