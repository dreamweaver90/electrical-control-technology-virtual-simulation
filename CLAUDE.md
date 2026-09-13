# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 运行方式

```bash
cd "F:\code\AIcoding\13_虚拟接线\code\仿真系统"
python -m http.server 8000
# 浏览器打开 http://localhost:8000/index.html
```

项目是纯 HTML/CSS/JS 多模块应用，无构建工具。**ES module 的 `import` 在 `file://` 协议下无法工作，必须用 HTTP 服务器**。临时 Node 验证脚本需临时 `package.json {"type":"module"}`（用完删除）。

## 功能与使用

**项目是什么**：纯前端（无构建工具、无后端）的电气 + 气动接线仿真与排故教学平台——浏览器里拖放器件、接线、通电仿真、读仪表、设置故障供学生排查。

**启动**：`python -m http.server 8000` → 打开 `http://localhost:8000/index.html`（入口就是仓库根的 `index.html`，直接访问根路径只会看到目录列表）。ES module 必须经 HTTP 加载，不能双击用 file:// 打开。

**图片资源**：全部器件图形集中放在 `images/`，配置里一律写相对路径 `images/<文件名>.png`——`image[].string` 注入的是页面 DOM 的 HTML，相对路径按**页面 URL（站点根）**解析，与 JSON 所在目录无关；也不要写以 `/` 开头的绝对路径（部署到子目录会失效）。

**界面组成**：
- **工具栏**：接线/敷设模式、导线与气管选色、缩放、显示连接线开关、撤回/重做、清除全部、排故难度与退出、导出/导入工程、主题色；
- **配电盘**：有线槽（分行排布）与无线槽（自由摆放）两种布局，滚轮缩放、空白拖动平移；
- **元件库**（右上悬浮按钮）：独立元件（按分类分组）+ 场景组合两个 tab，拖放到盘面即创建实例；
- **浮窗**：参数面板（右键器件）、线标面板（右键导线/气管）、万用表（表笔可拖到端子测量，电阻<10Ω 蜂鸣）、排故面板（记录诊断对错）、告警栈（短路/堵转/串气/漏气等）、十字工作台 3D 视窗。

**典型使用流程**：
1. 从元件库拖放器件（或拖"场景组合"一键铺好整套回路）；
2. 点端子→点端子接线（端子有接线数上限；带电/带压端子默认禁止接线）→ 右键导线设线标、颜色、显示位置；
3. 点开关/按钮/热区，或右键改参数 → 仿真每 50ms 跑一次：触点按时序动作、线圈得电、电机启停与转向、气缸伸缩、气压传播；
4. 看仪表读数（电压表/电流表/电能表/万用表）、看告警栈提示、看器件动画与文字显示；
5. 结构操作可撤回/重做（Ctrl+Z / Ctrl+Shift+Z）；参数与运行状态不撤回；
6. 导出工程 JSON 存档或分享；场景文件放进 `scenes/` 并在主配置登记即可在库中一键加载；
7. **排故练习**：进入排故模式（选难度）→ 系统在已接线处随机注入故障 → 学生用万用表测量排查 → 点击故障点提交判定（对/错都记入面板）。

## 项目状态（重要）

- **已完成**：MNA 数值求解改造（solver.js）、整流器、仪表、场景组合、元件库悬浮面板、电机效率、蜂鸣（电阻<10Ω）、窗口缩放导线跟随（方案 A）、以及**架构重构**：
  - 四类端子对（contacts/loads/permanent/sensors）统一、params/ratings 合并（adjustable）、state 默认值、故障数值等级配置驱动、when+timing 触点时序、能力协议（capabilities 注册表+工厂校验）、type 完全移除、电源 EMF/input 配置化、电机绕组电压相量判定；
  - **变压器（TransformerInstance）+ 整流器功率反射**：初级折算阻抗 `Z_in=|V_in|²/conj(S_total)`（复功率叠加，功率守恒、上一级可测真实输入功率）、可调输入/输出电压、数值阻抗统一取值入口 `_branchZ`（params 优先）、源内阻电流记录 `sourceCurrent`；
  - **state 并入 params**：参数容器统一承载一切（铭牌定值 + 面板可调项 + 逻辑状态键 + 运行时值）；zones 的 `state` 字段 / contacts 的 `when` / loads 条目的 `state` 字段读写 params 同名键（写法不变）；工程快照 v2（组件条目只带 params，无 state 字段）；
  - **image 内绑定 param（显隐 + 动画统一）**：图层显隐 = image 条目 `bind` 字符串（`"key"`=truthy 显示 / `"!key"`=falsy 显示，default/无 bind 恒显）；元素动画 = image 条目 `anims`（`data-bind='标记名'` 元素 + `source` 参数键 + `map` 值域（数字或 `"param:key"`/`"-param:key"` 引用）+ 移动规则：`move`（两点式直线 {from:[x0,y0], to:[x1,y1]}）、`rotate`（绕点扫角 {center, from, to}）、`attr`（纯数值属性插值 {属性名:[from,to]}，`style.` 前缀写 CSS）+ `terminal`（{id, move|rotate} 端子坐标同步：move 只写 from≠to 的轴 → 十字滑台分轴互不覆盖，rotate 用配置坐标反推半径）；基类 scan 每 tick `_updateAnims()`（值比对，稳态零开销）；**端子坐标被动画移动 → 自动重算 auto 导线路径（`_refreshAllWirePaths`）**；**指针式转速表**（SpeedMeterInstance：bind 参数绑定 speed 器件 → `getSpeed()` 带符号 rpm 驱动指针，量程固定 ±2000，刻度 200 间隔）；
   - **气路模块（已完成）**：
     - **气路引擎 `pneumatic.js`**（结构层等压 + 压力源注入，不做气路 MNA）：`buildPneumaticGraph()` = `buildGraph({media:'pneumatic'})`（电路/气路图彻底隔离，graph.js 导线与四类条目全部按介质过滤）；`computePneumatics()` 每 tick：收集 working 压力源（pressure-source 能力）→ 迭代传播（≤12 轮，恒压源直注 + 调压阀动态源 `min(设定,进气)` 级联收敛）→ **串气检测**（同一分量 ≥2 种不同压力；同压并联正常）→ **漏气检测**（有压分量的未接线开口端子；**排气口不建模**，阀排气位 = 无源分量 0 MPa）→ 返回 `{graph, pressure, crossTalk, leaks, pressureOf(term)}`；`isTerminalPressurized(term)` 带压检测（禁止带压接线，语义同电气 isTerminalLive）；
     - **气路器件 4 类**（`pneumatic-devices.js` + `cylinder.js`，N连通件纯配置零代码）：**PressureSourceInstance**（气源：带开关 zone，params 有 switch 键 = 带开关气源 / 无 = 恒压气源；pressure-source 能力，出气 params.pressure 默认 0.8MPa）；**PneumaticValveInstance**（电磁阀，仅双线圈阀单元 `def.raw.pneumatic.valves` 数组；**单线圈阀不进 valves**——线圈 = electrical loads（state 键），气路切换 = pneumatic contacts `when:"state键"`/`when:"!state键"`，弹簧复位不校验气压）。valves 单元字段：`type`（"5_2_double"，"5_3" 三位五通预留后加）/`posKeys`（显式位置键，激活位 true）/`coilMap`（{线圈loads条目key: 位置键}）/`defaultPosKey`（复位位）/`inletPort`（进气端子 id，先导式）。**双线圈状态机**（气路段 scanPneumatic，有效触发 = 线圈得电 ∧ 进气有压）：E 空∧非冲突→保持（记忆）；E 空∧冲突态→进气有压回 defaultPosKey/无压保持冲突；E 单元素→置位（退出冲突）；E 双元素→**双位同时激活 + `_conflict` 标记**（由本类 `collectAlerts()` 汇报进告警栈"双线圈同时得电"）；scan（电气阶段）对全部 loads 判定得电并写 state 键；**PressureRegulatorInstance**（调压阀：`def.raw.regulator {in,out}`，pressure-source 动态源，`inletPressure(graph,pressure)` 供引擎迭代回调，出气 `min(设定,进气)`；指针 = anims.rotate source `out_pressure` map `0~param:gaugeMax`）；**CylinderInstance**（`def.raw.pneumatic.cylinders` 数组，单作用/双作用/多气缸一模块通吃，不兼容旧 cylinder 单对象）：每单元 `{posKey(必填), label?, ports:[{id,target}], equalBehavior?, noAirTarget?}`——label=单元显示名（相对位置能力下拉用，缺省 posKey）；ports 1 个=单作用（通气→该口 target、断气 noAirTarget 目标（弹簧复位=0；缺省保持原位））/2 个=双作用（气压占优口决定 target、等压按 equalBehavior（0/1，省略=保持）、**都断气 noAirTarget（如升降缸断气下降=0）> 保持**）；`params[单元posKey]` 0~1 按速度 1/strokeTime 积分（真实时间），推杆动画 = anims.move source: posKey；通气状态为类内中间量不写 params；**能力 `relative-position`（相对位置）**：`relativePositions() → [{label, posKey, position}]`（磁性传感器等绑定目标，position = 当前 0~1）；**MagneticSensorInstance**（磁性传感器 `magnetic-sensor.js`，三线 NPN/PNP 接近开关，检测气缸位置）：工作 = 红/蓝同 DC 岛 ∧ 红高蓝低（正极性）∧ |ΔU| ∈ workingVoltage×(1±voltTol)；到位 = 绑定气缸（relative-position 能力）∧ |position − detect| ≤ tolerance（+1e-9 防浮点）；输出 = 工作∧到位∧型号匹配 → out_npn（黑-蓝）/ out_pnp（黑-红），触点纯配置 when 驱动；**报警（collectAlerts 钩子）：接交流/超压**（反接/欠压不工作不报警；未绑定永不导通）；参数 target（bind allow:["relative-position"]）/unit（动态 select，`options:"bound:target.relativePositions"` 下拉显示绑定气缸单元 label）/detect（0~1 检测位置）/tolerance/sensorType/workingVoltage/voltTol；lit 状态键驱动 LED 图层；
     - **engine 气路段**：电气 scan 之后 `computePneumatics()` → `G.pneumatics` → 逐器件 `scanPneumatic(pn)`（气缸位置积分/调压阀指针/双线圈阀位置机）→ **统一告警栈 `#alertStack`**（`_updateAlerts` 按 key 增量 diff，值不变不写）：短路跳闸（3 秒自动消失，`_shortTripAt`）/ 短路无保护（常驻）/ 串气（常驻）/ 漏气（常驻 + 端子 `term-dot.leak` 💥 标记）+ **器件级报警 = 基类 `collectAlerts()` 钩子**（引擎遍历实例汇总，零器件特判：双线圈同时得电 / 磁性传感器接交流、超压）——所有提示都在一个列表里竖排显示；
     - **气管**：`Wire.media`（electrical/pneumatic）；`_createWire(t1,t2,opts)` 介质由端子类型派生、按 `wiring[media]` 取配置（thickness/color），**气路无论有/无线槽恒悬链线**（自动模式），工具栏独立气路选色（黑/蓝，`colorPickerPneu`）；Canvas **三层描边渐变**（shadeColor 深色边缘 + 本色 + 高光 = 圆柱气管效果，`_dw`/`_strokePath`）；线标复用 `_dwLabel`（字号按 media 配置）；悬停命中阈值按线宽自适应；带压禁止接线 toast 文案按介质区分；
     - **导入导出**：collectSnapshot 写 `w.media`；applyLayout 删除气路跳过分支，`_createWire` 传颜色覆盖，导入校验两端端子介质一致；场景示例 `pneumatic_demo`（工业机器人中级测试：气源-调压阀-电磁阀模块-执行模块 + 磁性传感器-指示灯 + 按钮模块/SMPS 控制回路）；
     - **导线优先交互**（导线/气管浮于器件上时）：右键 → 优先线标面板（卡片 contextmenu 先 `checkWireHover`）、双击 → 命中导线/气管删线、否则落在器件卡片删除器件（见「面板交互」）、mousedown → 不启动器件拖动（_bindDrag 先查 `checkWireHover`）、悬停 → 不显示器件的 grab 小手（面板 mousemove 命中导线时内联 cursor:pointer 覆盖 `.wired` 的 grab，mouseleave 恢复）；
     - **隐藏连接线开关**（工具栏「显示连接线」iOS 开关，位于自动敷设开关右侧，默认开）：纯视图状态 `panel.hideWires`——只跳过 canvas 绘制（`_redrawWires` clearRect 后 return）与悬停交互（`checkWireHover` 返回 null），**连接关系/仿真/导出照常**；不持久化（刷新恢复显示）；排故模式强制显示（`_applyWireVisibility`：进入排故强制显示、退出恢复开关设置）；
     - **撤回/重做**（工具栏 ↶/↷ + Ctrl+Z / Ctrl+Shift+Z，快照式 `js/undo.js` UndoManager + lcsAlign）：**结构操作可撤回**（接线/删线/线标/器件放置删除拖动（拖动按下记、未移动丢弃）/清除全部/场景与工程导入），**参数与运行状态不撤回**——恢复时 LCS 按器件 id 序列对齐当前与快照组件：存活实例保持当前 params（`applyLayout(layoutDef, {overrideParams, bindIdMap})`）、被删器件用快照 params、bind 引用经 `_rewriteBindIds` 重映射到新实例 id（目标被删置 null）；快照 = `collectSnapshot()`（空盘 null = 撤回即清盘）；容量 `undo.maxSteps`（主配置，缺省 50）；新操作清空 redo；恢复期间 `app._restoring` 抑制接线/拖动重复记快照；参数面板/开关点击/排故/万用表不记快照；
     - **排故**：气路永不设故障——气路配置 pneumatic 段不写 fault/faultLevel；`FaultManager.collectCandidates` **跳过气路导线（media≠electrical）与 pneumatic 条目**；电磁阀线圈 = 电气 loads 条目 fault 0（线圈断路故障候选天然生效）；排故点击忽略气管；
     - **display 扩展**：`display.scale`（数字参数显示倍率，如 position 0~1 显示行程 0~100%）；
     - **气路器件配置文件（现保留 7 种，用户指定）**：`pneumatic_source`（气源：气源.png/气源_通气.png 382×250，开关热区 (170,103) r30，出气 (380,105)，气压值 `display.when:"switch"` 通气才显示）、`pneumatic_manual_valve`（气路开关：158×150 一进一出双向，气孔 (2,96)/(156,96)）、`pressure_regulator`（调压阀：调压阀.png 196×250，黑色等腰三角指针绕 (92,185) 旋转，0→数学215°(左下)/0.5→正上/1→数学-35°(右下)，无刻度无文字）、`pneumatic_parallel`（并联模块：三组三联通互不相通，两对横连通默认断开右键可勾选）、`valve_module`（电磁阀模块 178×450=双控两位五通+单控两位五通：双控部分 coil1 得电∧进气有压→A 出气/coil2→B 出气、都失电保持、默认 A，双线圈同时得电→双位+告警栈；单控部分失电默认 A、线圈得电→B，触点 when `!en3`/`en3`；DC24V 可调）、`cylinder_double`（双作用气缸：模块宽=3/4推杆宽+本体宽，推杆底层左移动画，缩回露1/3→伸出露3/4，气口 (410.13,34.5)/(210.63,34.5)，posKey=position，target a→1/b→0，缩略图推杆气缸缩略图.png）、`execution_module`（执行模块 506×608：升降缸（断气下降 noAirTarget:0）/伸缩缸/夹紧缸三单元，夹爪绑 lift/extend/grip 三变量、执行机构绑 lift/extend，夹紧缸气孔随执行机构移动（anims terminal 同步）；气路进气端子/双向开关两端/气源出气端/调压阀出气端 `allowLiveConnect:true`（带压可接）；

## 文件结构

```
仿真系统/
├── index.html              ← 骨架：工具栏、悬浮面板、DOM 容器、元件库悬浮按钮
├── css/style.css           ← 全部样式（端子、器件卡片、线槽、排故锁定态、悬浮元件库）
├── images/*.png            ← 全部器件图形（配置里一律写 images/<文件名>.png，按页面 URL 解析）
├── system_config_v3.json   ← 系统级配置 + components 文件名列表 + scenes 文件名列表
├── scenes/                 ← 场景组合每个场景一个文件（<id>.json，与主配置 scenes 列表同机制）
├── components/<id>.json    ← 每器件一个配置文件
└── js/                     ← ES module
    ├── globals.js          ← G 全局单例容器
    ├── utils.js            ← DIR、degToRad、pointToSegment、hashToNum、hexToRgba（#rrggbb → rgba，主题注入用）
    ├── config.js           ← ConfigLoader + ComponentDefinition
    ├── terminal.js         ← Terminal（panelPos/claimOffset/exitPoint）
    ├── wire.js             ← Wire（path/offset/mode/label 线标/media 介质）
    ├── graph.js            ← ★ UnionFind + buildGraph（opts.media 介质过滤）+ pairKeyOf + powerTerminals + isTerminalLive
    ├── solver.js           ← ★ MNA 相量求解器：solveNetwork + SolveResult + 复数运算
    ├── pneumatic.js        ← ★ 气路引擎：buildPneumaticGraph/computePneumatics（气压传播+串气+漏气）/isTerminalPressurized
    ├── engine.js           ← SimulationEngine（PLC 周期扫描 + 短路检测 + 数值求解 + 气路段）
    ├── project-io.js       ← 工程导出/导入（collectSnapshot/exportProject/importProject/resolveParamsForImport bind 引用解析）
    ├── components.js       ← 器件类转发出口（export * from './components/index.js'）
    ├── components/         ← ★ 器件类文件夹
    │   ├── index.js        ←   聚合 re-export + ComponentFactory（class 必填）+ 能力契约校验
    │   ├── capabilities.js ←   能力注册表（CAPABILITIES，契约唯一事实来源）+ capabilityViolations
    │   ├── component-base.js ← ComponentInstance 基类（DOM/拖动/四类端子对/when 求值器/数值支路通用实现）
    │   ├── power-devices.js  ← PowerSupplyBase / AcPowerInstance / RectifierInstance / TransformerInstance
    │   ├── coil-device.js    ← CoilDeviceInstance（接触器/继电器/时间继电器/热继电器）
    │   ├── coil-judge.js     ← judgeCoilLoad 线圈得电判定共享模块（接触器/电磁阀共用）
    │   ├── switch-breaker.js ← BreakerInstance（手动合闸走基类 zone.state 绑定，短路跳闸 onShortCircuit）
    │   ├── motor-device.js   ← MotorInstance
    │   ├── indicator.js      ← IndicatorInstance（指示灯，单灯/多灯模块）
    │   ├── meter-devices.js  ← VoltmeterInstance / AmmeterInstance / ElectricMeterInstance
    │   ├── pneumatic-devices.js ← PressureSourceInstance / PneumaticValveInstance / PressureRegulatorInstance
    │   ├── cylinder.js       ← CylinderInstance（单/双作用气缸，relative-position 能力）
    │   └── magnetic-sensor.js ← MagneticSensorInstance（三线 NPN/PNP 磁性接近开关）
    ├── wiring-manager.js   ← 接线状态机、敷设模式、带电检测、导线创建
    ├── panel-manager.js    ← 配电盘双布局、空闲区间表、Canvas 渲染、路径刷新、窗口缩放重映射
    ├── library-panel.js    ← 元件库（独立元件 + 场景组合两个 tab）
    ├── fault-manager.js    ← 排故（配置驱动：条目 fault 数值等级 + 端子 faultLevel）
    ├── multimeter.js       ← 万用表（电阻网络化简 + 电压读求解器 + 蜂鸣）
    ├── param-panel.js      ← 参数设置面板（adjustable 可编辑 ∨ readonly 只读显示；bind 按能力匹配）
    └── app.js              ← App 主控（场景放置 _placeScene、库面板开关、主题注入 _applyTheme：主配置颜色 → CSS 变量）
```

## 核心架构：双层网络模型（已实施）

**结构层与数值层分离**，所有"连通图"统一走 `graph.js`，所有"电气量"统一走 `solver.js`：

| 层 | 数据 | 用途 |
|---|---|---|
| 结构层 `buildGraph()` | 导线+闭合触点+恒连 = 0Ω 边（并查集） | 短路布尔判定、岛划分、带电检测 |
| 数值层 `solveNetwork()` | 真实阻抗支路（MNA 矩阵，50Hz 相量） | 节点电位、支路电流（一次求解全部支路，O(支路数)） |

- `buildGraph(opts)`：`includeCoils`（loads 当导体，带电检测）、`includeFaults`、`excludeInst`（断路器排除排查）、`branchPairKeys`（数值支路端子对不合并，双层阻抗表机制）；四类端子对合并规则：contacts 按闭合状态、permanent/sensors 恒连、loads 仅 includeCoils 时合并；
- `pairKeyOf(a,b)`：端子对全局键（`instanceId|端子id` 排序拼接，顺序无关）；
- `powerTerminals()`：全部 working 电源输出端子（**power 能力**识别 `hasCapability('power')`）；
- `isTerminalLive(term)`：`buildGraph({includeCoils:true, includeFaults:false})` 判带电——**loads（线圈/绕组）在此图中合并**（U1 接 L1 → U2 带电 → 禁止带电接线）；而短路判定图（G_loadfree）中 loads **不合并**（负载自由，防止把负载当短路）；
- `solveNetwork(powerInsts)` → `SolveResult`：
  - 支路来源 = `inst.numericBranches()`（**基类通用实现**：数值阻抗统一走 `_branchZ(cat, e)` 取值入口——loads 按 params.impedance 或 computed 钩子、sensors/contacts 按 **params.sensorResistance/params.contactResistance 优先、条目 resistance 兜底**；open 故障条目自动移除）；
  - 源 = working 电源的 `sourceEmf(term)`（配置 `source` 字段生成，`params.outputVoltage` 可调优先、显式 magnitude 等比缩放）+ 内阻 `params.sourceImpedance`（缺省 0.5Ω，金属性短路限流防矩阵奇异）；
  - **源内阻支路电流记录**：`I = (EMF − V_term)/Zs` 写入 `branchCurrents['instId|src:termId']`，`SolveResult.sourceCurrent(inst, term)` 读取（整流器/变压器功率反射折算用）；
  - **数值连通性分岛**（不能按结构层分量——星形电机共享星点会裂岛，历史 bug）；无源岛跳过、混域岛跳过（结构层已判短路）；
  - **DC 岛剥离支路虚部**（直流稳态感抗=0，AC 线圈接 DC 电流 = U/R）；
  - `SolveResult.potential(term)`（未定义=null）、`domainOf(term)`（'ac'/'dc'/null）、`currentOf(inst,key)`、`sourceCurrent(inst,term)`、`voltageBetween(t1,t2)`（|ΔU|，任一端未定义/异域=null）。

**每 tick 流程**（engine._tick，50ms，单次扫描不迭代）：
`buildGraph()` → `_detectShort()`（短路+断路器跳闸，结构层删减法）→ `solveNetwork()` 挂 `G.solveResult` → 逐器件 `scan(G, {solve, tickMs})`（电磁阀线圈判定更新阀位）→ **气路段**：`computePneumatics()` 挂 `G.pneumatics`（气路图按新阀位构建 + 压力传播 + 串气/漏气）→ 逐器件 `scanPneumatic(pn)`（气缸位置积分/调压阀指针/双线圈阀位置机）→ `_updateAlerts`（统一告警栈）+ `_syncLeakMarks`（漏气端子标记）→ 万用表刷新。

**短路检测与断路器跳闸**（engine._detectShort）：短路判定严格——含 ≥2 个 working 电源输出端子的连通分量 = 短路（任意两源端子同分量即源间直通，AC/DC 混接、电源并联均判）；跳闸 = **数值层触头电流 > rules.tripCurrent**（同域短路岛可解，短路电流由源内阻限流达数千 A，正常支路仅 A 级 → 并联/分叉支路各自短路时各断路器都跳、正常支路不误跳）；混域短路（AC×DC，solveNetwork 跳过）退回结构层"触点两端同短路分量"兜底。

**数值模型要点**：
- 线圈得电：|U| ≥ pickup×额定 吸合 / < dropout×额定 释放（滞回；pickup/dropout 为 params 配置，缺省 0.85/0.6）；相量差自动区分 220/380/DC；`params.coilType` 配了才校验 ac/dc 岛（未配不校验）；
- **电动机（数值层电位判定的三相异步电机）**：
  - 三相绕组 = 3 个 `computed:"motor"` 的 loads 条目（pins = [首端, 尾端]，Terminal 引用），不再按结构层拓扑识别星/三角；
  - **每相阻抗**（预计算缓存 `_Zrun/_Zlock`，构造时 + `onParamsChanged` 重算）：额定接法 `params.ratedConnection`（'Y' 缺省 / 'D'）决定额定相电压 `U_相 = coilVoltage / (D?1:√3)`（coilVoltage 一律按额定线电压解释），`|Z_相| = 3·U_相²·pf·η/P`（pf 功率因数、η 效率、P 三相额定功率）；堵转态 `Z_lock = Z_run / lockRatio`（6 倍）；
  - **运行判定 `_judgeWinding(solve)`**（每 tick 读数值层相量电位）：三绕组电压相量须①幅值均 ≥ `minStartVoltage`×额定相压（启动门槛 0.4）②最大/最小幅值 ≤ `1+balanceTol`（0.1）③相位两两差 120°±`phaseTol`（10°）——三相平衡才判"能转"；相位旋转方向定正反转（`ΔU_v` 超前 `ΔU_u` 120° → 正转）。串电阻降压/变压器供电等"电源经阻抗或变换接入"的方式自然支持；
  - **阻抗双态选型 `_computedLoadImpedance`**：上一 tick 判"能转"且未堵转 → `_Zrun`，否则 `_Zlock`（静止合闸第一拍即 Z_lock → 启动浪涌电流）；
  - **堵转**：`params.target` 绑定 relative-position 执行机构，方向顶到行程端 → `speed` 钳 0 + 阻抗走 Z_lock（6× 电流）→ 热继电器链；
  - **转速模型 `_tickSpeed`**：通电按 `accelTimeOn` 匀加速至额定（cw + / ccw −，可跨 0），断电按 `accelTimeOff` 减速至 0；dt 读主配置 `simulation.refreshIntervalMs`；
  - **派生铭牌值**（readonly 面板显示）：额定电流 = P/(√3·U·pf·η)、堵转电流 = ×lockRatio。
- 热继电器：热元件支路电流 |I| > 整定值（params.heaterSetting）持续 tripDelay（缺省 8s）→ tripped；无电机匹配启发式；
- **整流器/变压器（功率反射）**：`input` 配置两端 |ΔU| ∈ params.inputVoltage×(1±tolerance)（可调优先）→ inputOk → working（含 switch、短路锁死）；working 时输出端子注册为源（整流器 DC / 变压器 AC 由 source.type 决定）；初级 `loads computed:"reflect"` 支路每 tick 折算 `Z_in = |V_in|²/conj(S_total)`，`S_total = S_load + S0`（励磁/待机复功率，有/无功叠加 → 功率守恒精确成立、上一级电源可测真实输入功率）；未工作 → 1GΩ 等效开路；`TransformerInstance` 与整流器完全同构零覆写；
- 断路器触头、电流表分流为双层阻抗：结构层 0Ω、数值层小阻值支路（resistance / params.contactResistance / params.sensorResistance）。

## 器件类体系

- **ComponentInstance**（component-base.js）：`scan(G, ctx)`（基类实现 when/timing 触点求值，子类先 `super.scan`）、`closedContactPairs()`（基类返回 when 条目闭合对；无 when 条目由子类覆盖时合并）、`numericBranches()`（**基类通用实现，数值阻抗统一走 `_branchZ(cat, e)` 取值入口**：loads = `params.impedance`（对象 {re,im} 定值 或 数字=纯阻性可调），computed 条目（`"motor"`/`"reflect"`）由 `_computedLoadImpedance(key)` 计算；sensors/contacts = `params.sensorResistance`/`params.contactResistance` 优先、条目 `resistance` 兜底；`zdc = params.dcResistance`（缺省 z.re）；open 故障条目自动移除）、`permanentPairs()/sensorPairs()`、`hasCapability(name)`、`isTerminalFaultDisabled(term)`（level>1 条目端子排除诊断）、DOM/拖动/钩子；**loads 阻抗统一走器件级 params**（`_branchZ` 取值入口）；
- **能力协议**：`capabilities.js` 注册表（CAPABILITIES：power/speed/trip）+ `capabilityViolations` 工厂校验；继承只是共享实现，能力判断只看 capabilities 声明；
- **PowerSupplyBase**（capabilities:['power']）：`working`、`outputTerminals()`、`sourceEmf(term)`（配置 `source` 字段生成，无 id 硬编码；`params.outputVoltage` 可调优先、显式 magnitude 等比缩放）+ **功率反射折算**（`_computedLoadImpedance`（computed:"reflect" 条目）：`Z_in = |V_in|²/conj(S_total)`；`_secondaryPower`（S=ΣV·conj(I)，读 `solve.sourceCurrent`）/`_noLoadS`/`_noLoadZ`（`noLoadPowerFactor` 控制 R/X 分配）/`_minInputZ` 钳位；未工作 → 1GΩ 开路）；
- **AcPowerInstance**：scan 恒 working；**RectifierInstance**：`input` 两端 |ΔU| ∈ params.inputVoltage×(1±tolerance)（可调优先，**严格检查不满足不带负载**）→ working（含 switch/short_circuit 锁死）+ fuse 热区复位；**TransformerInstance**：与整流器完全同构零覆写（次级 AC 由 `source.type:"ac"` 表达，初级 reflect 折算支路）；
- **CoilDeviceInstance**：loads 条目 |U| 滞回判定（非 computed 条目）+ ton/tof 状态机 + 热继电器（sensors 电流 > 整定值 → tripDelay → tripped）；触点闭合全部由配置 when 驱动，不覆盖 closedContactPairs；
- **BreakerInstance**：状态=手动合闸（基类通用 zone.state 绑定，配置 `state:"switch"`）+ 短路跳闸（trip 能力，onShortCircuit 强制断开）；按钮/按钮组/隔离开关配置 class 直接用 `ComponentInstance`（zones 带 `state` 字段 → 基类 handleZoneAction 通用模板 toggle/on/off/press 自动写 params，触点 when 驱动）
- **MotorInstance**（capabilities:['speed']）：3 个 computed loads 条目 = 三相绕组，运行判定读数值层相量电位（三绕组电压三相平衡 + 相序；容差/门槛为定值参数 minStartVoltage/balanceTol/phaseTol）、`_computedLoadImpedance` 双态阻抗缓存；**转速动态模型**：`_tickSpeed()` 每 tick（50ms）按匀加速更新 `params.speed`——通电（`accelTimeOn` 缺省 1s，0→额定折算加速度，**adjustable**）cw→+额定/ccw→−额定可跨 0、断电（`accelTimeOff` 缺省 3s，**adjustable**）→0，达界钳位；`getSpeed()` 返回运行时值 `params.speed`；scan 更新后调 `_syncTextLabels()` 实时刷新 `display` 转速（左上角 "1450 rpm" 整数，speed param 不可调）；**scan 顺序：先 `_tickSpeed` + `_tickSpeedRelay` 再 `super.scan`（触点求值）**——速度继电器状态键当 tick 生效，减少反接制动切断链条的级联延迟；
- **FuseInstance**（熔断器 `fuse.js`，2P/3P，**逐相电流判定熔断**，与断路器"结构层事件"机制不同、不走 trip 能力）：scan 逐相读触头支路电流（`solve.currentOf(this, 'contact:<条目键>:<对索引>')`），|I| > `params.fuseCurrent`（缺省 30A，可调）∧ 持续 ≥ `params.fuseTime`（缺省 0.1s，可调）→ 该相熔断（状态键置 true 并**保持**，触点 `when:"!fuse_Lx"` 断开——只有短路那路熔断）；更换熔断器 = zones `action:"reset"` + `state` 键逐相复位（FuseInstance 覆写 handleZoneAction）；相配置从 contacts 条目 when 推导零额外配置；熔断视觉 = `爆炸.png` 36×36 图层 bind 熔断键（fuse_2p 139×300 两组熔丝 / fuse_3p 203×300 三组，热区 r18 居中）；
- **IndicatorInstance**（指示灯，单灯/多灯模块通用）：每灯 = 一个 loads 条目（数值支路统一走 params.impedance/dcResistance）；亮灯 = `voltageBetween ≥ params.lampVoltage×0.9`（10% 额定容差，电源内阻分压）且 `params.lampType`（'ac'/'dc'）与岛类型匹配 → 写条目 `state` 键（缺省 'lit'）；**指示灯 params：lampType/lampVoltage/impedance/dcResistance 均可右键调（其他器件 impedance/dcResistance 定值）**；
- **VoltmeterInstance / AmmeterInstance / ElectricMeterInstance**：读数写 image 层 `data-mv` 元素（`_setReadout(t, key?)` 按 key 过滤）；电压表 DC 带极性；电流表 sensors 条目分流；电能表 = 电流线圈（sensors 支路 1-2）+ 并联电压（t1−t3 potential 差，复用 sameReference）+ 实功率 P=Re(U·conj(I)) + 按 50ms tick 累计 kW·h（`data-mv='p'/'e'` 两读数）；
- **SpeedMeterInstance**（指针式转速表）：bind 参数 `target`（allow:['speed']）绑定电机 → scan 每 tick 读 `target.getSpeed()`（带符号 rpm）写 `params.needle_pos`，指针角度由 image 条目 `anims` 驱动（map 静态 ±2000，刻度 200 间隔）；
- 工厂 `ComponentFactory.create`：`class` 字段必填查 CLASS_MAP + **能力契约校验**（漏实现立即抛错）。

## 场景组合 / 工程导入导出（统一布局引擎，已实施）

- **布局定义（layoutDef）统一结构**：`{format,version,layout,components:[{id,row,left,x,y,params,label}],wires:[{from,to,color,media,label?}]}`——scenes 条目与工程快照同构（**v2：状态键并入 params，组件条目无 state 字段**）；**场景文件独立存放 `scenes/<id>.json`**（主配置 `scenes` = 文件名列表，ConfigLoader 与 components 同机制加载）；**导线线标 `wires[].label`**（右键导线配置，Canvas 两端各一个、文字逐字符贴线随导线弯折（`sampleWirePath`/`pointAlongSegs` 纯几何辅助），字号 = `wiring.electrical.labelFontSize`（缺省 12），非空才导出/恢复）；**`wires[].labelSide`**（线标显示位置：'both' 两端缺省 / 'start' 仅起点侧 / 'end' 仅终点侧——右键线标面板"显示位置"下拉设置，导出非 both 才记录，导入恢复，无字段 = 两端）；
- **bind 参数持久化引用 = `"@组件数组索引"`**（运行期 instanceId 是会话内计数器，跨会话无意义，不能进快照/场景）：`collectSnapshot` 导出时把 bind 值改写为 `@索引`（悬空 → 置空）；`applyLayout` 把"恢复参数"推迟到**全部器件放置完成后**，经 `resolveParamsForImport` 解析回新 instanceId（越界/旧残留 `inst_N` 字符串 → 置空 + warn）；手写场景直接写 `"@下标"`（组件数组从 0 数起，与 wires 索引同构）；
- **`App.applyLayout(layoutDef)` 统一引擎**：空盘校验 → 布局模式决定（显式 layout 优先；只提供 row/left → 切有线槽；只提供 x/y → 切无线槽；都提供 → 当前模式；切换时同步工具栏按钮态）→ 逐器件放置（有线槽 `addInstanceAt` 精确+向右/向下/加行 fallback；无线槽 `_ensureFreeArea` 操作区扩充 + `_freeNearest` 防重叠）→ 恢复 params/label → 导线一律 auto `_createWire(t1,t2,{color})`（介质由端子类型派生，导入校验两端介质一致，electrical/pneumatic 全支持；气路自动敷设恒悬链线）→ 失败回滚清空；
- **`js/project-io.js`**：`collectSnapshot()`（双位置/全量 params（含状态键）/label + wires，空盘 null）、`exportProject()`（Blob 下载 `电气控制虚拟仿真工程.json`）、`importProject(jsonText)`（解析校验 → `G.app.applyLayout`）、`resolveParamsForImport()`（bind 引用解析）；
- 工具栏「📤 导出工程 / 📥 导入工程」（隐藏 `<input type=file id=fileImport>`）；
- 场景拖放：`_placeScene` 构造 layoutDef 调 applyLayout（有线槽拖到指定行 = 组件无显式 row 时加 startRow 偏移）；
- 详细 schema 见 `配置说明.md` §十三。

## 元件库悬浮面板（已实施）

右上角 `#btnLibrary` 悬浮按钮开/关 `#library` 悬浮面板；两个 tab：独立元件（`#libraryContent`，按分类分组拖放）、场景组合（`#libraryScenes`）。配电盘占满全宽。

## 面板交互（删除器件）

- **删除按钮**：器件卡片右上角 ×（仅未接线时显示）；点击 → `App.removeComponent(iid, true)`（跳过确认，记撤回快照）。
- **双击删除**：面板 dblclick——先判导线/气管（命中 → 删线）；否则落在 `.component-card` 上且目标不是端子/操作热区/删除钮/可编辑名称 → `removeComponent(iid, true)`（未接线器件等效 ×，已接线被拦截并提示）。
- **自由布局 0 间距**：`_collides` 为纯重叠判定（无单边 gap），元件左右/上下可对称贴到相邻（0 间距）；有线槽占位宽度 = 精确 `cardW`（`_occupy/_release/_rebuildFreeSpace`），同样允许紧邻。
- 行数/尺寸配置见「配置文件约定」`canvas.ductRows`/`canvas.freeLayout`。

## 排故（配置驱动，已实施）

`FaultManager.collectCandidates(maxLevel)` 完全配置驱动，无硬编码：
- **难度等级 = 主配置 `rules.faultLevels` 数组下标**（现 `["简单","中等","困难"]`：选中第 i 档 → 候选 `level ≤ i`）；工具栏排故难度按钮按数组动态生成，点击 = 选择该下标等级；
- 条目级 `fault: {level, types}`：**level 数值等级语义：0 = 任何档位都可设置故障（默认）；1 = 中等及以上档；大值（如 10/100）= 不设故障**；types 白名单 open=断路类、stuck=粘连类（stuck 仅 contacts）；
- 导线故障等级 = 两端端子 `pins[x].faultLevel` 更严格者（数值更大者；默认 0；大值排除），只有断路；
- 候选只在已接线条目/导线上生成；注入统一走 `getFaultModifications`（exclude/add）+ `isEntryOpen`（loads/permanent/sensors 条目级断路）；触点 open 按对断开、stuck 粘连；level>1 条目的端子诊断排除；`connectLimit:0` 端子不参与诊断；
- 教学等级分配示例（现配置）：按钮触点/接触器辅助触点/线圈/延时触点 = 0（所有档可设）；主触点/隔离开关/绕组 = 1（中等及以上档）；热继电器 ol 组/电流表分流/恒连 = 10（不参与）。

## 配置驱动约定（要点）

器件行为全部由 JSON 声明、引擎按通用规则消费；**完整字段清单、可用功能、配置效果与二次开发案例见 `配置说明.md`**。改代码时需掌握的架构性约定：

- **器件配置分组**：标识（`id`/`class`/`category`/`singleton`/`size`）+ `image[]`（图层及三类绑定）+ `zones`（交互热区）+ `params`（统一容器）+ `terminals`（四类端子对）+ 器件专属字段（`source`/`input`/`speedRelay`/`pneumaticSource`/`regulator`/`pneumatic.*`，经 `def.raw` 读取）；
- **外观绑定三类**（都写在 image 条目内、都绑定 params）：`bind` 图层显隐（表达式 truthy/falsy）、`classBind` 参数值 → 元素 class、`anims` 元素动画（`source`+`map` + `move`|`rotate`|`attr`，可选 `terminal` 端子坐标同步）；参数文本叠加用 `params[].display`（含 `when` 条件显隐、`scale` 倍率）；
- **`params`**：`{id, default, label, type, adjustable, readonly, unit, min, max, step, options, decimals, allow, display}`；面板可见 = `adjustable ∨ readonly`（`panelParams()`），写回只走 `adjustableParams()` → `onParamsChanged()`；
- **四类端子对**：`contacts`（`when`/`closeDelay`/`openDelay`，基类时序求值器驱动）、`loads`（`computed` 钩子或 params 阻抗、`state` 得电键）、`permanent`（恒连）、`sensors`（串联测电流支路）；条目级 `fault:{level,types}`；
- **阻抗统一入口 `_branchZ(cat, e)`**：loads → `params.impedance`（数字=纯阻可调 / 对象=定值复阻抗）、DC 岛与欧姆档 → `params.dcResistance`（缺省回退实部）、sensors/contacts → 器件级 resistance params 兜底条目 `resistance`；
- **故障**：条目 `fault:{level,types}` + 端子 `faultLevel`（导线等级取两端更严者）；难度阈值 = 主配置 `rules.faultLevels` 下标；候选只在已接线条目/导线上生成；
- **主配置 `system_config_v3.json`**：`simulation`/`canvas`/`wireDuct`/`wiring`/`render`/`multimeter`/`rules`/`undo`/`components[]`/`scenes[]`；
- **布局定义**（场景与工程快照同构）：`{layout, components:[{id,row,left,x,y,params,label}], wires:[{from,to,color,media,label,labelSide}]}`；bind 参数持久化为 `"@组件索引"`。

## 关键约定

- **蜂鸣**：万用表电阻档测得 < 10Ω 时蜂鸣（Web Audio 持续音，档位切换/超阈值停止）；
- **设计原则：配置驱动优先，讨厌硬编码**——器件行为差异优先用配置表达，代码只保留通用引擎；新增能力先问"能否配置表达"；
- **参数容器统一 `inst.params`**：无独立 state 容器——铭牌定值/可调项/逻辑状态键/运行时值全部存 params；图层显隐由 image 条目 `bind` 声明（truthy 判定）、元素动画由 image 条目 `anims` 声明（数值插值）；子类改 `this.params[k]` 后调 `refreshDisplay()`；
- **数值阻抗统一取值入口 `_branchZ(cat, e)`**：loads→params.impedance（或 computed 钩子）、sensors→params.sensorResistance 兜底条目 resistance、contacts→params.contactResistance 兜底条目 resistance——器件级 params 优先、类别内共享；欧姆档恒用 zdc（dcResistance）与运行态解耦；
- **G 单例**：跨模块用 `G.panel/G.wiring/G.config/G.faultManager/G.app/G.solveResult`；components 文件夹内用别名 `GS`（scan 参数 G 是并查集会遮蔽模块级 G）；
- **scan 单次执行**：每 tick 一遍，状态变化下一周期生效（不迭代，防震荡）；
- **时间基准三套并用，不得混入第四种**：①电气时序（线圈 ton/tof、热继电器 tripDelay、熔断器 fuseTime、电能表积分）= 引擎 `ctx.tickMs`（tick 计数 × `simulation.refreshIntervalMs`，engine 下发；触点 closeDelay/openDelay 用 `_contactTicks`）；②机械积分（气缸/滑台位置）= 墙钟真实 dt（Date.now）；③UI 计时（短路跳闸告警 3 秒）= 墙钟。改主配置 `simulation.refreshIntervalMs` 时 engine tickMs 与电机 `_tickSpeed` 的 dt 同读此配置，天然一致；
- **万用表 destroy-recreate**：destroy 必须移除 document 级监听器；
- **导线路径**：`w.mode==='auto'` 的路径始终可由端子位置推导（`_refreshAllWirePaths` 按 w.mode 重算）；manual 保持轨迹；
- **电路/气路端子**：`Terminal.type`（electrical/pneumatic）不可混接；
- CSS 全在 style.css，类名 `-` 分隔；SVG 用器件全尺寸 viewBox 对齐端子坐标；`.comp-img-layer` 定位补偿 (+6/+4) 与 term-dot 一致。
