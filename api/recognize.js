// api/recognize.js — Vercel Serverless Function
// 手寫巡檢規格卡照片 → Claude 視覺辨識 → 固定 JSON(檢驗項目 / 標準 / 公差 / 刀號 / 信心度)
//
// 環境變數(Vercel → Settings → Environment Variables):
//   ANTHROPIC_API_KEY   必填。Claude API 金鑰
//   ANTHROPIC_MODEL     選填。預設 claude-sonnet-5
//   FIREBASE_WEB_API_KEY 選填。填了就會驗證前端送來的 Firebase ID token(避免被外人呼叫燒 API 費用)
//                        值 = hcpi-order-tracker.html 裡 firebaseConfig.apiKey

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // base64 前約 4MB

// Claude 必須回傳的結構(用 tool_use 強制輸出 JSON)
const SPEC_TOOL = {
  name: 'submit_inspection_spec',
  description: '回報從手寫規格卡辨識出的檢驗項目',
  input_schema: {
    type: 'object',
    properties: {
      partNo: { type: 'string', description: '件號 / 品名 / 圖號,原樣抄寫。無則空字串' },
      section: { type: 'string', description: '工段,例如 車1、車2、銑1。無則空字串' },
      date: { type: 'string', description: '卡片上的日期,原樣抄寫(例如 0506)。無則空字串' },
      material: { type: 'string', description: '材料或素材尺寸(例如 Φ125.5×110.3)。無則空字串' },
      items: {
        type: 'array',
        description: '檢驗項目,依卡片上的順序',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '檢驗項目名稱,例如 內孔、內孔深、溝徑、外徑、全長、高度' },
            nominal: { type: 'number', description: '標稱尺寸(mm)。無法判讀時省略' },
            tolPlus: { type: 'number', description: '上偏差,正數(例如 ±0.02 → 0.02;+0.05/-0 → 0.05)' },
            tolMinus: { type: 'number', description: '下偏差,正數(例如 ±0.02 → 0.02;+0.05/-0 → 0)' },
            stdText: { type: 'string', description: '檢驗標準原文,例如 66.33±0.02' },
            toolNo: { type: 'string', description: '刀號,例如 1號、7號、3號。無則空字串' },
            note: { type: 'string', description: '旁註,例如刀補值 (-3.65~-3.69)、量測位置說明。無則空字串' },
            confidence: { type: 'number', description: '這一項辨識的信心度 0~1' },
            unsure: { type: 'string', description: '不確定的地方說明(哪個數字可能誤判)。確定則空字串' }
          },
          required: ['name', 'stdText', 'confidence']
        }
      },
      notes: { type: 'string', description: '整張卡片的其他備註,例如「最長邊為主」' },
      overallConfidence: { type: 'number', description: '整體信心度 0~1' }
    },
    required: ['items', 'overallConfidence']
  }
};

const SYSTEM_PROMPT = `你是 CNC 精密加工廠(弘丞精密工業)的品管助理,負責把現場手寫的「加工規格卡」辨識成結構化的製程自主檢驗項目。

現場手寫習慣:
- 一行通常是「刀號 項目 尺寸±公差 (旁註)」,例如「1號 內孔 66.33±0.02 小 (-3.65~-3.69)」。
- 「N號」是刀號,不是檢驗項目。
- 括號內的一組數字(例如 (-3.65~-3.69)、(46.71~46.75))通常是刀補值或量測位置,放到 note,不要當成檢驗標準。
- 「±」後面是對稱公差;「+0.05 -0」是不對稱公差。只寫一個數字沒有公差的,tolPlus/tolMinus 省略。
- 「內孔、內孔深、溝徑、外徑、全長、高度、牙、倒角、外觀」是常見項目名稱。
- 日期常寫成 4 位數(例如 0506 = 5月6日)。
- 「車1」「車2」「銑1」是工段。

規則:
- 只抄寫看得到的內容,不要憑空補。
- 數字容易混淆(0/6、1/7、3/8、小數點位置),不確定時把 confidence 降到 0.7 以下並在 unsure 說明。
- 每一個尺寸項目都要輸出一筆,即使沒有公差。
- 一定要呼叫 submit_inspection_spec 工具回傳結果。`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: '伺服器尚未設定 ANTHROPIC_API_KEY' });
  }

  // ── 驗證 Firebase ID token(設定了 FIREBASE_WEB_API_KEY 才驗證)──
  if (process.env.FIREBASE_WEB_API_KEY) {
    const auth = req.headers.authorization || '';
    const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!idToken) return res.status(401).json({ error: '未登入' });
    try {
      const r = await fetch(
        'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + process.env.FIREBASE_WEB_API_KEY,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
      );
      if (!r.ok) return res.status(401).json({ error: '登入驗證失敗' });
    } catch (e) {
      return res.status(401).json({ error: '登入驗證失敗: ' + e.message });
    }
  }

  // ── 讀取 body ──
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !body.image) return res.status(400).json({ error: '缺少 image(base64)' });

  let data = String(body.image);
  let mediaType = body.mediaType || 'image/jpeg';
  const m = data.match(/^data:(image\/[a-z]+);base64,(.*)$/i);
  if (m) { mediaType = m[1]; data = m[2]; }
  if (data.length > MAX_IMAGE_BYTES * 1.4) return res.status(413).json({ error: '圖片太大,請縮小後再傳' });

  const hint = body.hint ? `\n\n已知資訊(來自系統,可用來校正辨識):${body.hint}` : '';

  const payload = {
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [SPEC_TOOL],
    tool_choice: { type: 'tool', name: 'submit_inspection_spec' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
        { type: 'text', text: '請辨識這張手寫規格卡,輸出檢驗項目。' + hint }
      ]
    }]
  };

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });
    const json = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: 'Claude API 錯誤', detail: json.error || json });
    }
    const toolBlock = (json.content || []).find(c => c.type === 'tool_use');
    if (!toolBlock) return res.status(502).json({ error: '辨識結果格式不符', detail: json });

    const result = toolBlock.input || {};
    result.items = Array.isArray(result.items) ? result.items : [];
    result.items = result.items.map((it, i) => ({
      no: i + 1,
      name: it.name || '',
      nominal: typeof it.nominal === 'number' ? it.nominal : null,
      tolPlus: typeof it.tolPlus === 'number' ? it.tolPlus : null,
      tolMinus: typeof it.tolMinus === 'number' ? it.tolMinus : null,
      stdText: it.stdText || '',
      toolNo: it.toolNo || '',
      note: it.note || '',
      confidence: typeof it.confidence === 'number' ? it.confidence : 0.5,
      unsure: it.unsure || ''
    }));
    result.model = MODEL;
    result.usage = json.usage;
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: '辨識失敗: ' + e.message });
  }
};
