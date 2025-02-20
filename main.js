const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const moment = require('moment-timezone');
const fetch = require('node-fetch');
require('dotenv').config();

const server = express();
server.use(cors({ origin: 'https://scintillating-duckanoo-428640.netlify.app' }));
server.use(bodyParser.json());

// 環境變數設置
const CALENDAR_ID = process.env.CALENDAR_ID;
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!SERVICE_ACCOUNT_JSON || !CALENDAR_ID) {
  console.error('❌ 環境變數缺失：請確認 GOOGLE_SERVICE_ACCOUNT_JSON 和 CALENDAR_ID 是否設置');
  process.exit(1);
}

// 解析 Service Account JSON
let serviceAccount;
try {
  serviceAccount = JSON.parse(SERVICE_ACCOUNT_JSON);
} catch (error) {
  console.error('❌ 解析 Service Account JSON 失敗:', error);
  process.exit(1);
}

// Google Auth 設定
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

// 健康檢查 API
server.get('/health', (req, res) => {
  console.log('✅ /health API 被呼叫');
  res.send('✅ Server is running');
});

// Keep-Alive PING 防止 Render 休眠
const keepAlive = () => {
  console.log('🔄 嘗試 PING /health API 以保持活躍...');
  fetch('https://booking-k1q8.onrender.com/health', { method: 'GET' })
    .then(res => res.text())
    .then(data => console.log(`✅ Keep-alive ping 成功: ${data}`))
    .catch(err => console.error('❌ Keep-alive ping 失敗:', err));
};

// 每 5 分鐘 PING 一次
setInterval(keepAlive, 300000);

// 新增 Google Calendar 預約事件
server.post('/booking', async (req, res) => {
  try {
    const { name, phone, service, duration, appointmentTime } = req.body;
    if (!name || !phone || !service || !duration || !appointmentTime) {
      return res.status(400).send({ success: false, message: '缺少必要的欄位' });
    }

    if (!moment(appointmentTime, moment.ISO_8601, true).isValid()) {
      return res.status(400).send({ success: false, message: '時間格式錯誤' });
    }

    const startTime = moment.tz(appointmentTime, 'Asia/Taipei').toISOString();
    const endTime = moment.tz(appointmentTime, 'Asia/Taipei').add(duration, 'minutes').toISOString();

    const event = {
      summary: `${service} 預約：${name}`,
      description: `電話：${phone}`,
      start: { dateTime: startTime, timeZone: 'Asia/Taipei' },
      end: { dateTime: endTime, timeZone: 'Asia/Taipei' },
    };

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
    });

    res.status(200).send({ success: true, message: '預約成功！', eventId: response.data.id });
  } catch (error) {
    console.error('❌ 創建事件失敗:', error);
    res.status(500).send({ success: false, message: '創建事件失敗，請稍後再試！' });
  }
});

// 啟動 Express 伺服器
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  keepAlive(); // 立即執行一次 Keep-Alive，確保伺服器啟動後馬上 PING
});
