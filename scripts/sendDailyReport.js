const admin = require('firebase-admin');
const axios = require('axios');

// 初始化 Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// 取得今天日期（台灣時間）
function getTodayTW() {
  const now = new Date();
  const tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return tw.toISOString().split('T')[0];
}

async function sendDailyReport() {
  const today = getTodayTW();
  console.log(`📅 抓取日期：${today}`);

  const snapshot = await db.collection('prodReports')
    .where('date', '==', today)
    .get();

  if (snapshot.empty) {
    console.log('今天沒有生產資料');
    return;
  }

  // 整理資料：依廠別、品名、工段統計
  const factoryData = {};
  snapshot.forEach(doc => {
    const d = doc.data();
    const factory = d.factory || '未知廠';
    const key = `${d.productName}｜${d.section}`;
    if (!factoryData[factory]) factoryData[factory] = {};
    if (!factoryData[factory][key]) factoryData[factory][key] = 0;
    factoryData[factory][key] += Number(d.qty) || 0;
  });

  // 組合訊息
  let msg = `📊 ${today} 生產日報表\n${'─'.repeat(20)}\n`;
  let totalAll = 0;

  for (const [factory, items] of Object.entries(factoryData)) {
    msg += `\n🏭 ${factory}\n`;
    let factoryTotal = 0;
    for (const [key, qty] of Object.entries(items)) {
      msg += `  ${key}：${qty.toLocaleString()} 個\n`;
      factoryTotal += qty;
    }
    msg += `  小計：${factoryTotal.toLocaleString()} 個\n`;
    totalAll += factoryTotal;
  }

  msg += `${'─'.repeat(20)}\n✅ 總計：${totalAll.toLocaleString()} 個`;

  console.log('📨 發送訊息：\n', msg);

  await axios.post('https://api.line.me/v2/bot/message/push', {
    to: process.env.LINE_GROUP_ID,
    messages: [{ type: 'text', text: msg }]
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  console.log('✅ 日報表發送成功！');
}

sendDailyReport().catch(console.error);
