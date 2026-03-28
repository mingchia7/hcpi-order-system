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

  const rows = [];

  // 1. 從 orders 的 prodLogs 抓資料
  const ordersSnap = await db.collection('orders').get();
  ordersSnap.forEach(doc => {
    const o = doc.data();
    const logs = Array.isArray(o.prodLogs) ? o.prodLogs : [];
    logs.forEach(l => {
      if (l.date === today) {
        rows.push({
          factory: l.loc || l.factory || '-',
          machine: l.machine || '-',
          section: l.section || '-',
          productName: l.productName || o.name || '-',
          operator: l.operator || '-',
          qty: parseInt(l.qty || 0),
          orderId: o.id || '-'
        });
      }
    });
  });

  // 2. 從 prodReports 抓資料
  const reportsSnap = await db.collection('prodReports').where('date', '==', today).get();
  reportsSnap.forEach(doc => {
    const d = doc.data();
    rows.push({
      factory: d.factory || '-',
      machine: d.machine || '-',
      section: d.section || '-',
      productName: d.productName || '-',
      operator: d.operator || '-',
      qty: parseInt(d.qty || 0),
      orderId: '-'
    });
  });

  if (!rows.length) {
    console.log('今天沒有生產資料');
    return;
  }

  // 統計各廠別總量
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  const f1 = rows.filter(r => r.factory === '一廠').reduce((s, r) => s + r.qty, 0);
  const f2 = rows.filter(r => r.factory === '二廠').reduce((s, r) => s + r.qty, 0);
  const f3 = rows.filter(r => r.factory === '委外加工').reduce((s, r) => s + r.qty, 0);

  // 品名彙總
  const productMap = {};
  rows.forEach(r => {
    const name = r.productName;
    const key = `${r.factory}・${r.section}`;
    if (!productMap[name]) productMap[name] = { total: 0, sections: {} };
    productMap[name].total += r.qty;
    if (!productMap[name].sections[key]) productMap[name].sections[key] = 0;
    productMap[name].sections[key] += r.qty;
  });

  // 組合訊息
  let msg = `📊 ${today} 生產日報表\n`;
  msg += `${'─'.repeat(22)}\n`;
  msg += `📦 當日總量：${totalQty.toLocaleString()} pcs\n`;
  if (f1 > 0) msg += `  🏭 一廠：${f1.toLocaleString()} pcs\n`;
  if (f2 > 0) msg += `  🏭 二廠：${f2.toLocaleString()} pcs\n`;
  if (f3 > 0) msg += `  🏭 委外：${f3.toLocaleString()} pcs\n`;
  msg += `${'─'.repeat(22)}\n`;

  // 品名細分
  for (const [name, data] of Object.entries(productMap)) {
    msg += `\n📌 ${name}：${data.total.toLocaleString()} pcs\n`;
    for (const [key, qty] of Object.entries(data.sections)) {
      msg += `   ${key}：${qty.toLocaleString()} pcs\n`;
    }
  }

  msg += `${'─'.repeat(22)}\n✅ 系統自動發送`;

  console.log('📨 發送訊息：\n', msg);

  // 發送到 LINE 群組
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
