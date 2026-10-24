# Guardian Line · 项目 Proposal、架构与实施计划

> c0mpiled-16 · UC San Diego · 2026-10-24 · 赛道：No App + AI 消费品（10 亿人）
> 截止：18:30 提交，19:45 Top 5 demo。本文件是唯一的主文档，PLAN.md 和 ../ARCHITECTURE.md 为早期草稿。

---

## 一、Proposal

### 1. 一句话

**Guardian 是一个住在电话线里的家人。** 老人正常接每一通电话；骗局出现时它只对老人耳语；老人随时可以叫它；子女一个按键就能到场。没有 app，没有屏幕，没有新手机。

### 2. 问题

- 老人会接每一个电话。75 岁以上人群诈骗的第一渠道是电话；美国老年人每年因此损失超 30 亿美元，国内"冒充公检法""孙子出事"是小红书常年热帖。
- 子女在外地或国外，最怕的就是那一通电话，但现有手段全是手动的：拉黑、碎碎念、"转账前先问我"。
- 现有产品要么要换手机（Pixel），要么替老人接电话（Scammer Guardian），要么规则保密直接停机（国内运营商模型）。没有一个把"老人的自主权"和"家人在环"同时做对。

### 3. 洞察

1. **身份不可信，请求才可信。** 任何人都能自称银行、快递、公安。骗子最终一定要老人做某件事：转账、念验证码、买礼品卡、装软件。那件事才暴露他。
2. **诈骗有固定轨迹**：建立信任 → 施压 → 隔离 → 索取。看轨迹而不是看单句，才能在推销和诈骗之间划清界线。
3. **老人开始配合的那一秒是最强信号**，也是最该介入的一秒：他开始念卡号、说"我这就去银行"。现有产品只听骗子一方。
4. **诈骗依赖隔离。** 打掉隔离的方式不是替老人挂电话，而是让家人在 10 秒内出现在那通电话里。

### 4. 产品：三个交互，都在一通已经存在的电话里

| 谁对谁 | 交互 | 用户的动作 |
|---|---|---|
| Guardian → 老人 | 只有老人听得到的耳语："妈，这个电话是骗子，先挂掉，小芳马上打给你。" | 无，被动保护 |
| 老人 → Guardian | 通话中说一句"Guardian，这个人靠谱吗"，耳语回当前判断 | 说话 |
| 子女 → Guardian | 接到电话："妈妈可能正在被骗，按 1 加入通话，按 2 结束对方。" | 按一个键 |

三条设计原则：**不做门卫**（老人有权和推销员聊半小时，系统默认沉默）；**身份不可信，请求才可信**；**分级介入，家人设定**（五级，介入强度由子女决定）。

### 5. 与已有方案的差异

| 方案 | 短板 | Guardian |
|---|---|---|
| Google Pixel Scam Detection | 只有 Pixel；警告在屏幕上而老人手机贴耳朵；无家人 | 任何手机；耳语；家人 10 秒到场 |
| iOS 26 Call Screening | 只在接听前问来意，不分析内容 | 通话中持续 |
| Scammer Guardian（创业公司） | AI 代接所有陌生来电，老人失去自主权，要装 app | 老人自己接，零安装 |
| scam-shield（c0mpiled-15 冠军） | 笔记本麦克风听外放，没有电话，家人提醒在 roadmap | 真实电话线、真实耳语、真实按键 |
| Wessuwan（MIT 基线） | 只分析来电方；警告会把骗子挂断；无老人侧交互 | 双方分析；会议室耳语不断线；老人可召唤 |
| 国内反诈模型 | 规则保密、直接停机、家属不知情 | 分级、可解释、家人在环 |

### 6. 赛道契合

- **No App**：用户是老人；通道是电话线、语音和按键；老人和子女都不打开任何 app。看板只是演示和运维用。
- **AI 消费品（10 亿人）**：每个国家的老人都有手机、都有子女；付费方是子女；运营商和银行是渠道；99% 的时间不可见，只在危险那一刻以声音浮现，这正是 ambient 的定义。

### 7. 诚实声明

基于 MIT 开源项目 Wessuwan（upstream commit `be8b4b0`）的 Twilio 管线、Deepgram 双轨转写、看板骨架和短信通道。本次新写：轨迹检测与双方分析、家庭上下文、会议室耳语、唤醒召唤、子女按键加入、五级介入、真实模型演示模式。`git log upstream/main..guardian` 可见全部改动。

---

## 二、架构

### 1. 系统图

```
陌生来电 ──(运营商无条件呼叫转移)──▶ Twilio 号码 ──▶ POST /twilio/voice
   白名单：<Dial callerId=原号码><Number>老人</Number></Dial>   直通，不转写
   其他：  <Say>一句保护提示</Say>
           <Start><Stream track="both_tracks" url="wss://…/media"/></Start>
           <Dial><Conference beep="false" waitUrl="" endConferenceOnExit="true">guard-{CallSid}</Conference></Dial>
           同时 REST Calls.create(To=老人, From=Twilio 号码, Url=/twilio/join?conf=guard-{CallSid}, StatusCallback=/twilio/join-status)
                                   │
   Media Stream：inbound 轨 = 来电方，outbound 轨 = 会议混音 = 老人
                                   │
   Deepgram ×2（每说话人一路，nova-3，endpointing 600ms） ──▶ transcript-update(speaker, text, isFinal, endOfSpeech)
                                   │
   ┌─ 任一方句末 ─▶ detector：正则快速通道(验证码/礼品卡，<1ms) → haiku 打分 → ≥40 时 opus 复核
   │                 输入：家庭上下文 + 上次评估 + 最近 2 分钟转写
   │                 输出：risk, stage, category, requestsOfSenior, evidence, seniorSignals, action, summaryForChild, whisperText
   │                 规则层：索取阶段 ≥85；benign ≤70；动作 = 风险带，受家庭 maxIntervention 封顶；通话内只升不降
   │
   ├─ 老人句子含唤醒词("guardian" / "守护") ─▶ guardian:ask ─▶ 立即耳语当前判断
   │
   └─ policy（alerts）按 action：
        log                       看板
        notify_child_after_call   call:ended 时子女摘要短信
        notify_child_now          子女短信 + 子女来电（Gather：1 加入 / 2 结束对方）
        whisper_senior            以上 + 老人横幅短信 + Conference Participant AnnounceUrl 只对老人播 <Say whisperText>
        可选（家庭设置）           踢出来电方（Participant DELETE）
                                   │
   看板 /dashboard（Socket.IO）：实时转写、风险曲线、阶段、对方要老人做什么、动作日志
   演示 /demo/live?script=…：SIM- 通话走真实模型，Twilio mock（兜底 + 测试入口）
```

### 2. 关键决策与理由

| 决策 | 理由 | 代价 / 备选 |
|---|---|---|
| 会议室而不是直连桥 | Twilio 只能对会议参与者单独播音频，这是"骗子听不到的耳语"的唯一正路 | REST 外呼 `From` 必须是 Twilio 号码，老人手机显示的不是原始来电号码。演示时把该号码存为"Guardian"；产品层由运营商透传。备选：直连桥 + 耳语时重新入会，骗子那边 1-2 秒静音 |
| 呼叫转移必须是无条件 | "无人接听时转移"只拦到没接的电话，我们要听的是接起来的 | 家人来电也经过服务器，靠白名单直通不转写 |
| 两层模型 haiku → opus | 逐句打分要快；最终动作和耳语文本要准 | opus 实测 >3s 退回 sonnet |
| 老人的句子也触发检查 | 念卡号、"我这就去银行"是最强信号，Wessuwan 和 lilyServes 都没做 | 检查次数翻倍，用"一次只跑一个、新句合并"兜住 |
| 85 分以上不平滑 | 耳语必须落在索取那句话上，EWMA 会晚一句 | 85 以下仍平滑，防单句误报 |
| 动作只升不降、每级只触发一次 | 防震荡，防骚扰家人 | 通话结束后状态清零 |
| 不存音频，转写只在内存 | 加州双方同意；信任 | 复盘靠一行摘要 |

### 3. 模块与文件

| 模块 | 文件 | 状态 |
|---|---|---|
| Twilio 接入、会议室、加入、状态回调、耳语 TwiML、子女 Gather | `src/call/index.ts` | 阶段 1 待做 |
| Twilio REST：参与者查找、announce、kick、外呼子女、短信 | `src/call/twilio.ts` | 阶段 1/3 待做 |
| 转写 | `src/stt/deepgram.ts` | 沿用 |
| 检测器 prompt / schema / 规则层 / 双方触发 | `src/detector/prompt.ts`、`src/detector/index.ts` | **已完成** |
| 家庭上下文 | `src/config/family.ts`、`family.json` | **已完成** |
| 事件类型（guardian 字段） | `src/events.ts` | **已完成** |
| 唤醒词 | `src/detector/index.ts`（protected 句末匹配） + `src/alerts/index.ts` | 阶段 3 待做 |
| 五级介入 | `src/alerts/index.ts` | 阶段 3 待做 |
| 看板阶段条 | `public/dashboard.html` | 阶段 4 待做 |
| 真实演示模式 | `src/dashboard/demo.ts` `/demo/live` | **已完成** |
| 测试剧本 + checkpoint 回放 | `data/test-scripts/`、`scripts/test-detector.ts` | **已完成**，待跑 |

### 4. 检测器（已实现）要点

- 阶段 none / rapport / pressure / isolation / extraction；类别 11 种；硬规则 6 条；老人侧信号；家庭上下文反向核验（"孙子出车祸"但孙子 12 岁 → 可信度降；"顺丰到件"而家里在等顺丰 → 升）。
- 校准：0-20 none；21-45 log；46-70 after_call；71-84 now；85-100 whisper。规则层强制：scam + extraction ≥ 85；模型给的 action 作为硬规则信号抬底；benign 类别封顶 70。
- 旧字段映射（scamType / signals / impersonating）让 Wessuwan 的看板、短信文案、历史记录零改动可用。
- 延迟预算：Deepgram 断句 0.6s + haiku ≈ 1s +（≥40 时）opus ≈ 2s + announce 0.5s ≈ 4s 以内。排练时记录实测值。

---

## 三、实施计划（15:00 → 18:30）

### 阶段 0 · 账号（15:00-15:15，A）

- Twilio：升级付费（试用账号外呼会先播"trial account"，毁掉 demo）；买一个本地号码；把三部演示手机加为 verified caller ID；号码的 Voice webhook 指到 `PUBLIC_URL/twilio/voice`。
- Deepgram key、Anthropic key、`ngrok http 3000`，全部填进 `.env`（已预填其余项）。
- 验收：`npm run dev` 启动日志无 error；`curl $PUBLIC_URL/health` 通。

### 阶段 1 · 会议室桥接（15:15-15:45，A）

`src/call/index.ts`：
1. `/twilio/voice` 非白名单分支改为：`<Say>` → `<Start><Stream>` → `<Dial><Conference beep="false" waitUrl="" startConferenceOnEnter="true" endConferenceOnExit="true">guard-{CallSid}</Conference></Dial>`；同时 `twilio('POST','/Calls.json',{To:老人, From:Twilio号码, Url:PUBLIC_URL/twilio/join?conf=…, StatusCallback:PUBLIC_URL/twilio/join-status?caller=CallSid, StatusCallbackEvent:'completed'})`。
2. 新路由 `/twilio/join`：`<Response><Dial><Conference endConferenceOnExit="true" beep="false">{conf}</Conference></Dial></Response>`。
3. 新路由 `/twilio/join-status`：外呼 `no-answer / busy / failed` 时把来电者通话 `Status=completed`。
4. 记录 `conf → {callerCallSid, seniorCallSid}` 映射（内存 Map），供耳语和踢人用。

`src/call/twilio.ts`：
5. `conferenceSid(name)`：`GET /Conferences.json?FriendlyName=…&Status=in-progress`。
6. `announce(confSid, participantCallSid, url)`：`POST /Conferences/{sid}/Participants/{callSid}.json` `AnnounceUrl=url`。
7. `kick(confSid, callSid)`：`DELETE …/Participants/{callSid}.json`。

验收（必须真机）：两部手机经会议室互通；看板两侧都出字（证明 outbound 轨 = 老人）；对老人 announce 一段 `<Say>`，骗子手机听不到。

### 阶段 2 · 检测器（已完成；15:15-15:45 调参，B）

- 填 key 后跑 `npm run test:detector -- --detector=llm --provider=anthropic`，22 个剧本。
- 目标：11+3 个 scam 全部 warn；7 个 normal 零误报；假快递前 4 句 ≤45、孙子保释第 2 句 ≤60 不触发 EARLY；验证码剧本 warn 在老人回答之前。
- 不达标只改 `BASE_PROMPT` 的校准段和硬规则段，不动代码。
- 记录平均响应时间；precise >3s 则 `.env` 改 `PRECISE_MODEL=claude-sonnet-5-5`。

### 阶段 3 · 五级介入、耳语、唤醒、子女按键（15:45-16:30，A + B）

`src/alerts/index.ts` 重写核心：
1. 订阅 `risk-update`，读 `guardian.action`；每通电话记录已执行的最高等级，只升不降，每级只做一次。
2. `notify_child_after_call`：存 `summaryForChild`，`call:ended` 时 `sendMessage(family)`。
3. `notify_child_now`：`sendMessage(family, summary)` + `Calls.create(To=子女, Url=/twilio/family-call?conf=…)`。
4. `whisper_senior`：以上 + `sendMessage(老人, "⚠️ Guardian: this call may be a scam. Do not share codes or send money. {childName} is being notified.")` + `announce(老人, /twilio/whisper?text=…)`；家庭 `allowKick` 时 `kick(来电方)`。

`src/call/index.ts` 新路由：
5. `/twilio/whisper?text=…`：`<Response><Say language="en-US" voice="Polly.Joanna-Neural">{text}</Say></Response>`（中文 `cmn-CN` / `Polly.Zhiyu-Neural`）。
6. `/twilio/family-call?conf=…`：`<Gather numDigits="1" action="/twilio/family-choice?conf=…"><Say>{summary}. Press 1 to join the call. Press 2 to end the caller.</Say></Gather>`。
7. `/twilio/family-choice`：`Digits=1` → `<Dial><Conference>{conf}</Conference></Dial>`；`Digits=2` → `kick(来电方)` + `<Say>Done. Mom is still on the line with you.</Say><Dial><Conference>…`。

唤醒词（`src/detector/index.ts` + alerts）：
8. protected 的 final 句匹配 `/\b(guardian|gardian|小卫|守护)\b/i` → `bus.emit('guardian:ask')`，10 秒内只响应一次。
9. alerts 收到后：有上次评估 → 耳语 `reason`（benign 时："他在卖太阳能，没有要你付钱或给信息，你自己决定。"）；没有 → "我还没听到问题，继续聊，我在。"

验收（真机）：银行剧本到"点转账"时，子女手机响并播摘要、按 1 进入通话；老人手机收到横幅短信并听到耳语；骗子手机全程只听到老人。推销剧本全程无动作；老人说"Guardian"得到一句回答。

### 阶段 4 · 看板与演示模式（16:30-16:50，C；可与阶段 3 并行）

- `public/dashboard.html`：在风险条下方加"阶段条"（none → rapport → pressure → isolation → extraction 五格点亮）和"对方要老人做什么"一行，数据来自 `risk-update.guardian`。
- `/demo/live` 在看板加一个按钮，选剧本即跑真实模型。排练和兜底都用它。

### 阶段 5 · 排练（16:50-17:30，全员）

- 评委剧本 ×3：推销（含一次召唤）、银行安全账户（含子女按 1）、假快递收关税。
- 队友即兴攻击 ×2（假物业、假孙子）。
- 盲测 3 个没调过的剧本跑回放。
- 记录：误报 0 次、耳语延迟 x.x 秒、子女来电延迟 x.x 秒。这些数字进 pitch。

### 阶段 6 · 提交（17:30-18:10，C）

- README：一句话、三个交互、声明基线与改动清单、运行方式、测试结果表。
- Pitch 两页：定位与三个交互 / 差异化表与数字。
- 备用视频：手机录一遍完整 demo。
- 18:10-18:30 缓冲。

### 人少的裁法

一人：按 0 → 1 → 3（只做耳语 + 子女短信 + 子女来电按 1，砍掉 kick 和唤醒）→ 5 → 6；检测器只跑一次回放不调参。两人：A 做 0/1/3，B 做 2/唤醒/4/6。

---

## 四、Demo 脚本与评委应对

### Demo（3 分钟）

舞台四样东西：评委的手机（来电方）、扮奶奶的 iPhone（QuickTime 镜像到大屏）、你的手机（子女）、看板。

1. **推销**（45 秒）：评委扮太阳能推销员，奶奶正常聊，看板全绿。奶奶问"Guardian，这个人靠谱吗"，耳语："他在卖太阳能，没有要你付钱或给信息，你自己决定。" 一句话：我们不替老人决定该和谁说话。
2. **诈骗**（90 秒）：评委扮银行安全账户。曲线在"账户被盗"抬头、"别告诉任何人"变黄；"打开 app 点转账"那一秒：子女手机响并播摘要，你按 1 说"妈，挂了"；奶奶 iPhone 顶部弹横幅；奶奶听到耳语；骗子手机从头到尾只听到奶奶。
3. **收尾**（30 秒）：零安装、任何手机、三个交互都在电话线里。下一步：众包校正、运营商渠道。

兜底：Twilio 出问题 → `/demo/live` 回放同一剧本，看板和短信照常；网络全挂 → 备用视频。

### 评委会怎么打

- **"这不就是检测加了个语音？"** 检测是脑子，产品是三个人之间的交互。Pixel 的检测两年前就有，它的产品是屏幕红字，老人贴耳朵看不见，也没有家人。
- **"老人喊 Guardian 骗子也听见了。"** 对，这是威慑；真客服不介意。耳语他听不到，家人的电话他拦不住。老人不喊也行，索取那一刻系统自己会开口。
- **"老人会记得叫它吗？"** 不需要。召唤是可选的，自动耳语是兜底，产品假设老人一次都不叫。
- **"骗子说'那声音是骗人的'。"** 耳语后 10 秒内子女的电话就到了，骗子要同时对抗系统和真人。诈骗靠隔离，我们打掉的就是隔离。
- **"误报？子女按 2 把真客服挂了？"** 五级介入，推销最多是通话后一条摘要；只有索取阶段或硬规则才打给子女；按 2 是人做的决定。测试集推销和真快递全绿，数字当场报。
- **"隐私，加州双方同意。"** 接通前一句提示、老人事先同意、白名单不经过我们、不存音频、转写只在内存。
- **"为什么不做 app？"** iOS 不给第三方通话音频，也不让第三方挂断运营商电话。app 只剩弹窗，和一条短信一样，却多了安装门槛。
- **"显示的是你们的号码。"** Twilio 沙箱限制，运营商级可透传；演示里存成"Guardian"，老人反而知道这通电话受保护。诚实说这是今天的权衡。
- **"两周前冠军 / fork。"** 主动先说，README 有声明和 diff。它没有电话、没有家人、没有老人侧交互。
- **"延迟？"** 报实测数字。
- **"10 亿人？商业？"** 子女付费，每月一杯咖啡；运营商和银行是渠道，英国运营商已自己做 AI 防诈。

### 措辞纪律

不说"监听、监控"，说"陪着听、在线上"；不说"拦截"，说"耳语"；不说"AI 判断"，说"它注意到"。决定权永远在老人和家人手里。

---

## 五、风险与备选

| 风险 | 概率 | 备选 |
|---|---|---|
| 会议模式下 outbound 轨不是老人声音 | 低 | 改用 Media Stream 挂在老人那条腿上（`/twilio/join` 里 `<Start><Stream>`） |
| `AnnounceUrl` 行为不符预期 | 低中 | 老人那条腿 redirect 到 `<Say>耳语</Say><Dial><Conference>同名`，骗子侧 1-2 秒静音 |
| Twilio 试用前置语音 | 高 | 开场升级付费 |
| opus 延迟 >3s | 中 | `PRECISE_MODEL=claude-sonnet-5-5` |
| 唤醒词被转写成别的词 | 中 | 正则放宽（guardian / gardian / guard）；演示里奶奶说清楚 |
| 评委即兴剧本绕过 | 中 | 看请求不看身份的设计正为此；排练时让队友即兴攻击 |
| 现场网络 | 中 | 手机热点；`/demo/live`；备用视频 |
| ngrok 重启 URL 变 | 高 | `.env` 和 Twilio 控制台一起改，写进排练清单 |
