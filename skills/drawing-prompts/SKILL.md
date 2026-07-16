---
name: drawing-prompts
description: Use when a user asks to improve an image-generation prompt for artwork, illustrations, portraits, characters, scenes, posters, product images, UI mockups, composition, camera direction, typography, or negative constraints.
---

# Drawing Prompts

## Overview

先读取本 skill 自带的 `references/source-best-practices.md`，再把用户的图片想法整理成可执行、可检查的 prompt。本 skill 自包含，所有提示词参考材料都随目录分发，不读取外部 skill 资源。

只负责 prompt 打磨。用户要求直接生成或编辑位图时，把最终 prompt 交给 `airouter-image`；不要直接调用已废弃的 `imagegen`。

## Workflow

1. 读取 [references/source-best-practices.md](references/source-best-practices.md)，选择与目标模型、图片类型和用途相关的规则。
2. 识别用途和模型类型：OpenAI 兼容图像模型、Midjourney、Stable Diffusion、Firefly/Gemini，或未指定的通用模型。
3. 先确定画布、用途和画面骨架，再补主体、环境、媒介、构图、镜头、光线、色彩、材质、文字和约束。
4. 用户要求生成图片时，最终 prompt 优先使用英文；用户只要求优化 prompt 时，按其语言偏好输出。
5. 对编辑任务写清 `change only X` 和 `keep Y unchanged`，并标注每张输入图的角色。
6. 对海报、UI、信息图和中文文字图，逐字保留真实文案，明确层级、区域、可读性和禁止添加的额外文字。
7. 迭代时每次只调整 1–2 个变量，并重复身份、构图、文字和布局等关键不变量。
8. 直接生成或编辑位图时，把最终 prompt 交给 `airouter-image` 执行；如果该 skill 不可用，只输出 prompt 并明确说明没有执行生图。

## Model Guidance

| 场景 | 写法 |
| --- | --- |
| OpenAI 兼容图像模型 | 使用可扫读的分段结构；明确用途、布局、主体、关键细节和约束；编辑图写清修改项与不变量。 |
| Midjourney 类模型 | 使用短而明确的短语；具体词优于长说明；重要细节才写入；排除项使用模型支持的 negative/no 机制。 |
| Stable Diffusion 类模型 | 用关键词类别检查 subject、medium、style、details、color、lighting；负面词保持短而有针对性。 |
| 商业图、海报、UI、信息图 | 像创意 brief 或产品规格一样写画布、层级、真实文案、区域、可读性，并禁止假 logo 和乱码。 |
| 摄影和写实图 | 写清镜头感、光线、材质瑕疵和真实场景物件，少用空泛的 high quality。 |

## Prompt Skeleton

按需使用，不机械填满：

```text
Use case / asset type:
Canvas / layout:
Primary request:
Subject:
Scene / environment:
Style / medium:
Composition / camera:
Lighting / mood:
Color / materials:
Exact text, if any:
Constraints:
Avoid:
```

## Checklist

- `Subject`：写清对象、数量、动作、姿态、表情、服装和关键物件。
- `Medium`：摄影、工笔、水墨、水彩、海报、UI mockup、产品渲染等只选主方向。
- `Composition`：明确近景、半身、全身、广角、俯视、居中、留白、网格或分区。
- `Lighting / Color / Materials`：分开描述，不用“高级感”替代可见细节。
- `Text`：需要准确渲染的文字使用引号，要求清晰、完整且不增加额外字符。
- `Avoid`：只保留最可能破坏结果的风险，例如乱码、水印、假 logo、多余人物或风格跑偏。

## Output

用户只要 prompt 时：

```markdown
**Prompt**
<最终 prompt>

**Why**
<一句话说明采用的关键提示词原则>

**Avoid**
<负面约束>
```

用户要求直接生成图片时：先输出并确认最终 prompt，再交给 `airouter-image` 生成；完成后报告保存路径、模型、核心 prompt 和验收结果。
