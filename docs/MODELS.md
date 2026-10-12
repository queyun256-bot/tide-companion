# 药代模型、个人校准与证据

> 本文描述 v0.1 基础内核与旧版单途径接口。v0.2 界面使用叠加在此内核上的双激素参考与校准模型，最新行为与参数见 [MODELS-v2.md](./MODELS-v2.md)。下文“未校准只返回相对暴露”和混合途径限制仅指旧接口。

本模块以已录入的实际给药记录计算随时间变化的**模型估计**。它不测量血液，不建议剂量，不预测治疗效果。未做个人化验校准时只返回相对暴露，`value` 为 `null`；界面不得给相对曲线标上血浓度单位。校准后也不能把结果当作实际血检值。

核查日期：2026-10-11。下列标签和原始研究提供制剂特征及少数参数锚点，**不是对本软件模型的临床验证**。有实测幅度校准，也不意味着曲线形状、峰值或谷值经过验证。

## 支持范围与参数

所有半衰期单位为小时；两速率模型的参数是有效形状参数，不能同时解释为真实吸收与游离激素清除。所有途径的血浓度幅度默认未知，必须个人校准。

| routeId | 制剂/给药记录单位 | 吸收半衰期 | 有效消退半衰期 | 参数依据及边界 |
| --- | --- | ---: | ---: | --- |
| `e2-oral` | 微粒化17β-E2口服，mg | 3 | 13 | 两值均是教学假设，约8.3小时达峰；仅借鉴研究观察的时间尺度，没有拟合研究数据。不能自动套用到戊酸雌二醇片等其他制剂。 |
| `e2-sublingual` | 17β-E2舌下，mg | 0.25 | 1.5 | 两值均是教学假设，约0.8小时达峰；没有模拟吞咽与舌下两条路径、肠肝循环或长尾。 |
| `e2-gel` | 雌二醇凝胶，有效成分mg | 4 | 36 | 36小时为特定EstroGel标签表观终末半衰期；4小时是教学假设，不通用于全部品牌、涂抹部位。 |
| `e2-patch` | 贴片标称释放率，μg/24h | 不使用 | 7 | 7小时取自Vivelle-Dot标签5.9–7.7小时范围；恒速释放是教学近似。默认84小时仅为可编辑佩戴时长，实际提前移除应填写实际时长。 |
| `e2-ev-im` | 戊酸雌二醇肌注，酯mg | 12 | 96 | 两值是教学假设，约41小时达峰；原始研究约2天达峰不等于测得这两个半衰期。 |
| `e2-ec-im` | 环戊丙酸雌二醇肌注，酯mg | 24 | 192 | 两值是教学假设，约82小时达峰；原始研究约4天达峰不等于测得这两个半衰期。 |
| `t-cypionate-im` | 环戊丙酸睾酮肌注，酯mg | 12 | 192 | 192小时锚定肌注制剂标签约8天表观半衰期；12小时是教学假设。 |
| `t-enanthate-im` | 庚酸睾酮肌注，酯mg | 6 | 60 | 60小时取特定SmPC中2–3天半衰期范围的中值；6小时是教学假设。不同产品、油剂和研究并不一致。 |
| `t-gel` | 睾酮凝胶，有效成分mg | 6 | 12 | 两值均为教学假设，未经标签或个体拟合。标签仅支持皮肤储库及约24小时递送的描述，不能证明单一Bateman曲线适用。 |

注射条目仅表示表中**肌注**制剂，不能冒充经过验证的皮下模型。此版不包含十一酸睾酮长效肌注、口服十一酸睾酮、复方酯、植入剂、鼻用或抗雄激素模型。添加不支持制剂前，应独立补充制剂证据与模型，不能仅改名字。

## 方程与维度

一次口服、舌下、凝胶或肌注剂量的未缩放贡献采用一室一阶输入/输出的Bateman形状：

```text
ka = ln(2) / absorptionHalfLifeHours
ke = ln(2) / eliminationHalfLifeHours
X(t) = D × ka/(ka-ke) × [exp(-ke×t) - exp(-ka×t)]    t >= 0
X(t) = 0                                              t < 0
```

`D` 为该制剂记录的mg；时间为小时。相等速率使用连续极限 `D × ka × t × exp(-ka×t)`，近似相等及慢吸收时使用数值稳定表达式。`X` 没有包含生物利用度、分布容积或酯转化比例，因此只是特定途径的模型暴露，不能叫血浓度，也不能跨途径比较大小。所有实际已记录剂量按线性叠加；不自动补齐规律给药，也不假定已经稳态。

贴片使用有限时间恒速输入：

```text
R = labeled_micrograms_per_day / 24000   # mg/hour
X(t) = R/ke × [1-exp(-ke×min(t,T))] × exp(-ke×max(0,t-T))
```

`T` 是实际佩戴时长。结束释放后仍有指数尾部；新贴片与旧贴片尾部会叠加。提前脱落、释放随时间变化、皮肤残留吸收及黏附差异未建模。

## 幅度校准

统一浓度为E2的pg/mL和**总睾酮**的ng/dL。E2接受pg/mL、pmol/L及等价ng/L；T接受ng/dL、nmol/L及ng/mL。单位换算基于E2分子量272.38、T分子量288.42，分别为 `1 pg/mL E2 = 1000/272.38 pmol/L`、`1 ng/dL T = 10/288.42 nmol/L`。不把游离睾酮、雌酮或其他化验当作对应项目。

在用户固定的基线 `B` 与固定的形状下，令 `x_i` 为采血时间全部已记录同途径剂量的模型暴露，`y_i` 为换算后的化验：

```text
s = Σ[x_i × (y_i-B)] / Σ[x_i²]
C(t) = B + s × ΣX_dose(t)
RMSE = sqrt(mean((C(t_i)-y_i)²))
```

只拟合一个正幅度 `s`，不自动拟合基线、半衰期或剂量。零基线是待核实的假设，特别不能把它误当成内源睾酮已经被完全抑制。若化验低于固定基线、没有有效暴露或幅度不能识别，拒绝校准。未知单位会被明确排除并计数。

单点校准可以确定比例，但曲线强制经过该点，不能验证曲线；两点或相似暴露时刻也不足以识别吸收与消退。交换两个速率并改变幅度可能给出相同形状，这是结构性不可识别性。`RMSE`仅反映同一批数据的拟合残差，不是预测误差、置信区间或临床精度。

为防止将混合贡献错误归给单一路径，若同一激素在校准样本前出现另一条或未知途径记录，本版**保守拒绝**单途径校准，即使该记录较早。换途径后需要明确限定单途径、历史完整的校准数据集，并考虑旧制剂尾部；不要删除真实历史来绕过检查。E2与T的样本各自筛选，但本版不模拟两者相互抑制或T芳香化产生的E2，因此共用时仍存在模型局限。

改变形状参数、基线或校准前剂量历史会使保存的校准失效；新增采血后的同途径实际剂量不会。更改化验数据后调用方应重新运行`calibrate`。`estimateAt`只消费校准结果，不读取化验数据库。药品品牌、涂抹部位、注射条件改变时也应重新评估，程序无法从剂量数字识别这些变化。

未记录的早期剂量、采血时刻或方法差异、凝胶污染采血、吸收变化、内源分泌及其抑制、蛋白结合、代谢与药物相互作用都会造成偏差。本模型没有剂量目标、超标诊断、自动调整或建议补服功能。

## 调用约定

`src/pk.js`为无依赖ES模块，可在浏览器和Node使用。

```js
import { PROFILES, calibrate, estimateAt, buildSeries } from './src/pk.js';
// doses: [{ id, routeId, amount: number, at: ISO含时区, durationHours?: number }]
// labs: [{ id, analyte: 'estradiol'|'testosterone', value: number, unit, at: ISO含时区 }]
const calibration = calibrate({ doses, labs, routeId, config, baseline });
const current = estimateAt({ doses, routeId, at: new Date().toISOString(), config, calibration, baseline });
// current: { value: number|null, shape: number, unit, status, warnings, warning, routeId, analyte }
// status为uncalibrated时，只显示shape并标记“相对模型暴露”。
const series = buildSeries({ doses, routeId, config, calibration, baseline, start, end, points: 169 });
// 每点包含at及current的字段；y=value??shape，界面仍须根据status标示单位。
```

`config`支持`absorptionHalfLifeHours`、`eliminationHalfLifeHours`和贴片`durationHours`；数值必须为number。有效半衰期输入范围0.001–8760小时是软件数值边界，不是医学推荐范围。基线单位必须与该激素规范浓度相同。`calibrate`返回`factor, rmse, n, excluded, warning, warnings, status, routeId, analyte, unit`及供失效检测使用的签名。`normalizeLab`、`doseShape`、`getProfile`、`UNIT_FACTORS`也可单独导入。

## 参考资料

1. [Doll et al., Pharmacokinetics of Sublingual Versus Oral Estradiol in Transgender Women, 2022](https://pubmed.ncbi.nlm.nih.gov/34781041/)。10名跨性别女性单次交叉给药研究，LC-MS/MS观察的舌下峰约1小时、口服峰约8小时；观察仅到8小时，不能据此确定终末半衰期。DOI:10.1016/j.eprac.2021.11.081。
2. [Oriowo et al., A comparison of the pharmacokinetic properties of three estradiol esters, 1980](https://pubmed.ncbi.nlm.nih.gov/7389356/)。受试者使用联合避孕药抑制内源影响，小组比较花生油中单次肌注酯，EV与EC峰约2天及4天。该人群、油剂及方案不能直接等同于现代个体HRT。DOI:10.1016/S0010-7824(80)80018-7。
3. [DailyMed：Estradiol valerate](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=2984bce2-89bf-4768-a1ca-ccf03b1197be)与[Depo-Estradiol](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=9a4229fd-fecd-4ac1-9c4f-6d442533457f)标签描述油剂肌注的延迟吸收，并不提供本程序选用的两速率参数。
4. [DailyMed：EstroGel](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=762ac371-bb8b-47e7-b48f-e80d452c9dd4)，药代章节给出特定条件下约36小时表观终末半衰期，并讨论涂抹部位清洗等因素。
5. [DailyMed：Vivelle-Dot](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=5ccb77f9-d47b-4381-ad5c-5b92524e1c4a)，药代章节报告5.9–7.7小时半衰期及移除后的浓度变化。
6. [DailyMed：Testosterone cypionate](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=f60c5520-b336-44a2-95d5-f274939fa595)，药代章节报告肌注约8天半衰期；不应将它解释为游离T的生理清除时间。
7. [emc：Testosterone Enantate SmPC](https://www.medicines.org.uk/emc/product/3733/smpc)，5.2节报告健康男性志愿者2–3天血中半衰期。此值具有产品和研究条件限制。
8. [DailyMed：AndroGel 1.62%](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=f4e8d29b-8707-4d47-e053-2a95a90aecee)，12.3节描述24小时持续经皮递送。该标签没有验证本程序凝胶条目的两个半衰期。

## 数值验证

执行`node --test tests/pk.test.js`。测试覆盖解析公式、相等速率极限、慢吸收数值稳定性、时间与剂量叠加、贴片释放率单位与移除连续性、两种激素单位换算、固定基线拟合、混途径拒绝、校准失效及非法输入。测试验证软件计算与声明的数学模型一致，**不构成临床验证**。
