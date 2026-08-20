# JunkyMarkDownReader — 技术方案

一个 Typora 风格的 Markdown **阅读器**（只读，不做编辑）。

> **状态：M0–M4 全部完成并实测通过。** 使用说明见 [README.md](README.md)。
> 本文档保留设计决策与理由，供后续开发参考。实测发现的偏差已就地更新。

## 1. 需求定案

| 项目 | 决定 |
|---|---|
| 定位 | **纯阅读器**，不做编辑、不做所见即所得 |
| 平台 | **仅 Windows**（Windows 11） |
| 打开方式 | **两者都要**：双击单个 `.md` 文件打开 + 打开文件夹当知识库浏览，侧栏可折叠 |
| 排版 | **兼容 Typora 主题 CSS**，可一键换皮 |
| 功能范围 | 代码高亮、大纲导航、亮暗主题、Mermaid 图表 |
| 明确不做 | 数学公式 (KaTeX)、全文搜索、导出 PDF —— 架构留接口，暂不实现 |
| 交付 | 自己用，但要打包成 exe 安装 |
| 取舍偏好 | 体积/内存不敏感，功能与开发速度优先 |

## 2. 技术选型

```
Electron + electron-builder
├─ 主进程        窗口 / 菜单 / 文件读取 / 目录树 / 文件监听 / 自定义协议
├─ preload       contextBridge 安全暴露 IPC（不开 nodeIntegration）
└─ 渲染进程      原生 HTML/CSS/JS（不上前端框架）
   ├─ markdown-it            核心渲染引擎
   │   ├─ markdown-it-anchor       标题 id → 大纲导航基础
   │   ├─ markdown-it-task-lists   - [x] 任务列表
   │   ├─ markdown-it-footnote     脚注
   │   └─ markdown-it-attrs        {.class #id} 扩展语法
   ├─ highlight.js           代码高亮（后续可换 Shiki）
   ├─ Mermaid                流程图 / 时序图
   └─ DOMPurify              清洗 Markdown 内的裸 HTML（安全必需）
```

### 选型理由

- **Electron 而非 Tauri**：体积优势对本项目无意义；Tauri 需 Rust 工具链，编译报错排查成本高。Electron 生态成熟、资料最多、Chromium 内核统一（不依赖用户机器上的 WebView2 版本）。
- **markdown-it 而非 remark/unified**：API 十年稳定，CJS/ESM 都能用；remark 生态 ESM-only 且大版本间 breaking change 频繁，容易出现新旧 API 混用跑不起来。
- **不上 React/Vue**：阅读器状态极简（当前文件、主题、大纲、文件树），多一层抽象只会增加出错面。
- **highlight.js 先行**：同步、配置简单。Shiki 高亮质量更好但异步 + 打包配置麻烦，留作 M2 之后的升级项。

## 3. 三个关键架构判断

### 3.1 亮暗主题 = 替换主题文件，不是 CSS 变量切换

Typora 主题是**独立的完整 CSS 文件**（如 `github.css` / `night.css`），不是靠变量在单文件内切明暗。因此亮暗切换的实现是**动态替换 `<link>` 的 `href`**，而非常规的 `data-theme` 属性切换。

### 3.1b 混合排版：段落与宽元素分开给宽度

段落和表格对宽度的需求相反，所以给它们不同的宽度：

- **段落**有行宽上限（中文 35~45 字/行最好读，超过 60 字回扫吃力），宽度取自
  `settings.contentWidth` 的 8 档预设，**固定像素**而非百分比 ——
  这样开关侧栏时段落宽度不跳动。
- **表格 / 代码块 / Mermaid** 与行宽无关，用负 margin 向两侧各突破 `--bleed`（200px），
  把段落两侧的空白换成信息密度。

突破的居中数学：`#write` 居中于容器，宽元素再以 `#write` 的内容宽为基准居中，
两次居中叠加后元素正好居中于容器。`max-width: calc(100cqw - 2 * var(--wide-guard))`
是防溢出保护（`100cqw` 需要 `.content` 上的 `container-type: inline-size`）。

选择器必须用 `>` 限定直接子元素，否则嵌套的宽元素会突破两次 —— 详见第 8 节。

### 3.2 双层样式系统

| 层 | 样式归属 | 规则 |
|---|---|---|
| 外壳（侧栏 / 工具栏 / 大纲面板） | 自己的 `shell.css` + CSS 变量 | Typora 主题不管这部分，需自写亮暗两套 |
| 正文区（`#write` 内部） | 完全交给 Typora 主题 CSS | **不要写任何自定义正文样式**，会与主题冲突 |

两层明暗需联动，但走两套独立机制。

### 3.3 正文容器必须是 `#write`

所有 Typora 主题都基于 `#write` 这个 ID 写样式。DOM 结构要求：

```html
<body class="typora-export">
  <div id="write">
    <!-- markdown-it 渲染输出 -->
  </div>
</body>
```

代码块输出为 `pre.md-fences`，表格加 `.md-table`。DOM 越贴近 Typora 导出的 HTML，主题兼容度越高。

**待办**：取一份 Typora 真实导出的 HTML 作为参照，对齐 DOM 结构与类名。

### 已知取舍：代码块配色

Typora 主题的代码配色针对 CodeMirror 类名（`.cm-keyword`、`.cm-string`）编写，而 highlight.js/Shiki 输出自己的类名。硬对齐需做类名映射，较脏。

**决定**：代码高亮使用**独立配色**（随亮暗切换，但不受 Typora 主题控制）。若实测视觉割裂明显，再考虑类名映射。

## 4. 必须提前处理的四个坑

1. **本地图片路径** —— `![](./img/a.png)` 在 Electron 中默认加载失败。需在主进程注册自定义 protocol（如 `app://`），或动态设置 `<base href>` 指向当前文件所在目录。**第一天就会撞上，架构须一开始就设计进去。**
2. **安全配置** —— Markdown 可内嵌 `<script>`。必须开启 `contextIsolation: true`、关闭 `nodeIntegration`、渲染前过 DOMPurify、设置 CSP。否则打开来源不明的 `.md` 等于允许其执行任意代码。
3. **ESM / CJS 混乱** —— markdown-it v14+、Mermaid v10+ 均为 ESM，Electron 主进程默认 CJS。**在 `package.json` 中锁定版本号**，避免后续"顺手升级"导致全线崩溃。
4. **大文件性能** —— 超过 ~1MB 的 Markdown 一次性渲染会卡顿数秒。阅读器阶段可暂不处理；如有需求则做分块渲染 + IntersectionObserver 懒加载。

## 5. 目录结构

```
JunkyMarkDownReader/
├─ package.json
├─ electron-builder.yml
├─ PLAN.md
├─ src/
│  ├─ main/
│  │  ├─ main.js            窗口创建、应用菜单、IPC handler
│  │  ├─ preload.js         contextBridge API 定义
│  │  ├─ file-service.js    读文件 / 递归目录树 / 文件变更监听
│  │  └─ protocol.js        自定义协议，解析正文内的本地图片路径
│  └─ renderer/
│     ├─ index.html
│     ├─ app.js             入口、状态管理
│     ├─ markdown.js        markdown-it 实例与插件配置
│     ├─ outline.js         大纲提取 + 滚动高亮（IntersectionObserver）
│     ├─ filetree.js        文件树侧栏
│     ├─ mermaid-render.js  Mermaid 代码块后处理
│     ├─ theme.js           主题切换（替换 themes/*.css 的 link）
│     └─ styles/
│        ├─ shell.css       外壳 UI 样式（自带亮暗 CSS 变量）
│        └─ code.css        代码高亮配色（亮暗两套）
├─ themes/                  Typora 主题 CSS（可自行投放新主题）
│  ├─ github.css
│  └─ night.css
└─ assets/
   └─ icon.ico
```

## 6. UI 布局

```
┌──────────────────────────────────────────────────┐
│ [☰] 文件名.md              [主题▾] [亮/暗] [大纲]│  工具栏
├────────────┬──────────────────────────┬──────────┤
│            │                          │          │
│  文件树    │      #write 正文区       │  大纲    │
│  (可折叠)  │   (Typora 主题接管样式)  │ (可折叠) │
│            │                          │          │
└────────────┴──────────────────────────┴──────────┘
```

- 双击 `.md` 文件打开时：两侧栏默认收起，纯净阅读模式
- 打开文件夹时：左侧文件树展开
- 两侧栏均可折叠，状态持久化

## 7. 分阶段路线图

| 阶段 | 内容 | 预计 |
|---|---|---|
| **M0 骨架** | Electron 窗口 + 打开文件 + markdown-it 渲染 + `#write` 结构 + 挂一个 Typora 主题 | 半天 |
| **M1 阅读体验** | 亮/暗主题切换、主题下拉选择、代码高亮、大纲侧栏（滚动高亮）、字号/行宽设置 | 1~2 天 |
| **M2 渲染增强** | Mermaid 图表、任务列表、脚注、**本地图片路径修复**、图片点击放大 | 1~2 天 |
| **M3 工作区** | 文件夹树侧栏、最近打开、文件改动自动刷新 | 2~3 天 |
| **M4 打包** | electron-builder 打 exe、`.md` 文件关联、应用图标 | 半天 |

M0 结束即有可用成果，后续均为增量改进。

### 留作后续（当前不做）

- 数学公式 (KaTeX) —— 渲染管线预留 markdown-it 插件挂载点
- 全文搜索
- 导出 PDF / HTML —— Electron `webContents.printToPDF()` 成本很低，随时可加
- Shiki 替换 highlight.js
- 多标签页 / 多窗口

## 8. 实施过程中的实测结论

以下是动手之后才确认的事，写下来避免后续重复踩。

### 已验证通过

- **渲染管线**（14 项结构检查）：`pre.md-fences`、`figure > table.md-table`、
  hljs 高亮 span、任务列表 Typora 类名、脚注、本地图片改写为 `md-asset://`、
  三类链接标记、中文标题 id 不被 URL 编码。
- **DOMPurify 配置**（jsdom 实测）：`md-asset:` URL 与全部 `data-*` 标记保留；
  `<script>` / `onerror` / `onclick` / `javascript:` / `<iframe>` / `<style>` /
  `<form>` 全部剥除。
- **界面**：亮色与暗色、Mermaid 图表（含中文标签）、代码高亮、表格列对齐、
  任务列表复选框、大纲层级缩进与当前项高亮、本地图片经 `md-asset://` 显示。
- **文件监听**：外部修改文件后自动刷新，滚动位置保持。
- **打包**：NSIS 安装包 94.1 MB，`dist/win-unpacked` 直接运行正常 ——
  asar 内的 `app://` 资源、主题 CSS、按需加载的 mermaid 都能读到。

### 实测踩到的坑

1. **DOMPurify 默认 URI 白名单不含 `md-asset:`。** 不显式放行，所有本地图片的 src
   会被静默剥掉、图片全裂。修法见 `sanitize.js` 里的 `ALLOWED_URI_REGEXP`。
2. **`FORBID_TAGS` 只删标签、保留子节点。** 于是 `<form><input type="password">`
   清洗后会剩一个孤立密码框，可以用来做视觉欺骗。加了 hook 只放行
   `input[type=checkbox]`（任务列表要用）。
3. **字体栈必须带 emoji 回退。** 不加 `"Segoe UI Emoji"`，文档里的 ⏸ ★ ✓ 在
   Windows 上会渲染成豆腐块（□）。三个 CSS 文件都补了。
4. **`File.path` 在 Electron 32+ 已被移除。** 拖放要拿路径只能走 preload 里的
   `webUtils.getPathForFile()`。
5. **单实例锁会让开发版与打包版互相顶掉。** 两者 `package.json` 相同 → userData
   路径相同 → 同一把锁。要并存测试得给其中一个加 `--user-data-dir`。
6. **`offsetTop` 在大纲测量里不可靠。** Typora 主题可能给 `#write` 设 `position`，
   `offsetParent` 随之改变。改用 `getBoundingClientRect()` 相对滚动容器计算。
7. **IPC 推送到刚创建的窗口会丢消息（真实 bug，已修）。** 渲染进程的 `boot()` 要
   `await` 两次 IPC 才轮到注册监听，而窗口的 `ready-to-show` 可能早于那之前触发。
   主进程此时 `send('doc:open')` 会静默丢失 —— 表现是双击 `.md` 启动后窗口空着。
   **这是间歇性的**，取决于两边谁先跑完，所以很容易误判为「已经能用了」。
   改成渲染进程初始化完毕后主动 `invoke('doc:get-pending')` 领取，竞态消失。
   运行时路径（second-instance、菜单打开）仍用推送，那时渲染进程必然已就绪。
8. **宽元素突破踩了两次坑，都跟 CSS 的「后写者赢」有关。**
   - *嵌套累加*：`#write pre.md-fences` 这种后代选择器会让嵌套的代码块突破两次、
     宽度翻倍后溢出。Mermaid 渲染失败时的错误块里正好有一个 `pre.md-fences`，
     实测就撞上了。改成 `#write > pre.md-fences` 解决，语义上也更对
     （列表里的代码块本来就不该冲破缩进）。
   - *margin 简写覆盖*：后面那条 `#write .md-mermaid { margin: 1.2em 0 }` 把突破
     规则算好的 `margin-left: -200px` 重置成了 0（两条特异性相同，后出现的赢），
     图表于是贴着段落左边缘、向右溢出整个突破量。改成只写 `margin-top`/
     `margin-bottom`。**凡是参与突破的元素，其它规则一律不许用 margin 简写。**

   这两个 bug 肉眼都只表现为「底部多了一条水平滚动条」，根本看不出是谁干的。
   所以在 `app.js` 里留了 `warnIfOverflowing()` 护栏：检测到溢出就把越界元素
   连同超出量打到控制台，并跳过被滚动祖先裁剪的元素（那些不会撑大 scrollWidth）。
9. **设置文件的 BOM 会让所有设置静默丢失（真实 bug，已修）。** `JSON.parse` 遇到
   UTF-8 BOM 直接抛错，`store.load()` 的 catch 会静默回退到默认值。用户拿记事本
   编辑过设置再另存为 UTF-8 就会踩到。已在 `store.load()` 里剥 BOM，并对非 ENOENT
   的读取失败打警告 —— 静默回退是这个 bug 难查的根源。
10. **接第三方 Typora 主题时踩的三个坑（都已修）。**
    - *`#write` 不居中*：真 Typora 里居中由外层容器负责，很多主题（Lapis）
      因此不给 `#write` 写 margin。我们没有那层容器，正文于是贴在 left=0，
      宽元素的负 margin 再一推，每行开头就跑到窗口外 —— 现象酷似「内容被吃掉」。
      修法：`:where(#write) { margin-left: auto; margin-right: auto }`，
      零特异性，主题自己设了就听主题的。
    - *代码块配色与主题底色打架*：`drake-jb` 是亮色正文配暗色代码块，而我们
      原本按亮暗模式选 hljs 配色 → 深色字打在深色底上。改成实测
      `pre.md-fences` 的背景亮度（BT.601 感知亮度）来决定用哪套 hljs 配色。
    - *主题盖掉 hljs 的默认文字色*：hljs 样式表原本排在主题前面，主题的
      `#write .md-fences { color }` 直接盖掉它，导致没有 token 类的字符
      （括号、分号、变量名）不可见。改为 hljs 排在主题**后面** + shell.css
      清掉 hljs 自带背景（底色仍归主题）+ 用 `:root[data-code]` 显式指定
      默认前景色（光靠调顺序压不过 `#write .md-fences` 的特异性）。

11. **左侧溢出用 `scrollWidth` 是查不出来的。** 内容跑到容器左边界外会被直接
    裁掉，`scrollWidth` 纹丝不动。`warnIfOverflowing()` 最初只比较
    `scrollWidth`/`clientWidth`，因此完全没报上面那个 `#write` 不居中的问题。
    现在左右两侧都用 `getBoundingClientRect` 实测。

12. **别用 PowerShell 改含中文的源文件。** `Get-Content -Raw` 按系统 ANSI 读，
    再用 UTF-8 写回，整份文件的中文会变成乱码（`index.html` 被这样毁过一次，
    只能重写）。改文件一律用编辑工具，PowerShell 只用来跑命令。

13. **PowerShell 调 GDI+ 的重载解析不可靠。** `GraphicsPath.AddArc` 与
   `LinearGradientBrush` 的多参重载会报 ArgumentException，生成图标时改用
   Region + Ellipse 拼圆角。（只影响构建脚本，与应用无关。）
