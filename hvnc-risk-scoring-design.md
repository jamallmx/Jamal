# نظام Risk Scoring للكشف عن الـ HVNC — وثيقة تصميم

> نظام دفاعي لرصد جلسات التحكم عن بُعد المخفي (Hidden VNC) في بوابات الدفع والمواقع الحسّاسة.
> البيئة التقنية: **Node.js / TypeScript** (جامع بيانات في المتصفح + محرك تسجيل في الخادم).

---

## 1. نظرة عامة

الـ HVNC (Hidden VNC) تقنية يستخدمها المحتالون لإنشاء **سطح مكتب معزول (hidden desktop)** على جهاز الضحية والتحكم به دون أن يراه المستخدم. الهدف من هذا النظام هو إسناد **درجة خطر (risk score)** لكل جلسة دفع/تسجيل دخول، بناءً على إشارات تكشف أن الجلسة تجري داخل بيئة معزولة أو تحت تحكم آلي/عن بُعد.

**المبدأ الأساسي:** لا نعتمد على إشارة واحدة. نجمع عشرات الإشارات الضعيفة في **درجة مجمّعة** قابلة للتفسير، ثم نتخذ قراراً متدرّجاً (allow / step-up / deny).

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Client Collector │ ──▶ │  Scoring Engine   │ ──▶ │  Decision Layer   │
│  (browser, TS)    │ sig │  (Node/TS server) │ risk│  allow/step-up/deny│
└──────────────────┘     └──────────────────┘     └──────────────────┘
          │                        │                        │
          │                        ▼                        ▼
          │                 ┌─────────────┐          ┌─────────────┐
          └────────────────▶│  Event Log  │          │  3DS2 / OTP │
            (signed payload) │  + Feedback │          │  step-up    │
                             └─────────────┘          └─────────────┘
```

---

## 2. الإشارات (Signals)

مقسّمة لثلاث فئات حسب القوة التمييزية للـ HVNC. كل إشارة لها: المعرّف، مصدر الجمع، القيمة المتوقعة الطبيعية، ودلالة الشذوذ.

### 2.1 فئة A — إشارات بيئة العرض (الأقوى للـ HVNC)

السطح المخفي لا يملك GPU حقيقياً ولا إعدادات عرض طبيعية.

| المعرّف | المصدر | طبيعي | شاذ (HVNC) |
|--------|--------|-------|-----------|
| `webgl_renderer` | `WEBGL_debug_renderer_info` | اسم GPU حقيقي (NVIDIA/Intel/Apple) | `SwiftShader`, `llvmpipe`, `Google SwiftShader`, فارغ |
| `webgl_vendor` | WebGL | مورّد حقيقي | `Google Inc.` مع software renderer |
| `canvas_entropy` | hash لرسم Canvas | بصمة فريدة ثابتة | فارغة/موحّدة/كل البكسلات متطابقة |
| `screen_resolution` | `screen.width/height` | دقة قياسية (1920×1080…) | 0، أو أبعاد غريبة جداً، أو أصغر من `window` |
| `color_depth` | `screen.colorDepth` | 24/30 | 16 أو أقل، أو 0 |
| `device_pixel_ratio` | `window.devicePixelRatio` | 1 / 1.25 / 2 … | قيمة لا تتسق مع الدقة |
| `hardware_concurrency` | `navigator.hardwareConcurrency` | 4–16 عادةً | 1 مع مؤشرات أخرى |
| `gpu_tier` | قياس أداء رسم بسيط | أداء GPU حقيقي | بطء يوافق render برمجي |

> **ملاحظة:** وجود software renderer وحده ليس إداناً (بعض الأجهزة الافتراضية والمستخدمين الشرعيين). لكنه رافعة قوية عند اجتماعه مع إشارات أخرى.

### 2.2 فئة B — إشارات السلوك والإدخال

التحكم عن بُعد/الآلي يترك أثراً في نمط الإدخال.

| المعرّف | المصدر | طبيعي | شاذ |
|--------|--------|-------|-----|
| `mouse_entropy` | تتبّع مسار الماوس | منحنيات بشرية، تسارع/تباطؤ | خطوط مستقيمة، قفزات لحظية، غياب حركة |
| `mouse_before_click` | عدد أحداث الحركة قبل أول نقرة | > 0 بوضوح | 0 (النقر بلا حركة) |
| `keystroke_dynamics` | فروق التوقيت بين ضغطات المفاتيح | تباين بشري | ثابت جداً أو لصق فوري |
| `paste_card_full` | حدث `paste` في حقل البطاقة | نادر/جزئي | لصق رقم بطاقة كامل دفعة واحدة |
| `input_velocity` | زمن ملء النموذج | ثوانٍ معقولة | أسرع من أي إنسان |
| `focus_blur_pattern` | أحداث `focus`/`blur`/`visibilitychange` | متسقة مع النشاط | نشاط بينما النافذة «مخفية» |
| `event_latency_jitter` | تذبذب زمن وصول الأحداث | منخفض ومتسق | عالٍ/متقطّع (وسيط تحكم عن بُعد) |

### 2.3 فئة C — إشارات بيئة التشغيل والشبكة

| المعرّف | المصدر | شاذ |
|--------|--------|-----|
| `automation_flags` | `navigator.webdriver`, خصائص headless | `webdriver=true`، آثار Puppeteer/Selenium |
| `ua_consistency` | مطابقة User-Agent مع الخصائص الفعلية | UA يقول Windows والبصمة لا تطابق |
| `timezone_mismatch` | `Intl` vs IP geo | فرق كبير بين المنطقة الزمنية والـ IP |
| `ip_reputation` | datacenter/VPN/Proxy/TOR | IP من مركز بيانات أو سمعة سيئة |
| `plugins_fonts` | قائمة الخطوط/الإضافات | قائمة فارغة/ناقصة بشكل غير طبيعي |
| `device_velocity` | عدد البطاقات/الحسابات على نفس الجهاز | تجاوز عتبة خلال نافذة زمنية |

---

## 3. نموذج التسجيل (Scoring Model)

### 3.1 المرحلة الأولى: Weighted Additive Score

قابل للتفسير وسهل الضبط — ابدأ به قبل الـ ML.

لكل إشارة `i`:
- قيمة طبيعية `vᵢ ∈ [0, 1]` (0 = طبيعي تماماً، 1 = شاذ تماماً).
- وزن `wᵢ ≥ 0`.

```
rawScore = Σ (wᵢ × vᵢ)
riskScore = min(100, round(100 × rawScore / Σ wᵢ_maxContribution))
```

**أوزان مقترحة كنقطة بداية** (اضبطها بالبيانات لاحقاً):

```ts
const WEIGHTS = {
  // فئة A — بيئة العرض
  webgl_software_renderer: 25,
  canvas_blank_or_uniform: 20,
  screen_resolution_anomaly: 15,
  device_pixel_ratio_mismatch: 8,

  // فئة B — السلوك
  mouse_no_movement_before_click: 18,
  mouse_linear_or_teleport: 15,
  paste_full_card: 12,
  focus_active_while_hidden: 14,
  event_latency_jitter_high: 10,

  // فئة C — البيئة/الشبكة
  automation_webdriver: 22,
  ua_fingerprint_mismatch: 16,
  ip_datacenter_or_bad_rep: 12,
  timezone_ip_mismatch: 8,
  device_velocity_exceeded: 10,
} as const;
```

### 3.2 قواعد الدمج (Combination Rules)

بعض الإشارات تكتسب قوة فقط باجتماعها. استخدم **مضاعِفات (boosters)**:

- `webgl_software_renderer` **و** `mouse_no_movement_before_click` معاً → ×1.5 على مجموعهما (نمط HVNC كلاسيكي: عرض برمجي + إدخال آلي).
- `focus_active_while_hidden` **و** `event_latency_jitter_high` معاً → ×1.4 (تحكم عن بُعد داخل سطح مخفي).
- أي إشارة من فئة A **بمفردها** لا تتجاوز عتبة الرفض — تتطلب تأكيداً من فئة أخرى (لتقليل false positives).

### 3.3 العتبات والقرار (Thresholds)

```
riskScore 0–29    → ALLOW        (سماح)
riskScore 30–64   → STEP_UP      (تحقق إضافي: 3DS2 / OTP / تحدٍّ سلوكي)
riskScore 65–100  → DENY/REVIEW  (رفض أو تحويل لمراجعة يدوية)
```

اضبط العتبات حسب شهيّتك للمخاطرة ومعدل التحويل المقبول. ابدأ متحفّظاً (step-up واسع) ثم ضيّق بالبيانات.

### 3.4 المرحلة الثانية: الانتقال لـ ML

بعد جمع بيانات مُعنونة كافية (جلسات احتيال مؤكدة vs شرعية):
- نموذج **Gradient Boosting** (XGBoost/LightGBM) على نفس المتجهات.
- احتفظ بالنموذج الخطي كـ **baseline قابل للتفسير** ولإنتاج «أسباب» القرار (reason codes) المطلوبة تنظيمياً.
- راقب **drift** وأعد التدريب دورياً.

---

## 4. هيكل المشروع المقترح (Node.js / TypeScript)

```
hvnc-risk-scoring/
├── packages/
│   ├── collector/              # يعمل في المتصفح، يُجمَّع كـ bundle صغير
│   │   ├── src/
│   │   │   ├── signals/
│   │   │   │   ├── webgl.ts
│   │   │   │   ├── canvas.ts
│   │   │   │   ├── screen.ts
│   │   │   │   ├── mouse.ts
│   │   │   │   ├── keystroke.ts
│   │   │   │   ├── focus.ts
│   │   │   │   └── automation.ts
│   │   │   ├── collect.ts       # يجمع كل الإشارات في payload
│   │   │   └── transport.ts     # يوقّع ويرسل للخادم
│   │   └── package.json
│   │
│   ├── engine/                 # محرك التسجيل (خادم)
│   │   ├── src/
│   │   │   ├── signals/         # تطبيع كل إشارة → [0,1]
│   │   │   ├── weights.ts
│   │   │   ├── combos.ts        # قواعد الدمج والمضاعِفات
│   │   │   ├── score.ts         # حساب riskScore
│   │   │   ├── decide.ts        # العتبات → قرار + reason codes
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── shared/                 # أنواع TypeScript مشتركة
│       └── src/types.ts        # SignalPayload, RiskResult, …
│
├── services/
│   └── api/                    # Express/Fastify endpoint
│       ├── src/
│       │   ├── routes/score.ts # POST /v1/score
│       │   ├── middleware/      # تحقق التوقيع، rate-limit
│       │   └── server.ts
│       └── package.json
│
└── package.json                # monorepo (pnpm/turbo workspaces)
```

### 4.1 عقد البيانات (Shared Types)

```ts
// packages/shared/src/types.ts

export interface SignalPayload {
  sessionId: string;
  timestamp: number;
  display: {
    webglRenderer: string;
    webglVendor: string;
    canvasHash: string;
    screenW: number;
    screenH: number;
    colorDepth: number;
    devicePixelRatio: number;
    hardwareConcurrency: number;
  };
  behavior: {
    mouseMoveCount: number;
    mouseMovesBeforeFirstClick: number;
    mousePathEntropy: number;       // 0..1
    keystrokeIntervals: number[];   // ms
    pastedFullCard: boolean;
    formFillMs: number;
    focusActiveWhileHidden: boolean;
    latencyJitterMs: number;
  };
  environment: {
    webdriver: boolean;
    userAgent: string;
    timezone: string;
    plugins: string[];
    fonts: string[];
  };
  // تُضاف في الخادم:
  ip?: string;
}

export type Decision = "ALLOW" | "STEP_UP" | "DENY";

export interface RiskResult {
  sessionId: string;
  riskScore: number;            // 0..100
  decision: Decision;
  reasonCodes: string[];        // لماذا اتُّخذ القرار
  contributions: Record<string, number>; // مساهمة كل إشارة (للتدقيق)
}
```

---

## 5. تدفّق التنفيذ

1. **الجمع (client):** عند تحميل صفحة الدفع، يبدأ الـ collector في تتبّع الإشارات السلبية (الماوس/المفاتيح/التركيز) ويلتقط بصمة العرض.
2. **الإرسال:** قبل الـ submit، يُجمّع payload، يُوقَّع (HMAC بمفتاح جلسة)، ويُرسل مع الطلب.
3. **التطبيع (server):** كل إشارة خام → قيمة `[0,1]`.
4. **التسجيل:** تطبيق الأوزان + قواعد الدمج → `riskScore`.
5. **القرار:** مطابقة العتبات → `ALLOW` / `STEP_UP` / `DENY` + `reasonCodes`.
6. **التنفيذ:** تمرير الطلب، أو إطلاق 3DS2/OTP، أو تحويل لمراجعة.
7. **التغذية الراجعة:** تسجيل النتيجة الفعلية (chargeback/تأكيد احتيال) لإعادة المعايرة.

---

## 6. مكافحة التحايل (Anti-Tampering)

المهاجم قد يحاول تزييف الإشارات. إجراءات التصليب:

- **لا تثق بالعميل:** الـ payload دليل، ليس حُكماً. أعِد قياس ما تستطيع من جهة الخادم (IP، سمعة، velocity).
- **توقيع + ختم زمني:** HMAC على الـ payload بمفتاح جلسة قصير العمر لمنع إعادة الإرسال (replay).
- **تناقض داخلي = إشارة بحد ذاته:** إن ادّعى العميل GPU حقيقياً لكن أداء الرسم بطيء → تناقض يرفع الخطر.
- **تعتيم الـ collector** وتدويره دورياً حتى لا يسهل تحييده.
- **إشارات صامتة (honeytokens):** حقول/أحداث لا يتفاعل معها إلا الأتمتة.
- **قياس من جهة الخادم للـ latency** بدلاً من الاعتماد على تقرير العميل فقط.

---

## 7. الخصوصية والامتثال

- اجمع فقط ما يلزم للكشف؛ لا تلتقط محتوى الحقول الحسّاسة (أرقام البطاقة نفسها) — فقط **خصائص** الإدخال (توقيت، لصق نعم/لا).
- وثّق الأساس القانوني (منع الاحتيال مصلحة مشروعة عادةً) والتزم GDPR/قوانين بلدك.
- احتفظ بـ **reason codes** لكل قرار (شفافية وقابلية للطعن).
- حدّد مدة احتفاظ واضحة بالبيانات.

---

## 8. القياس والمعايرة (Metrics)

راقب باستمرار:
- **False Positive Rate** (جلسات شرعية صُنّفت خطراً) — الأهم لتجربة المستخدم.
- **Detection Rate / Recall** (نسبة احتيال HVNC المُكتشَف).
- **Step-up conversion** (كم من step-up ينجح مستخدمون حقيقيون).
- **Precision@threshold** لكل عتبة.
- منحنى **ROC/PR** عند ضبط العتبات.

ابدأ بـ **shadow mode**: احسب الدرجة وسجّلها دون التأثير على القرار، قارنها بالنتائج الفعلية، ثم فعّل الإنفاذ تدريجياً.

---

## 9. خارطة طريق التنفيذ

1. **MVP:** collector لإشارات فئة A + محرك خطي + endpoint واحد. shadow mode.
2. أضف إشارات السلوك (فئة B) وقواعد الدمج.
3. أضف إثراء الخادم (IP reputation، device velocity).
4. فعّل الإنفاذ المتدرّج + step-up (3DS2/OTP).
5. اجمع بيانات معنونة → انتقل لنموذج ML مع إبقاء الخطي كـ baseline تفسيري.
6. حلقة إعادة المعايرة الدورية + مراقبة الـ drift.
