---
name: airouter-image
description: 当用户要求画图、生成图片、生图、绘画、插画、人像、美女、角色、场景、海报、产品图、UI mockup，或通过 Airouter/OpenAI 兼容代理/GPT-Image 生成或编辑图片时使用。本地 imagegen 已作废，普通图片生成默认走本 skill 的 Airouter 脚本。
---

# Airouter Image

通过 Airouter/OpenAI 兼容代理生成或编辑位图图片。本 skill 自带判断、prompt、透明图和验收规则；底层固定使用本 skill 的脚本发起最终 API 调用。

执行前，先把当前已加载的 `airouter-image/SKILL.md` 所在目录解析成绝对路径，并设置为 `AIROUTER_IMAGE_SKILL_DIR`。不要假设 skill 安装在 Codex、Claude 或任一固定目录。最终 API 调用必须走当前 skill 自带的脚本：

```bash
AIROUTER_IMAGE_SKILL_DIR="/absolute/path/to/current/airouter-image"
python3 "$AIROUTER_IMAGE_SKILL_DIR/scripts/airouter_image.py" ...
```

不要改用已作废的 `imagegen`、内置 `image_gen` 工具、其他图片生成 CLI，或临时写 SDK runner。用户明确要求离开 Airouter 路径时，先说明本地 `imagegen` 已作废并确认新的可用通道。

## 路由优先级

- 中文短指令如“画个美女”“画张图”“生成图片”“生图”“做张海报”，默认触发本 skill。
- 本地 `imagegen` 已作废；当 `airouter-image` 与 `imagegen` 同时看似适用时，必须使用本 skill，不要调用 `imagegen` 或内置 `image_gen`。
- 用户点名 `imagegen` 时，只能处理检查、维护、恢复等管理任务；不得用它执行图片生成或编辑。
- 如果本 skill 触发但 Airouter 配置或脚本不可用，先报告具体失败；不要静默退回到 SVG/HTML/CSS 手绘占位图。

## 适用场景

- 生成照片、插画、产品图、网站素材、游戏素材、UI mockup、信息图等位图资产。
- 编辑本地图片：改背景、改光照天气、替换局部物体、风格迁移、抠图预处理等。
- 用户明确指定 Airouter、OpenAI-compatible proxy、GPT-Image-1.0、GPT-Image-1.5、GPT-Image-2。
- 需要查看或初始化本地 Airouter 图片配置。

不适用：

- SVG、图标系统、logo 源文件、HTML/CSS/canvas 可确定性完成的图形。
- 需要严格可编辑矢量输出的任务。
- 需要当前脚本尚未暴露的 API 能力，且用户不愿扩展脚本或切换路径。

## 分层规则

- 上层策略：使用本 skill 的意图判断、prompt 结构、输入图片角色标注、透明图 chroma-key 方案、保存和验收标准。
- 底层执行：只用 `scripts/airouter_image.py` 的 `generate`、`edit`、`show-config`、`init-config`。
- 绘画、插画、人像、角色、场景等创意图片请求：如果当前运行时已安装 `drawing-prompts`，先用它打磨 prompt；未安装时直接使用本 skill 的 Prompt 结构继续，不得因此阻塞。最终 API 调用仍走本 skill 的 `airouter_image.py`，除非用户明确要求改用其他通道。
- 可选的 `drawing-prompts` 只负责打磨 prompt；最终生图仍回到本 skill，不交给 `imagegen`。
- 多资产请求：逐个调用 `generate` 或 `edit`；当前脚本没有 `generate-batch`。
- 项目资产：优先用 `--output` 显式写到 workspace；不要让项目引用只指向临时或不确定位置。
- 预览资产：可以写到当前工作目录，但仍要报告保存路径。

## 快速命令

查看配置：

```bash
python3 "$AIROUTER_IMAGE_SKILL_DIR/scripts/airouter_image.py" show-config
```

初始化或重写配置：

```bash
python3 "$AIROUTER_IMAGE_SKILL_DIR/scripts/airouter_image.py" init-config --force
```

初始化会在本机 `~/.config/airouter-image/config.json` 写入空的 `api_base` 和 `api_key`，并把目录/文件权限收紧为 `0700`/`0600`。首次使用时：

1. 把 `api_base` 配置为 Airouter/OpenAI 兼容服务的绝对 HTTP 或 HTTPS 地址。使用 HTTP 时，API key、prompt、输入图片和响应会以明文经过网络，只应连接可信代理和可信网络。
2. 把密钥写入本机配置的 `api_key`，或仅在当前环境中设置：

```bash
read -rsp 'Airouter API key: ' AIROUTER_IMAGE_API_KEY
export AIROUTER_IMAGE_API_KEY
echo
```

不要把真实密钥提交到 skill 仓库。

生成图片：

```bash
python3 "$AIROUTER_IMAGE_SKILL_DIR/scripts/airouter_image.py" generate \
  --prompt "A clean product photo of a small white mug on a desk." \
  --model 2 \
  --output /absolute/path/to/output.png \
  --output-format png
```

编辑图片：

```bash
python3 "$AIROUTER_IMAGE_SKILL_DIR/scripts/airouter_image.py" edit \
  --input-image /absolute/path/to/input.png \
  --prompt "Add a small matte red hat on the mug. Change only the hat; keep the mug, lighting, and background unchanged." \
  --model 2 \
  --output /absolute/path/to/output.png \
  --output-format png
```

## 工作流

1. 解析当前 skill 的绝对目录并设置 `AIROUTER_IMAGE_SKILL_DIR`，再运行 `show-config`，确认 `api_base`、默认模型和输出格式；不要把密钥写进 prompt 或回复。
2. 判断意图：没有输入图通常是 `generate`；要修改现有图片就是 `edit`；仅作风格/构图参考的图片不是 edit target。
3. 判断用途：项目资产用明确 `--output` 落到 workspace；一次性预览可写当前目录。
4. 标注输入图角色：`Image 1: edit target`、`Image 2: style reference`、`Image 3: compositing input` 等。当前脚本只支持一个 `--input-image`，多图需求见兼容性边界。
5. 按下方 prompt 结构整理用户需求。用户已经具体时只规范表达；用户很笼统时才补充少量有助于出图的构图、材质、用途信息。
6. 执行 `generate` 或 `edit`。不要传脚本不支持的参数。
7. 检查输出：主体、风格、构图、文字、编辑不变量、透明边缘、是否有水印或多余元素。
8. 需要迭代时一次只做一个明确变化，并重新写入关键约束。
9. 最后报告：保存路径、使用模型、最终 prompt 或核心 prompt、是否有 revised prompt、以及任何未满足的限制。

## Prompt 结构

按需使用这些行，不要机械填满：

```text
Use case: <taxonomy slug>
Asset type: <where the asset will be used>
Primary request: <user's main prompt>
Input images: <Image 1: role; Image 2: role>
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/UI/etc>
Composition/framing: <wide/close/top-down; placement>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

常用 taxonomy：

- 生成：`photorealistic-natural`、`product-mockup`、`ui-mockup`、`infographic-diagram`、`scientific-educational`、`ads-marketing`、`productivity-visual`、`logo-brand`、`illustration-story`、`stylized-concept`、`historical-scene`
- 编辑：`text-localization`、`identity-preserve`、`precise-object-edit`、`lighting-weather`、`background-extraction`、`style-transfer`、`compositing`、`sketch-to-render`

Prompt 规则：

- 文字必须逐字渲染时，用 `Text (verbatim): "..."`，并要求不添加额外字符。
- 编辑任务始终写清不变量：`change only X; keep Y unchanged`。
- 人像/身份保持任务要锁定脸、体型、姿态、发型、表情、光照和背景中不应改变的部分。
- 参考图必须声明角色；不要默认所有输入图都是待编辑目标。
- 不要凭空添加品牌、口号、角色、道具或叙事元素。

## 模型与参数

- 支持模型：`1`/`1.0`/`gpt-image-1`、`1.5`/`gpt-image-1.5`、`2`/`2.0`/`gpt-image-2`。
- 默认模型来自 `~/.config/airouter-image/config.json`，通常是 `gpt-image-2`。
- 输出格式：`png`、`jpeg`、`webp`。
- 可用参数：`--prompt`、`--model`、`--output`、`--output-format`；编辑额外需要 `--input-image`。
- 请求超时时间固定写在 `airouter_image.py` 中，默认 `300` 秒；不要从外部传 `--timeout`。
- 不要使用当前脚本不支持的 `size`、`quality`、`n`、`mask`、`input_fidelity`、`background`、`transparent` 等参数。

## 透明图

当前 Airouter 脚本没有原生透明背景参数。默认使用本 skill 的 chroma-key 方案：

1. 让模型生成或编辑为纯色背景：默认 `#00ff00`；主体含绿色时改用 `#ff00ff`。
2. Prompt 必须要求背景完全单色，无阴影、渐变、纹理、反射、地面、光照变化；主体边缘清晰，有留白，主体内部不要使用 key color。
3. 用 Airouter 脚本输出源图到明确路径。
4. 运行系统 helper 抠透明：

```bash
python "$AIROUTER_IMAGE_SKILL_DIR/scripts/remove_chroma_key.py" \
  --input /absolute/path/to/source.png \
  --out /absolute/path/to/final.png \
  --auto-key border \
  --soft-matte \
  --transparent-threshold 12 \
  --opaque-threshold 220 \
  --despill
```

5. 验证结果有 alpha 通道、四角透明、主体覆盖合理、无明显 key color 边。
6. 若复杂主体导致失败，例如发丝、半透明材质、玻璃、液体、烟雾、反光或软阴影，说明当前 Airouter 脚本不支持 `background=transparent`，询问用户是扩展脚本/API 参数、改用其他已确认路径，还是接受 chroma-key 近似结果。

透明图 prompt 模板：

```text
Use case: background-extraction
Primary request: <subject or edit request>
Scene/backdrop: perfectly flat solid #00ff00 chroma-key background for local background removal
Constraints: background must be one uniform color with no shadows, gradients, texture, reflections, floor plane, or lighting variation; crisp silhouette; generous padding; no halos or fringing; do not use #00ff00 anywhere in the subject; no watermark; no text unless explicitly requested
```

## 与内置图片生成通道的不兼容点

| 内置图片生成经验/能力 | Airouter 当前处理 |
| --- | --- |
| 默认调用内置 `image_gen` | 不兼容。本 skill 必须调用 `airouter_image.py`。 |
| `imagegen` / CLI fallback `scripts/image_gen.py` | 本地已作废，不作为图片生成或编辑入口。 |
| `generate-batch` | 当前脚本没有。多资产逐个调用。 |
| 原生 `background=transparent` | 当前脚本没有该参数。先 chroma-key 后本地抠图；失败则询问。 |
| `quality`、`size`、`input_fidelity`、`mask`、`n` | 当前脚本没有。不要承诺或伪造这些参数。 |
| 多输入图编辑/合成 | 当前脚本只上传一个 `--input-image`。多图需求要拆步、让用户选择主图，或先确认扩展脚本。 |
| 内置工具默认保存到 `$CODEX_HOME/generated_images` | Airouter 默认保存到当前目录；项目资产应显式 `--output`。 |
| 本地图片编辑需先让内置工具看到图片 | Airouter 可直接用本地路径；但做视觉判断前仍应查看图片。 |

## 验收清单

- [ ] 调用前已确认配置可读，且未泄露 `api_key`。
- [ ] 使用了 `airouter_image.py`，没有混用其他生成通道。
- [ ] 输出路径明确；项目资产已落到 workspace。
- [ ] Prompt 包含用途、主体、风格、构图和关键约束；编辑任务包含不变量。
- [ ] 没有传当前脚本不支持的参数。
- [ ] 透明图已运行并验证 chroma-key 抠图，或已说明当前能力边界。
- [ ] 回复用户时包含保存路径、模型和最终 prompt 摘要。
