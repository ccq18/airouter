# 图表与 draw.io 外部最佳实践

## 来源

- draw.io：Diagramming best practices
  https://www.drawio.com/docs/best-practice/
- draw.io：Consistency in diagrams
  https://www.drawio.com/docs/best-practice/consistent-diagrams/
- draw.io：When does it make sense to generate a diagram?
  https://www.drawio.com/docs/best-practice/generated-diagrams/
- draw.io：How to write better queries for AI generated diagrams
  https://www.drawio.com/docs/best-practice/write-query-generate-diagram/
- draw.io：Manually edit the XML source
  https://www.drawio.com/docs/manual/advanced/diagram-source-edit/
- Mermaid syntax reference
  https://mermaid.js.org/intro/syntax-reference.html
- GitHub Docs：Creating diagrams with Mermaid
  https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams
- C4 model official site
  https://c4model.com/
- Structurizr DSL
  https://docs.structurizr.com/dsl
- PlantUML sequence/component diagrams
  https://plantuml.com/sequence-diagram
  https://plantuml.com/component-diagram
- Excalidraw JSON schema
  https://docs.excalidraw.com/docs/codebase/json-schema
- Agents365-ai/drawio-skill，MIT license，完整现成 skill，可作为重型实现参考
  https://github.com/Agents365-ai/drawio-skill

## 来源驱动的规则

### draw.io / diagrams.net

- 遵守 3C：concise、clear、consistent。
- 同类元素使用同一形状、尺寸、颜色和文字样式。
- 同一颜色或线型只表达一种含义；有多重含义时加图例。
- 保持节点对齐和均匀间距；分组之间留出明显空间。
- 标签用一致命名模式，例如全名词、全动宾短语或统一编号。
- 技术图保持同一抽象层级：overview 不塞组件内部细节，component 图不塞系统全景。
- AI 生成适合头脑风暴、通用流程和简单 sequence/flow/concept map；记录现有系统时必须从真实代码、配置、DDL、OpenAPI 或用户材料抽取事实。
- 对标准图（BPMN、C4、AWS/GCP/Azure、UML）使用标准形状库或专门语法；AI 生成的普通形状只能作为草稿。
- 不把敏感、私人或机密业务信息放进在线 AI diagram query。

### 写 diagram query

- 第一词写图类型，例如 `vertical flowchart - ...` 或 `sequence diagram - ...`。
- 写清方向：vertical、horizontal、left-to-right、top-down。
- 用简单直接的句子；同一参与方/系统始终使用同一个名字。
- 把关键分支、异常、约束写出来；生成器不知道你没写的业务规则。
- 太长时拆成多个短 query，再合并到同一画布。
- Mermaid 支持的图，使用 Mermaid 的术语可提升生成质量，例如 journey 的 sections/tasks/value。

### Mermaid

- Mermaid 源码必须先声明图类型，如 `flowchart LR`、`sequenceDiagram`、`erDiagram`。
- README/Markdown 内嵌优先 Mermaid，因为 GitHub 支持渲染 Mermaid fenced blocks。
- 避免 Mermaid 保留/易破坏词：flowchart 节点文本里的小写 `end` 要加引号或改大小写；节点 id 后连线遇到 `o`/`x` 开头要加空格或大写，避免变成 circle/cross edge。
- 复杂 flowchart 用 subgraph 分组；当图过密时拆多个图，不靠样式硬挤。
- 需要稳定可解析时，少用花哨主题和复杂 HTML，先保证语法。

### C4 / Structurizr

- C4 适合软件架构，核心层级是 System Context、Container、Component、Code，另有 Dynamic、Deployment、Landscape。
- 一个图只表达一个层级。不要把系统上下文、容器、组件、部署节点混在同一张图里。
- Structurizr DSL 适合把 C4 model 作为文本源管理，后续可导出 PlantUML、Mermaid、PNG/SVG 等。

### PlantUML

- PlantUML 适合 UML/时序图：文字是单一事实源，参与者、消息和关系可快速迭代。
- 时序图先声明关键 participant/actor/boundary/control/entity/database，保证顺序和语义。
- 复杂交互使用 `alt`、`opt`、`loop` 分块，不用普通注释替代流程结构。

### Excalidraw

- Excalidraw `.excalidraw` 是明文 JSON，适合白板式草图和协作讨论稿。
- 文件包含 `type: "excalidraw"`、`version`、`source`、`elements`、`appState`、`files`。
- 需要精确技术交付时优先 draw.io/Mermaid/PlantUML；需要手绘感和快速讨论时才选 Excalidraw。

### 已合并的 Agents365 drawio-skill 模式

- 本 skill 已内置完整实现：自然语言到 `.drawio`、Mermaid 转可编辑 draw.io、代码/基础设施/SQL/OpenAPI 抽取、Graphviz 自动布局、导出 PNG/SVG/PDF/JPG、视觉自检。
- 执行时遵循“先抽取 graph，再自动布局，再 validate/render/self-check”的流程。
- 大规模生产 `.drawio` 文件、解析代码库或导出多格式时，直接使用本 skill 的 `scripts/`，不要依赖另一个 draw.io skill，也不要手写大量 XML。
