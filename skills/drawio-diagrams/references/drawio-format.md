# draw.io 文件格式速记

## 最小 `.drawio`

`.drawio` 文件可以是 XML。最外层常用 `<mxfile>`，页面是 `<diagram>`，图模型在 `<mxGraphModel>` 内。draw.io 的 Edit Diagram 对话框显示当前页的 `<mxGraphModel>` 源码；完整文件通常包一层 `<mxfile>`。

```xml
<mxfile host="app.diagrams.net">
  <diagram name="Page-1" id="page-1">
    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="node-a" value="Client" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="120" y="120" width="140" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="node-b" value="API Service" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
          <mxGeometry x="360" y="120" width="160" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="edge-a-b" value="HTTPS" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;" edge="1" parent="1" source="node-a" target="node-b">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

## ID 与布局

- `id` 使用稳定语义名：`client-web`、`svc-order`、`db-order`、`edge-web-gateway`。
- 顶层必须有 `mxCell id="0"` 和 `mxCell id="1" parent="0"`。
- 节点：`vertex="1"`，包含绝对 `x/y/width/height`。
- 边：`edge="1"`，使用 `source` 和 `target` 指向节点 id，`mxGeometry relative="1"`。
- 容器节点先创建，子节点 `parent` 指向容器 id；容器本身 `vertex="1"`。
- 避免手写压缩/编码 diagram 内容；简单本地生成可用未压缩 XML，draw.io 能打开后再保存成自己的格式。

## 样式建议

- `rounded=1;whiteSpace=wrap;html=1;` 适合普通业务节点。
- `edgeStyle=orthogonalEdgeStyle;endArrow=block;html=1;` 适合系统关系。
- 同一类型节点复用同一 `fillColor`/`strokeColor`。
- 标签短，过长时用换行实体 `&#xa;` 或拆节点。

## 验收

- XML 可解析。
- 每条边的 `source`/`target` 存在。
- 没有重复 id。
- 节点坐标不重叠；同层节点尺寸一致。
- 没有敏感信息、临时 token、真实个人信息。
