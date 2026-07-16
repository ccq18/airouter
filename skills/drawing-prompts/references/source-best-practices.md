# 外部绘画提示词最佳实践

## 来源

优先参考这些外部来源，规则冲突时按目标模型选择：

- OpenAI Image Generation Models Prompting Guide
  https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide
- Midjourney Prompt Basics
  https://docs.midjourney.com/hc/en-us/articles/32023408776205-Prompt-Basics
- Adobe Firefly effective prompts / style reference / image settings docs
  https://helpx.adobe.com/firefly/web/work-with-images/generate-images/writing-effective-text-prompts.html
  https://helpx.adobe.com/firefly/web/work-with-images/generate-images/reference-images-for-styling.html
  https://helpx.adobe.com/firefly/web/work-with-images/generate-images/set-styles-for-image-generation.html
- Google Imagen prompt guide（页面提示 Imagen 已 deprecated；prompt basics 仍有参考价值，生成优先看新的 Gemini image docs）
  https://ai.google.dev/gemini-api/docs/imagen
- Stable Diffusion Art prompt guide（社区经验，适合 SD/关键词模型）
  https://stable-diffusion-art.com/prompt-guide/

## 共识规则

1. 清楚描述想要的画面，不堆叠“好看、高清、精致”等空泛词。
2. 先写用途、画布和布局，再写主体、环境、细节和约束。
3. 短而准确通常比长段落更稳；复杂生产图使用分段或 JSON-like 结构。
4. 用数量、位置、材质、光线、视角、色彩和风格边界替代泛化形容词。
5. 文字必须出现在图中时，把精确文案放进引号，并要求 legible、crisp、no garbled characters。
6. 为参考图声明角色：style reference、composition reference、edit target、logo source。
7. 负面词只覆盖高概率风险：乱码、水印、假 logo、畸形手、额外人物、风格跑偏和过度性化。
8. 小步迭代，并重复身份、构图、文字和布局等不变量。

## OpenAI 兼容图像模型

- 按一致顺序组织场景、主体、关键细节和约束；复杂请求使用短标题或换行。
- 明确 intended use，例如 ad、UI mockup、infographic、poster、product shot 或 portrait。
- 指定材质、形状、纹理和媒介；写实图直接说明 photorealistic，并补充拍摄语言。
- 控制 framing、viewpoint、angle、placement、negative space、lighting 和 mood。
- 编辑图必须明确修改内容和保留内容，每次迭代都重申不变量。
- UI、图表和教育图像按规格文档写画布、层级、标签、数据、可读性和装饰边界。

## Midjourney

- 使用短而清楚的短语，避免冗长清单。
- 用精确同义词替代泛词；数量重要时写清楚。
- 以正向描述为主，排除项使用模型支持的 negative/no 参数。
- 重点描述 subject、medium、environment、lighting、color、mood 和 composition。
- 参数放在 prompt 末尾；图片和风格参考会同时影响风格与内容。

## Adobe Firefly 与 Gemini

- 使用 descriptive、specific、original 的表达，不满意时小步改写 prompt。
- aspect ratio、content type、style reference、composition reference、lighting 和 camera angle 等外部控制项，也要在 prompt 中表达对应意图。
- 基础结构保持为 subject + context + style；长度受限时只保留最重要的关键词和 modifiers。
- 涉及现实世界最新信息时先确认事实来源，不让图像模型凭空生成当前事件、天气或产品细节。

## Stable Diffusion 与关键词模型

- 用 subject、medium、style、details、color、lighting 做检查，不必填满每一类。
- 写清主体外观、动作、服装、背景和视角。
- prompt 越具体，变化空间越窄；探索时先使用短 prompt，再逐步增加关键词。
- 负面词可以描述对象、属性或风格；从短列表开始，按结果逐步补充。
- 艺术家名、embedding、LoRA 和 style token 可能带来隐藏关联，使用前评估背景、构图和人物特征污染。

## 常用骨架

### 通用绘画

```text
<medium/style>, <subject with action and count>, <environment/context>,
<composition/framing>, <lighting>, <color palette>, <materials/textures>,
<mood>, <constraints>, Avoid: <targeted negatives>
```

### 分段 Prompt

```text
Use case:
Canvas/layout:
Scene:
Subject:
Key visual details:
Style/medium:
Composition/camera:
Lighting/color/materials:
Exact text:
Constraints:
Avoid:
```

### 产品和复杂商业图

```text
/* PRODUCT_RENDER_CONFIG: short name */
{
  "canvas": "2:3 vertical hero image",
  "subject": "primary product and visible details",
  "environment": "background, surfaces, props",
  "materials": ["visible material 1", "visible material 2"],
  "lighting": "single clear lighting plan",
  "composition": "where the subject sits and how space is used",
  "output": {
    "mood": "commercial/editorial/etc.",
    "avoid": ["fake logos", "plastic CGI", "unreadable text"]
  }
}
```

### 编辑和参考图

```text
Image 1: edit target.
Image 2: style/reference/source role.
Change only <target change>.
Preserve <identity/layout/text/camera/background/invariant list>.
Match <lighting/color/materials> so the edit integrates naturally.
Do not add <extra elements/text/logos/watermarks>.
```

## 人像安全与审美

- 成人主体写 `adult`；服装和姿态保持 tasteful、modest、non-explicit。
- 不用 fetishized、exotic、submissive 等词塑造族裔或地域身份。
- 文化身份通过服饰、场景、媒介、时代感和艺术传统表达，不写刻板标签。
- 真实人物、名人、品牌和 IP 风格用于公开资产时保持谨慎，优先原创角色和原创产品。
