# 双激素参考情境与实测缩放（v2）

> 历史版本文档：自软件0.3版起，以[MODELS-v3.md](./MODELS-v3.md)为准。默认E2/T背景已改为论文队列中位数；CPA已支持独立的口服母药浓度参考和化验校准（ng/mL），背景固定0，仍不预测CPA对T的抑制。下文“CPA只记录”及20/450、60/30背景只描述旧版本。

核查日期：2026-10-12。实现为`src/hormones.js`，原来的`src/pk.js`仍保留兼容性。

## 数值表示什么

主结果同时返回雌二醇E2（pg/mL）和总睾酮T（ng/dL），不需要选择单一给药途径。`reference`表示**来源数值锚定的参考情境**：文献或产品标签提供几个观测点，本程序采用简化形状与额外假设组成完整曲线。它不是已经验证的群体PK模型，更不是使用者的实际实时浓度。`calibrated`只表示有个人化验参与幅度拟合，仍不验证曲线形状。`unavailable`的值始终是`null`，不能显示成0。

未校准时给出数值，是为了使同一时间加量、减量或新增同种激素的另一途径能在固定单位下比较。不得把曲线按每个视窗的最大值归一化成0–1。E2与T单位不同，应使用分别标明单位的纵轴或独立图表；颜色可分别使用粉色与蓝色。

这个版本不模拟内源激素反馈、E2对T的抑制、T芳香化产生E2、CPA作用、SHBG或复杂制剂变化，也不会给出治疗目标或用药建议。

## 两类基线分开保存

`referenceBaselines`是未校准情境的背景假设。可编辑的预设为：

| 情境 | E2背景（pg/mL） | 总T背景（ng/dL） |
| --- | ---: | ---: |
| MTF参考 | 20 | 450 |
| FTM参考 | 60 | 30 |

这些数字是软件情境预设，**不是来自性别身份的医学推断、正常范围、治疗目标或已被药物抑制的基线**。没有对应激素给药时，显示的只是假设背景。例如服用E2/CPA后，未给药T的450并不表示用户的实际T仍为450，因为抑制过程未建模。最近化验应单独显示日期和值，不能冒充当前浓度。

`baselines`是个人拟合使用的固定基线，默认0。它与参考背景独立。改变MTF/FTM参考情境不能修改个人化验或个人拟合基线。切换模式后如何保留用户自定义参考背景由调用方决定。

```text
未校准：C_reference(t) = referenceBaseline + Σ referenceIncrement_route(t)
已校准：C_calibrated(t) = personalBaseline + factor × Σ referenceIncrement_route(t)
```

同一种激素的背景只加入一次。不能先给每条途径加基线再相加。

## 参考幅度如何得到

每条路线沿用v1的Bateman或有限时长恒速输入方程，见[MODELS.md](./MODELS.md)。其中多个半衰期仍为教学形状假设。以下幅度只在**原始默认半衰期**下计算一次并固定；修改半衰期后不把新曲线重新缩放到同一个峰值，剂量也不会被归一化抵消。

| 途径 | 已核查来源锚点 | 本版使用方法与额外假设 |
| --- | --- | --- |
| E2口服 | 1mg，观测总峰35pg/mL、采样峰时8h | 在默认形状8h的1mg响应上匹配35。来源摘要没有可扣除基线，明确假设来源基线0；不能称为基线校正净药物增量。观测止于8h，不是已知完整终末曲线。 |
| E2舌下 | 1mg，观测总峰144pg/mL、1h | 在默认形状1h匹配144。同样假设来源基线0；吞咽比例等未建模。默认曲线真正峰时不一定正好1h。 |
| E2凝胶 | EstroGel有效成分0.75mg每日，第14天未扣基线24h平均28.3pg/mL | 以来源基线0及重复给药稳态平均近似处理。产品、部位不同不能认为等效。 |
| E2贴片 | Vivelle腹部50μg/day组总平均57pg/mL；研究平均基线11.7 | 取差45.3作参考，再用连续恒速输入稳态近似。原表该组均值在80h测量，实际释放与恒速近似有差异。 |
| T庚酸酯肌注 | 特定SmPC：**200mg**肌注后24h观测总峰1233ng/dL | 在默认形状24h匹配1233，并显式假设来源基线0。注意产品浓度250mg/mL不等于该研究给药量。 |
| T凝胶 | AndroGel1.62%第112天最终40.5mg组平均524ng/dL，安慰剂组303 | 组间差221仅作粗参考。不是同一个人的治疗前后差，也不是个人分布容积；该研究经历剂量调整，不能据此证明线性剂量反应。 |

对峰值锚点：`referenceScale = observedTotal / X_originalDefault(referenceDose, referenceTime)`。对普通凝胶稳态平均近似：`referenceScale = referenceIncrement × ke_default × 24 / referenceDose`。贴片：`referenceScale = (57 - 11.7) × ke_default / (50/24000)`。

这些公式将总峰或组间结果转成“可相加参考增量”所需的假设完整暴露出来，并不使这些假设成为真实生理参数。特别是来源基线假设0时，实际来源人群内源贡献可能被错误计入药物增量，再加本机情境背景会重复计算一部分内源贡献。这是该参考情境的已知偏差，数值不能据此决定治疗。

EV、EC、T环戊丙酸酯目前没有在本次实现中核准足以设定幅度的来源，所以**不编造未校准总值**。单一这样的途径仍可用个人化验直接拟合其形状幅度；若与其他路线混用，缺少相对幅度时单一共同倍率无法解决，整体返回不可估计，并保留全部记录和最近化验。不能删除历史绕过限制。

## 多途径的个人校准

先按参考假设合成同一激素的所有途径增量 `x_i`，在每个真实采血时刻计算已记录给药的贡献，再拟合**一个**正倍率：

```text
factor = Σ[x_i × (lab_i - personalBaseline)] / Σ[x_i²]
```

例如同一时间段已记录2mg舌下和2mg口服，且采血为200pg/mL，模型会将两者的参考贡献相加，再按该总贡献拟合共同倍率，不会丢弃其中一条途径，也不会对两条途径分别声称得到个人校准。

各途径相对比例仍是参考假设。单个化验无法分开识别每一条途径的个人吸收、基线和半衰期。若新增途径在所有化验中均没有模型暴露，不能把原途径的个人倍率迁移给新途径，因此回到明确标记的参考情境。单样本零RMSE只说明曲线被缩放至该点；RMSE不是预测区间或医学准确性证明。

没有药物暴露的旧化验、重复记录不会提供幅度信息，会被排除并说明。不同激素的化验分别换算、分别拟合。个人基线高于有效样本、未知单位或无正幅度时不生成校准值。未能校准但参考来源完整时可继续显示`reference`，并显示失败原因；若参考本身缺失，则`unavailable`。

### 为什么“增加记录”不总是立刻升高

- 吸收有时间：口服/舌下模型在给药恰好发生时的新增贡献为0，随后上升；不是瞬时静脉推注。
- 新增采血之后的同途径剂量：不会改写那次采血时的暴露，所以倍率保持不变，之后的模型贡献增加。
- 补录或修改采血之前的剂量：重拟合时暴露增加，为仍匹配同一化验，倍率可能降低。历史剂量全部翻倍，拟合倍率可能减半，最终曲线不一定翻倍；这是重新拟合的数学结果，应让使用者看见拟合信息。
- 新增的是CPA：本版不会凭CPA剂量直接给T曲线减去一个数。

## CPA只记录与提醒

`cpa-oral`不进入任何激素的浓度贡献，也不被当作未知途径导致无条件拒绝所有结果。Androcur SmPC 5.1描述CPA的雄激素受体阻断及通过负反馈减少促性腺激素作用；这属于不同层面的药效关系。CPA自身的血药浓度或剂量不是总T浓度，不存在本软件已验证的“CPA用量 → 实时T降低量”映射。

## API

```js
import { compileHormoneModel, analyzeHormones, buildHormoneSeries,
  REFERENCE_BASELINES, REFERENCE_MODELS } from './src/hormones.js';

const model = compileHormoneModel({
  doses, labs, modelConfigs, baselines, referenceBaselines,
  mode: 'mtf', at: new Date().toISOString()
});
const current = model.at(); // { estradiol: result, testosterone: result }
const curve = model.series({ start, end, points: 201 });
// [{ at: ISO, estradiol: result, testosterone: result }, ...]
```

每个`result`含：

```text
value: number|null
unit: pg/mL | ng/dL
status: reference | calibrated | unavailable
reasonCode, warnings: string[], warning: string
latestLab: { value, unit, at, originalValue, originalUnit, ... } | null
baseline, referenceBaseline, personalBaseline, baselineKind
referenceValue: number|null
calibration: { factor, n, rmse, status, method, routeIds, warnings, ... }
routeContributions: [{ routeId, name, shape, referenceIncrement, contribution, supported, unit, note }]
```

`shape`不是血浓度。`referenceIncrement`、`contribution`和`value`使用对应激素规范单位，但它们的数值地位仍由`status`和明确假设决定。`latestLab`保留采血时间，不能改名为“当前血值”。`calibration.method`通常是`shared-reference-scale`；只有单一缺参考幅度途径使用`single-route-shape`。

`compileHormoneModel`在数据/配置变化时调用一次；`at`与约200点`series`复用已准备的剂量内核和已拟合结果，不会在每个点重新校准。返回对象中的拟合信息视为只读。使用者输入变化后重新compile；本机当前时刻变化则复用`model.at(new Date().toISOString())`。快捷函数`analyzeHormones`与`buildHormoneSeries`每次会重新compile，避免在逐点循环中调用它们。

## 来源

1. [Doll et al., 2022，口服与舌下E2原始研究](https://pubmed.ncbi.nlm.nih.gov/34781041/)，PMID34781041，DOI10.1016/j.eprac.2021.11.081。10名跨性别女性、单次交叉给药与短时采样，提供35/144的观测总峰，不能视作长期个体PK模型。
2. [DailyMed EstroGel标签12.3](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=762ac371-bb8b-47e7-b48f-e80d452c9dd4)：提供第14天未扣基线平均28.3及特定条件36小时终末半衰期。
3. [DailyMed Vivelle-Dot标签12.3与表2](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=5ccb77f9-d47b-4381-ad5c-5b92524e1c4a)：提供50μg/day组57、研究平均基线11.7及移除后半衰期范围。
4. [Testosterone Enantate SmPC 5.2](https://www.medicines.org.uk/emc/product/3733/smpc)：7名性腺功能低下男性，200mg肌注后24h峰1233±484ng/dL。此研究给药量须与制剂250mg/mL浓度区分。
5. [DailyMed AndroGel1.62%标签14.1、表6](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=f4e8d29b-8707-4d47-e053-2a95a90aecee)：第112天按最终剂量分组，40.5mg组524、对照303，存在剂量调整与人群差异。
6. [Androcur SmPC 5.1](https://www.medicines.org.uk/emc/product/15996/smpc)：CPA的受体与抗促性腺机制；不支持简单减去T浓度的算法。

## 验证范围

`node --test tests/hormones.test.js`覆盖来源锚点（含T庚酸酯200mg修正）、双激素、参考/个人基线隔离、剂量线性、固定幅度与半衰期编辑、凝胶平均、贴片移除、多途径单幅度拟合、采血后新增剂量、CPA不减T、未支持途径、单位换算、未知输入以及compile/series复用。这些是数值与功能测试，不是临床验证。
