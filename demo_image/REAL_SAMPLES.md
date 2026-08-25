# 真实样本信件 — 下载清单

这些是各机构官方公开的样本文件。我的工具只能读取内容、无法把二进制
文件写到你的磁盘，所以请自行下载后放进 `demo_image/real_samples/`。

下载后建议统一转成 PNG 再喂给 OCR：

```bash
cd demo_image/real_samples
for f in *.pdf; do
  sips -s format png --out "${f%.pdf}.png" "$f" 2>/dev/null || \
  magick -density 150 "$f[0]" "${f%.pdf}.png"
done
```

---

## 已逐字核对过的（措辞已写进词典和回归测试）

| 类别 | 机构 | 文件 | 链接 |
|---|---|---|---|
| 红蓝卡 | CMS（联邦医保） | Part A MSN 官方样本 | https://www.cms.gov/medicare/medicare-general-information/msn/downloads/sample-part-a-medicare-summary-notice.pdf |
| 红蓝卡 | CMS | DME MSN 官方样本 | https://www.cms.gov/Medicare/Medicare-General-Information/MSN/Downloads/Sample-DME-Medicare-Summary-Notice.pdf |
| 白卡 | 加州 DHCS | MC 210 RV 年度复审通知 | https://www.dhcs.ca.gov/formsandpubs/forms/Forms/MC210RV_Notice.pdf |
| 白卡 | 加州 DHCS | MC 210 完整申请表 | https://www.dhcs.ca.gov/formsandpubs/forms/Forms/MC-210-ENG.pdf |
| 法院 | 加州中区联邦法院 | 真实陪审团传票 | https://www.cacd.uscourts.gov/sites/default/files/documents/A1_2018%20Jury%20Summons%20-%20All%20Divisions.pdf |
| 法院 | 加州中区联邦法院 | 延期后的传票 | https://www.cacd.uscourts.gov/sites/default/files/documents/A2_2018%20Postponed%20Summons%20-%20All%20Divisions.pdf |
| 电费 | PG&E / RCEA | 住宅 TOU 样本账单 | https://redwoodenergy.org/wp-content/uploads/sites/850/2024/12/Understanding-Your-Bill-Residential-TOU.pdf |
| 电费 | SCE / Clean Power Alliance | 账单说明 | https://files.cleanpoweralliance.org/uploads/2024/10/UnderstandingBillFactSheet.pdf |
| 电费 | SCE / 3C Energy | 账单逐项说明 | https://3cenergy.org/wp-content/uploads/2023/07/3CE_UnderstandingYourBillFlyerSCE_v3-2.pdf |
| 地税 | 里弗赛德县税务局 | 担保地税单样本（网页） | https://countytreasurer.org/current-secured-tax-bill-sample |
| HOA | 加州民法 5660 条 | pre-lien 法定原文 | https://findhoalaw.com/pre-lien-intent-to-lien-letter/ |
| 红蓝卡 | ISMA | 季度 MSN 说明 | https://www.ismanet.org//pdf/MSNfact_sheet.pdf |
| 红蓝卡 | AgeOptions / SMP | 如何读懂 MSN | https://www.ageoptions.org/wp-content/uploads/2022/10/SMPHowToReadMSN.pdf |
| 社安局 | 费城社区法律服务 | SSA 多付追讨应对手册 | https://clsphila.org/wp-content/uploads/2019/11/SSA-Overpayment-Kit.pdf |

## 还没核对、建议补齐的

| 类别 | 建议来源 |
|---|---|
| 天然气 | SoCalGas「Understanding Your Bill」 |
| 水费 | 你所在城市的 water district 样本账单 |
| 车管所 | DMV 注册续期通知（登录后可下载自己的） |
| 退休金 | CalPERS Annual Member Statement 样本 |
| 银行 | 你自己的月结单（记得先涂掉个人信息） |
| 网络电信 | Xfinity / Spectrum 月账单 |

> 银行和电信这两类建议直接用你自己的真实账单测 —— 那才是最接近老人
> 手里那张纸的东西。测之前先确认 `.gitignore` 里没漏掉它们。
