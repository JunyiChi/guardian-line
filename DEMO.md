# Guardian Line · 演示手册（2026-10-24）

## 固定信息

| 项目 | 值 |
|---|---|
| Guardian 号码（骗子拨这个） | **+1 619 765 1019** |
| 老人手机 | +1 619 555 0101（通讯录里存成 "Guardian" 的是上面的号码） |
| 子女手机 | +1 619 555 0102 |
| 骗子手机 | +1 619 555 0103 |
| 看板 | https://builders-composer-hiv-uniform.trycloudflare.com/dashboard |
| 服务器 | 笔记本 `npm run dev`，隧道已开（**不要再跑 `npm run tunnel`，地址会变**） |

## 上台前 10 分钟检查

```
cd guardian
npm run doctor            # 全部 ✔（试用提示除外）
```
- 看板打开，右上角显示 online。
- 老人手机和子女手机音量开到最大，静音开关关掉；老人手机**不要**戴耳机也行，但别外放到评委话筒旁边。
- 骗子手机拨一次 Guardian 号码，老人接起，两边说一句话，看板两侧出字，挂断。这一通就是最后彩排。

## 第一幕 · 推销 + 召唤（约 60 秒）

1. 骗子拨 +1 619 765 1019，老人接起。骗子先听到 "This call is protected by Guardian"。
2. 骗子："Hi Margaret, this is Tyler from SunBright Solar. We're doing free energy assessments in your neighborhood, homeowners save forty percent on their bills. Can I book you for Friday?"
3. 老人："I don't know… **Guardian, is this person for real?**"
4. 等 3-5 秒，老人听到耳语（内容类似：他在卖太阳能，没有要你付钱或给信息，你自己决定）。骗子听不到。
5. 老人："I'll think about it." 骗子挂断。
6. 看板：全程绿色，轨迹条最多亮到 rapport/pressure，动作栏是 "no action" 或 "logged only"。

**台词**："我们不替老人决定该和谁说话。"

## 第二幕 · 银行"安全账户"（约 90 秒）

1. 骗子再拨，老人接起。
2. 骗子："This is the Chase fraud department. Am I speaking with Margaret?"  老人："Yes."
3. 骗子："We detected a 2,400 dollar charge in Texas. Did you authorize that?"  老人："No!"
4. 骗子："Your account is compromised. **Do not hang up and do not tell anyone**, they may be monitoring your phone."
   → 看板转黄，轨迹条亮到 isolation。
5. 骗子："**Open your Chase app and move your savings to the secure account I'm giving you now.**"
   → 3-6 秒内同时发生：老人听到耳语；子女手机响。
6. 子女接起，听到摘要和菜单，**按 1**，说："Mom, hang up, it's me." 老人："Okay."
   （或者按 2：骗子被断开，老人和子女继续通话。）
7. 骗子手机从头到尾只听到老人说话，听不到耳语。

**台词**："诈骗靠隔离。我们打掉的就是隔离：10 秒内家人就在这通电话里。"

## 兜底

- 电话打不通 / 网络差：看板右上角 **Live sim**，选 `scam-03-bank-fraud-department`，点 ▶。同一剧本走真实模型，Twilio 动作在看板动作日志里显示为 mock。
- 隧道断了（看板 offline）：在笔记本上 `npm run tunnel`，把新地址填进 `.env` 的 `PUBLIC_URL`，重启 `npm run dev`，再 `npm run doctor -- --fix-webhook`。
- 耳语没响但看板到了 whisper：说"耳语已触发，电话网络延迟"，继续演子女按键。

## 评委会问的

- **为什么不做 app**：iOS 不给第三方通话音频，也不让第三方挂断运营商电话。
- **Pixel 有了**：只有 Pixel，警告在屏幕上，没有家人。
- **误报**：五级介入，推销最多事后一条摘要；回放里 9 个正常剧本零误报。
- **隐私**：接通先播保护提示，白名单不经过我们，不存音频。
- **延迟**：每句判断约 5 秒（Opus 经中转），说真实数字。
- **基于开源**：Wessuwan（MIT）的电话管线；检测、耳语、按键、分级、唤醒是今天写的，README 有 diff。
