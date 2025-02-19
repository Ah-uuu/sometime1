const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const moment = require('moment-timezone');
require('dotenv').config();

const server = express();
server.use(cors({ origin: 'https://scintillating-duckanoo-428640.netlify.app' }));
server.use(bodyParser.json());

// 環境變數設置
const CALENDAR_ID = process.env.CALENDAR_ID;
const SERVICE_ACCOUNT_JSON = process.env.SERVICE_ACCOUNT_JSON;

if (!SERVICE_ACCOUNT_JSON || !CALENDAR_ID) {
  console.error('❌ 環境變數缺失：請確認 SERVICE_ACCOUNT_JSON 和 CALENDAR_ID 是否設置');
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

// 健康檢查 API，防止 Render 休眠
server.get('/health', (req, res) => {
  res.send('✅ Server is running');
});

// 新增 Google Calendar 預約事件
server.post('/booking', async (req, res) => {
  try {
    const { name, phone, service, duration, appointmentTime } = req.body;
    if (!name || !phone || !service || !duration || !appointmentTime) {
      return res.status(400).send({ success: false, message: '缺少必要的欄位' });
    }

    // 轉換時間格式
    const startTime = moment.tz(appointmentTime, 'Asia/Taipei').toISOString();
    const endTime = moment.tz(new Date(new Date(appointmentTime).getTime() + duration * 60000), 'Asia/Taipei').toISOString();

    // 設置事件
    const event = {
      summary: `${service} 預約：${name}`,
      description: `電話：${phone}`,
      start: { dateTime: startTime, timeZone: 'Asia/Taipei' },
      end: { dateTime: endTime, timeZone: 'Asia/Taipei' },
    };

    // 插入事件
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
});
