# 浓度模型审计、论文背景与 CPA（v3）

> 历史版本说明。v0.4 的 E2/T 模型、EV 舌下支持和参考参数以 [MODELS-v4.md](./MODELS-v4.md) 为准；本文的 CPA 标签推导及背景论文仍适用。

核查日期：2026-10-12。实现：`src/hormones.js`、`src/pk.js`；目录由`src/medications.js`提供。本文件说明当前版本，旧版[MODELS-v2.md](./MODELS-v2.md)的任意背景预设和“CPA仅记录”已被本版本替代。原有E2/T参考幅度的推导与局限仍见v2。

软件输出的是按已记录给药和简化模型计算的**参考浓度**或**个人实测幅度校准曲线**，没有血液传感器，也没有临床验证。“calibrated”不表示半衰期、峰谷或未来浓度已经可靠。数值不能用于自动调药、判断抑制效果或给出治疗目标。

## 治疗前背景来自原始论文中位数

预设取自[Vlot et al., 2019，Table 1](https://pmc.ncbi.nlm.nih.gov/articles/PMC6852079/)（DOI `10.1002/jbmr.3762`）。这是Amsterdam ENIGI成人子队列；研究排除既往使用HT者，要求9–12时空腹采血，并选择完成一年随访、具备所需血样及DXA数据的人。

| 参考队列 | E2原文中位数（IQR），pmol/L | E2换算，pg/mL | 总T原文中位数（IQR），nmol/L | 总T换算，ng/dL |
| --- | ---: | ---: | ---: | ---: |
| TW，n=121，MTF参考 | 105（84–133） | 28.5999 | 19.0（14.0–23.0） | 547.998 |
| TM，n=132，FTM参考 | 187（67–525） | 50.93506 | 1.3（1.0–1.7） | 37.4946 |

原表明确是median/IQR，并非范围中点。换算采用E2分子量272.38、T分子量288.42：`pg/mL = pmol/L × 0.27238`；`ng/dL = nmol/L × 28.842`。界面可显示28.6/548.0和50.9/37.5，计算保留原换算值。

该队列不是整个人群的正常值标准；选择条件、月经/绝经状态和检测方法影响适用性。治疗前中位数更不能代表用药后水平。MTF/FTM在这里选择参考队列，不从身份推断器官或实际内源分泌。

数值和文献元数据唯一保存于`src/reference-presets.json`。引擎导出`REFERENCE_BASELINES`和`BASELINE_EVIDENCE`，供界面共用。`referenceBaselines`可由使用者覆盖；`baselines`仍是个人拟合使用的固定基线，两者独立。CPA不存在内源背景，两类CPA背景均固定为0。

## CPA：母药浓度，独立于睾酮

[Androcur 50 mg正式SmPC 5.2](https://www.medicines.org.uk/emc/product/15996/smpc)的药代段描述：**两片50 mg，即100 mg**口服后约3小时出现约285 ng/mL总CPA峰；终末半衰期43.9±12.8小时，绝对生物利用度88%。这里的50 mg是片剂规格，不能把285锚到50 mg。来源并未提供可直接移植的GAHT个体模型。

实现选用一室、一级吸收及一级消除的近似，参考半衰期为标签终末点估计43.9小时。通过峰时方程推导吸收速率，而不是声称标签测出了吸收半衰期：

```text
ke = ln(2) / 43.9                         ≈ 0.0157892 h⁻¹
tmax = ln(ka / ke) / (ka - ke) = 3 h
ka ≈ 1.5432225816901766 h⁻¹
absorptionHalfLife = ln(2) / ka ≈ 0.449155675133261 h

K(D,t) = D × ka/(ka-ke) × [exp(-ke×t) - exp(-ka×t)]
referenceScale = 285 / K(100,3)
C_CPA(t) = referenceScale × Σ K(dose,t-timeOfDose)
```

`D`单位为CPA mg，`t`单位为小时，结果为总CPA **ng/mL**。对100 mg的来源峰值进行幅度锚定已包含来源条件下的吸收影响，**不会再乘0.88**。该缩放系数不是独立测得的分布容积；一室模型不表达分布相、15β-羟基代谢物、个体清除或相互作用。其他剂量、重复给药采用线性叠加近似，需要明确这是外推。

默认模型在给药时刻贡献为0，约3小时达峰，随后下降；记录后立即看到的数值不应按静脉推注跳升。改变半衰期时保留原参考幅度，不强制新曲线仍经过同一个峰。CPA的浓度既不是总T浓度，也不是受体阻断或内源T抑制百分比；本版没有“CPA浓度→T降低量”方程。

CPA化验必须明确`analyte:'cpa'`。支持`ng/mL`和`nmol/L`；根据[FDA GSRS的CPA分子量416.94](https://precision.fda.gov/ginas/app/ui/substances/a3bdbd07-dfa1-48c7-bd38-8fe8814edbd0)，`ng/mL = nmol/L × 0.41694`。同为nmol/L的T化验使用另一换算系数，不能混用。CPA采用固定0背景的独立幅度拟合；E2/T化验不会参与CPA拟合。

无CPA给药记录时返回参考0，只表示已记录贡献为0；不等于化验证实为0或排除了漏记。最近CPA实测保留日期和值，不能当作当前读数。

## 哪些记录可以计算

目录中的“支持记录”与“具备浓度模型”是不同能力。当前有10个形状模型，其中7个提供有明确额外假设的未校准参考幅度：

| 药物及途径 | 当前模型地位 |
| --- | --- |
| 游离E2口服、游离E2舌下 | Doll研究峰值锚定；完整时间形状仍为教学假设，仅适用于对应E2，不能延伸为EV参数 |
| E2凝胶、E2贴片 | 分别以EstroGel、Vivelle标签数值锚定；不代表所有品牌、部位或配方等效 |
| T庚酸酯肌注、T凝胶 | 特定产品来源锚定；T凝胶使用的组间差仅是粗参考，不是个体前后差 |
| CPA口服 | Androcur标签约束的一室近似，独立ng/mL输出 |
| EV肌注、EC肌注、TC肌注 | 保留旧教学形状；未核准绝对参考幅度。仅单一路径可用实测拟合幅度；含这些途径的混合方案缺少相对幅度时不给不完整总值 |
| 其他E2/T药物与途径 | `record-only`：记录与提醒，无法由当前证据/实现得到浓度曲线 |
| 螺内酯、比卡鲁胺、5α还原酶抑制剂、孕激素、GnRH药物等 | 记录与提醒；药效或相互作用不作为E2/T/CPA浓度加减项 |

新增的`record-only` E2/T记录通过`getMedication`识别。从记录时间开始，它只使**对应激素**总值及`referenceValue`变成`null`，不把未知贡献当0，也不误伤另一激素或CPA。即使有化验，缺少药物时间形状也不能凭一个采样点捏造整条曲线。历史和实测均保留。

没有可信的消退参数时，程序不擅自假定一个洗脱期限，也不会自动删除旧记录来让曲线重新出现。`unsupportedMedications`指出造成缺口的项目和来源。未知目录ID仍会保守阻止所有分析物，因为其贡献类别也未知。

### 本轮核查后仍不套用的模型

- **口服EV：**[Progynova SmPC 5.2](https://www.medicines.org.uk/emc/product/1417/smpc)描述0.5–3小时首峰、6–8小时第二峰及3–5%绝对生物利用度。其27小时是药物及代谢物的排泄半衰期，不可直接当作E2血清消除半衰期。单一Bateman曲线也不表达双峰。因此本轮保留记录。
- **舌下EV：**[Doll研究](https://pubmed.ncbi.nlm.nih.gov/34781041/)明确研究17β-E2，不能自动推广到EV。检索到[Serhal与Craft 1989原始论文摘要](https://pubmed.ncbi.nlm.nih.gov/2566746/)涉及卵子捐赠及舌下给药，但本次可核查的原始内容没有足够的单剂量时间序列来确定EV舌下吸收/转化参数；这不是声称没有任何临床使用或研究。也不会仅乘酯分子量比例便宣称等效。
- **E2喷雾：**[Lenzetto SmPC 5.2](https://www.medicines.org.uk/emc/product/11175/smpc)报告第14天1/2/3喷的未扣基线几何平均Cavg分别为17.8/28.2/29.5 pg/mL，且暴露增加低于剂量比例。这些稳态摘要不足以确定每次喷雾的释放形状，也反对盲目使用一条线性凝胶曲线。
- **其他酯、口服TU、皮下制剂、植入剂、颊黏膜给药：**不能从相似名称、相同活性母药或标称mg直接推出相同生物利用度与释放速率。本轮未加入没有核准参数的完整浓度模型。

## 模型审计原则

量纲正确并不保证生理准确；表观终末半衰期不能无条件当游离母药消除；来源观测总浓度不等于药物净增量；含服时间不能凭预设直接确定黏膜吸收比例。更多拟合参数需要相应数据及可识别性检查，当前本地引擎仍只拟合每一分析物一个幅度，不自动拟合半衰期。

## 仍然存在的参考偏差

E2口服/舌下、部分凝胶和T庚酸酯的来源锚点是观测总值。现有参考模型显式采用来源基线0，不能称其为测得的净增量；再加本机队列背景可能重复包含来源内源贡献。T凝胶的组间差也不是个人基线校正。现在每个结果的`warnings`均携带具体来源假设，不能只在文档中隐藏这些限制。

一次幅度拟合只允许模型匹配个人化验的数量级，并不修正错误形状、内源变化或来源路线比例。一个样本的RMSE为0没有验证价值。补录化验前用药后倍率可能变化；新增化验后同途径剂量则增加之后贡献而不改变该样本的拟合倍率。这是模型重算的结果，不应通过图形归一化掩盖。

参考与校准均叠加全部可计算路线，**背景每一分析物只加一次**：

```text
reference  = referenceBackground + Σ fixedSourceScale(route) × kernel(route)
calibrated = personalFixedBackground + fittedFactor × Σ referenceIncrement(route)
```

E2/T/CPA的化验、单位和拟合相互独立。混合已支持路线只拟合合成贡献的一个共同倍率，不能称各路线均已独立校准。缺少路线覆盖、模型、单位或有效暴露时保留原因，不把无效值改为0。

## 接口与验证

```js
import { compileHormoneModel, REFERENCE_BASELINES, BASELINE_EVIDENCE } from './src/hormones.js';
const model = compileHormoneModel({ doses, labs, modelConfigs, baselines, referenceBaselines, mode, at });
const result = model.at(); // { estradiol, testosterone, cpa }
const points = model.series({ start, end, points: 201 });
```

三个结果结构一致：`value:number|null`、`status`、`unit`、`latestLab`、`calibration`、`warnings`、`routeContributions`、`referenceValue`等。CPA的单位为ng/mL；E2为pg/mL；T为ng/dL。新增`baselineSource`/`referenceBaselineSource`只标识与论文预设一致的参考背景，CPA和自定义值不冒充队列数据；`unsupportedMedications`提供缺模型的目录项目。

`compileHormoneModel`在记录/配置变化时运行一次，`at`和201点`series`复用内核和拟合。显示模式只选择可见曲线，不能删掉记录或改变其他分析物拟合。MTF界面可默认E2粉线、CPA紫线；FTM默认T蓝线、E2按需展开，单位必须随轴和读数显示。

`node --test tests/pk.test.js tests/hormones.test.js`通过46项数值/行为测试，覆盖论文中位数换算、来源锚点、叠加与基线、贴片移除、未知/仅记录路线、E2与EV区分、全部目录的分析物隔离、慢吸收面积、CPA实际锚点剂量/峰时/尾部/单位/独立校准，以及旧接口兼容。这些检查证明实现满足所述方程与限制，**不构成临床准确性验证**。
