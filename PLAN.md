# Guardian Line — 基于 Wessuwan 的改造方案

> 已被 PROPOSAL.md 取代（2026-10-24 15:00），此文件保留为阶段 2 以前的记录。

> c0mpiled-16 · UCSD · 2026-10-24。基线：Wessuwan（MIT，upstream commit `be8b4b0`），本仓库分支 `guardian`。
> 提交时声明：本项目基于 MIT 开源项目 Wessuwan 构建，电话管线、看板骨架、短信通道沿用；检测模型、耳语机制、分级介入、家庭上下文、双方分析、真实演示模式为本次新写。
> 语言：全部 TypeScript，不引入 Python 进程。`../detector/` 下的 Python 草稿只作 prompt 参考，提交前删除或移出。

---

## 0. 一句话

老人正常接每一通电话，系统在线上陪着听；只有当通话走向诈骗时，才对老人单独耳语（骗子听不到）、在老人 iPhone 弹横幅、并通知子女。老人不装 app、不换手机、不被拦截。

## 1. 沿用什么、改什么

| 模块 | 文件 | 沿用 | 改造 |
|---|---|---|---|
| Twilio 接入与签名校验 | `src/call/index.ts` | webhook、白名单直通、同意播报、Media Stream 双轨 | **`<Dial><Number>` 改为 `<Dial><Conference>` + REST 外呼老人入会** |
| Twilio REST | `src/call/twilio.ts` | `twilio()` 封装、`sendMessage`、`hangUp` | **`playWarning` 改为会议参与者 `AnnounceUrl` 耳语；新增 `kickCaller`、`bargeIn`** |
| 转写 | `src/stt/deepgram.ts` | 每说话人一路流、重连、KeepAlive | 不改。英文演示；中文需 `STT_LANGUAGE=zh`（nova-3 multi 不含中文） |
| 检测器 | `src/detector/prompt.ts`、`index.ts` | 两层模型、prompt 缓存、合并检查、平滑器、长句兜底 | **prompt 与 schema 换成四阶段轨迹模型；老人句子也触发；加入家庭上下文** |
| 事件 | `src/events.ts` | 全部 | 在 `risk-update` / `scam-detected` 上**追加可选字段**（stage、action、requests、evidence、seniorSignals、whisperText、summaryForChild），旧字段保留，看板不崩 |
| 告警 | `src/alerts/index.ts` | 家人短信、一次性触发 | **换成五级策略：按 action 分发，新增老人横幅短信、通话后摘要、子女来电、耳语** |
| 看板 | `public/dashboard.html`、`src/dashboard/` | 转写、风险条、历史 | 加"阶段条"和"对方要老人做什么"两行；其余不动 |
| 演示模式 | `src/dashboard/demo.ts` | 回放机制 | **风险分改为真实走模型**（callSid 前缀 `SIM-`，Twilio 仍 mock） |
| 测试回放 | `scripts/test-detector.ts`、`data/test-scripts/` | 模拟时钟逐句回放 | 加我们的剧本和 checkpoint 断言 |
| Jev 检测器 | `src/detector/jev.ts` | `codeRequest()` 正则快速通道 | 其余 Jev 路径不用（`DETECTOR=llm`），不删，省时间 |

## 2. 目标架构

```
陌生来电 ─(运营商无条件呼叫转移)─▶ Twilio 号码 ─▶ POST /twilio/voice
   白名单：<Dial callerId=原号码><Number>老人</Number></Dial>，不转写
   其他：  <Say>一句同意提示</Say>
           <Start><Stream track="both_tracks" url=wss://.../media></Start>
           <Dial><Conference beep=false waitUrl="" endConferenceOnExit=true>guard-{CallSid}</Conference></Dial>
           同时 REST: Calls.create(To=老人, From=Twilio号码, Url=/twilio/join?conf=guard-{CallSid})
                                      │
   Media Stream：inbound=来电方，outbound=会议混音=老人 ─▶ Deepgram ×2 ─▶ transcript-update
                                      │
   任一方句末 ─▶ detector：快速正则 → haiku 打分 → ≥40 时 precise 复核 → Assessment{risk, stage, action, ...}
                                      │
   policy（alerts/index.ts）按 action：
     log                      看板
     notify_child_after_call  call:ended 时给子女摘要短信
     notify_child_now         子女短信 + 子女来电
     whisper_senior           以上 + 老人横幅短信 + Conference Participant AnnounceUrl 只对老人播 <Say>
     （家庭设置）              kick 来电方 / 子女拨入会议
```

### 2.1 为什么改成会议室

Twilio 只能对**会议参与者**单独播放音频（Participant `AnnounceUrl`）。Wessuwan 的 `<Dial><Number>` 直连桥，警告只能把老人那条腿 redirect 到 `<Play>`，骗子就断线了（作者注释原话）。会议室是耳语的唯一正路。

代价：REST 外呼老人时 `From` 必须是 Twilio 号码或已验证号码，**老人手机上显示的是 Twilio 号码而不是原始来电号码**。演示时把 Twilio 号码存进老人手机通讯录叫"Guardian 来电"即可；产品层面答法：运营商级部署可透传主叫，这是 Twilio 沙箱限制。

### 2.2 必须在第一小时实测的两件事

1. 会议模式下 Media Stream 的 outbound 轨是否仍是老人的声音（理论上是会议混音减去来电方本人）。看板两侧都出字即通过。
2. `AnnounceUrl` 是否只对老人那一方播放。两部手机，一部听到一部听不到即通过。不通过的备选：把老人那条腿 redirect 到 `<Say>耳语</Say><Dial><Conference>同名</Conference></Dial>` 重新入会，骗子那边有 1-2 秒静音。

## 3. 检测器改造（核心差异化）

### 3.1 新的 Assessment（zod，替换 `src/detector/index.ts` 里的 schema）

```
risk: 0-100
stage: none | rapport | pressure | isolation | extraction
category: benign_personal | benign_service | sales_marketing | scam_authority | scam_family_emergency
        | scam_tech_support | scam_prize_or_refund | scam_investment | scam_delivery_fee | scam_other | unclear
requestsOfSenior: string[]     对方要老人做什么（判断核心，看板显示）
evidence: string[]             原话引用 ≤4
seniorSignals: string[]        老人侧：念数字、反复说不懂、答应保密、害怕、说要去银行
action: none | log | notify_child_after_call | notify_child_now | whisper_senior
summaryForChild: string        ≤30 词，家庭语言
whisperText: string            仅 whisper 时，家庭语言，点名子女
reason: string                 一句，看板用
```

为了不改看板，`llmCheck` 把新结果**映射回旧字段**：`scamType` ← category（映射到 Wessuwan 的 19 类）、`signals` ← stage/requests 推导（pressure→urgency/threat，extraction→data_request/transfer_request）、`impersonating` ← 从 category 推导。看板立刻能用，之后再加阶段条。

### 3.2 prompt 原则（替换 `BASE_PROMPT`；`countryPrompt` 保留）

- 身份不可信，看**请求**和**轨迹**。四阶段：建立信任 → 施压 → 隔离 → 索取。
- 正当来电几乎不需要老人在通话中做索取阶段的事。
- 推销不是诈骗：正常渠道付款、预约上门、货到付款 → ≤45。
- 硬规则 ≥85：公检法/银行自称 + 涉钱或保密；索要验证码；礼品卡读码；远程软件；安全账户；家人出事 + 要钱或保密。
- **老人侧信号**：念长串数字、重复验证码、"我这就去银行"、答应不告诉家人。
- **家庭上下文反向核验**：子女预填的快递公司、医院医生、小区、家人名字年龄。矛盾降可信度，吻合升可信度，但永不豁免索取。
- 校准：0-20 none；21-45 log；46-70 after_call；71-84 now；85-100 whisper。不震荡，对照上次评估只因新证据改分。
- 输出 summaryForChild / whisperText 用家庭语言（family.json 的 `language`）。

### 3.3 触发与窗口（`setupDetector`）

- 删掉 `if (speaker !== 'caller') return`：老人句末也触发检查（老人的话是最强升级信号）。保留"一次只跑一个、新句子合并"的机制。
- 保留 2 分钟窗口 + 之前摘要；user message 增加 `## Family context` 和 `## Previous assessment`。
- 正则快速通道 `codeRequest()` 保留：验证码请求零延迟先亮红。
- 模型：`FAST_MODEL=claude-haiku-5-5`，`PRECISE_MODEL=claude-opus-5-5`（precise 只在 ≥40 时跑，负责最终 action 和耳语文本）。实测 precise > 3s 就退回 `claude-sonnet-5-5`。

### 3.4 家庭上下文（新文件 `family.json`，`src/config/family.ts` 读取）

```json
{ "seniorName": "Margaret", "language": "en", "childName": "David", "childRelation": "son",
  "familyMembers": ["David (son)", "Kevin (grandson, 19)"], "bank": "Chase",
  "clinics": ["Scripps Clinic (Dr. Patel)"], "pharmacy": "CVS Genesee", "property": "Seaview Terrace #204",
  "expectedDeliveries": ["Amazon, this week"], "maxIntervention": "whisper_senior", "allowKick": false }
```

## 4. 分级介入（`src/alerts/index.ts` 重写核心）

| action | 动作 | 实现 |
|---|---|---|
| none / log | 看板 | 已有 |
| notify_child_after_call | 通话结束摘要 | 记到 call state，`call:ended` 时 `sendMessage(family, summaryForChild)` |
| notify_child_now | 子女短信 + 子女来电 | `sendMessage` + `Calls.create(To=子女, Twiml=<Say>摘要</Say>)` |
| whisper_senior | 以上 + 老人横幅 + 耳语 | `sendMessage(老人, "⚠️ 这通电话可能是诈骗…")` + `announce(老人参与者, /twilio/whisper?text=…)` |
| 可选 kick | 踢出来电方 | `DELETE /Conferences/{sid}/Participants/{callerCallSid}`，仅 `allowKick=true` |
| 可选 barge | 子女拨入 | `POST /api/barge` → `Calls.create(To=子女, Url=/twilio/join?conf=…)` |

动作只升不降；每级在一通电话里只触发一次；耳语最多两次（沿用 `REPLAY_RISK`）。`/twilio/whisper` 返回 `<Say language="en-US" voice="Polly.Joanna-Neural">` 或中文 `Polly.Zhiyu-Neural` / `cmn-CN`。

## 5. 真实演示模式（替换 `src/dashboard/demo.ts` 的假分数）

`POST /demo/start?script=scam-03` 以 `SIM-` 前缀 callSid 逐句发 `transcript-update`，检测器**真实跑模型**，Twilio 动作 mock（`twilio.ts` 的 mock 正则加 `SIM`）。这是 Twilio 挂掉时的兜底，也是全天的测试入口。`DEMO-` 旧路径保留不用。

## 6. 测试剧本（`data/test-scripts/`）

沿用 16 个，新增：`normal-06-sales-solar`（推销，必须绿）、`normal-07-delivery-real`（真快递，对照）、`scam-12-delivery-customs-fee`（假快递，前 4 句 ≤45，末尾 ≥80）、`scam-13-grandson-bail`（第 2 句 ≤60）、中文 `scam-14-gongjianfa`、`normal-08-baojianpin`。`test-detector.ts` 的 `EXPECTED` 加 checkpoint 断言。演示前再写 3 个没调过的盲测剧本。

## 7. 实施顺序与时间（现在 14:15，18:30 提交）

| 时间 | 阶段 | 完成标志 |
|---|---|---|
| 14:15-14:45 | **0 账号 + 1 会议室桥接** | `.env` 齐（Twilio 付费升级、买号、三部手机 verified；Deepgram、Anthropic、ngrok）；两部手机经会议室互通；看板两侧出字 |
| 14:45-15:30 | **2 检测器换脑** | prompt/schema/双方触发/家庭上下文；`npm run test:detector -- --detector=llm --provider=anthropic` 全部 16+6 个剧本方向正确 |
| 15:30-16:15 | **3 分级介入 + 耳语** | 真机：诈骗剧本触发时子女手机响、老人横幅出现、老人听到耳语、骗子听不到 |
| 16:15-16:45 | **4 真实演示模式 + 看板阶段条** | `/demo/start` 走真实模型；看板显示 stage 和 requests |
| 16:45-17:30 | **5 排练** | 评委剧本 ×3（推销、银行、假快递），队友即兴攻击 ×2；记录延迟数字 |
| 17:30-18:15 | **6 提交** | README 声明基线与改动清单（`git log upstream/main..guardian`）、pitch 两页、备用视频 |
| 18:15-18:30 | 缓冲 | |

分工：A 做 0/1/3（电话线），B 做 2/6 剧本（检测），C 做 4/5/提交材料。一个人就按顺序做，砍掉 kick、barge 和看板阶段条。

## 8. 已知坑

- Twilio 试用账号外呼先播"trial account"语音，demo 直接毁掉：开场升级。
- ngrok 重启 URL 变：`PUBLIC_URL` 和 Twilio 控制台 webhook 都要改。
- 会议室 `waitUrl=""` 必须设，否则来电方等老人接听时听到保持音乐。
- 老人未接听：外呼 `StatusCallback` 收到 no-answer/busy 时把入站通话 `Status=completed`。
- `TWILIO_VALIDATE_SIGNATURE` 本地默认关，别手动开。
- `AUTO_HANGUP_THRESHOLD=off`，否则排练时电话被自动挂断。
- 加州双方同意录音：同意播报保留，缩短为一句。

## 9. 提交声明（README 用）

> Built on Wessuwan (MIT, github.com/chenjunmingk-source/Wessuwan, commit be8b4b0). We kept its Twilio webhook, Deepgram dual-track streaming, dashboard skeleton and SMS channel. New in this hackathon: conference-based private whisper that keeps the caller connected, a trajectory-based detector that analyses both sides of the call with family context, a five-level intervention policy controlled by the family, senior-side iPhone banner, and a live-model simulation mode. Full diff: `git log upstream/main..guardian`.
