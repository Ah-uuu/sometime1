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
  console.error('❌ 環境變數缺失：');
  if (!SERVICE_ACCOUNT_JSON) console.error('  - GOOGLE_SERVICE_ACCOUNT_JSON 未設置');
  if (!CALENDAR_ID) console.error('  - CALENDAR_ID 未設置');
}

// Google 日曆認證
let auth;
try {
  const serviceAccount = JSON.parse(SERVICE_ACCOUNT_JSON);
  auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
} catch (error) {
  console.error('❌ 解析 Service Account JSON 失敗:', error.message);
}

const calendar = auth ? google.calendar({ version: 'v3', auth }) : null;

// 服務配置
const SERVICES = {
  '全身按摩': { maxCapacity: 3, resource: 'body', duration: 60 },
  '半身按摩': { maxCapacity: 3, resource: 'body', duration: 30 },
  '腳底按摩': { maxCapacity: 2, resource: 'foot', duration: 40 },
  '腳底+全身': { components: ['腳底按摩', '全身按摩'], duration: 100 }, // 分拆為腳底和全身
  '腳底+半身': { components: ['腳底按摩', '半身按摩'], duration: 70 }, // 分拆為腳底和半身
};

// 資源容量
const RESOURCE_CAPACITY = {
  'body': 3, // 全身和半身共用
  'foot': 2,
};

// 健康檢查 API
server.get('/health', (req, res) => {
  const source = req.headers['user-agent'] || '未知來源';
  console.log(`✅ /health API 被呼叫於 ${new Date().toISOString()}，來源: ${source}`);
  res.send('✅ Server is running');
});

// Keep-Alive PING
const keepAlive = () => {
  console.log(`🔄 嘗試 PING /health API 以保持活躍於 ${new Date().toISOString()}...`);
  fetch('https://booking-k1q8.onrender.com/health', { method: 'GET' })
    .then(res => res.text())
    .then(data => console.log(`✅ Keep-alive ping 成功於 ${new Date().toISOString()}: ${data}`))
    .catch(err => console.error(`❌ Keep-alive ping 失敗於 ${new Date().toISOString()}:`, err));
};
setInterval(keepAlive, 600000);

// 檢查資源和師傅可用性
async function checkAvailability(service, startTime, endTime, master) {
  const serviceConfig = SERVICES[service];
  if (!serviceConfig) {
    return { isAvailable: false, message: '無效的服務類型' };
  }

  const components = serviceConfig.components || [service]; // 若為複合型則分拆，否則單一服務
  const eventsToCheck = [];

  try {
    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startTime,
      timeMax: endTime,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];

    for (const comp of components) {
      const resource = SERVICES[comp].resource;
      const maxCapacity = SERVICES[comp].maxCapacity;
      const serviceEvents = events.filter(event => {
        const eventService = event.summary.split(' 預約：')[0];
        return SERVICES[eventService]?.resource === resource;
      });

      if (serviceEvents.length >= maxCapacity) {
        return { isAvailable: false, message: `${comp} 在該時段已達最大容客量 (${maxCapacity} 人)` };
      }
      eventsToCheck.push(...serviceEvents);
    }

    // 檢查師傅
    if (master) {
      const masterEvents = events.filter(event => event.extendedProperties?.private?.master === master);
      if (masterEvents.length > 0) {
        return { isAvailable: false, message: `師傅 ${master} 在該時段已有預約` };
      }
    }

    return { isAvailable: true };
  } catch (error) {
    console.error('❌ 檢查可用性失敗:', error.message);
    throw error;
  }
}

// 預約 API
server.post('/booking', async (req, res) => {
  if (!calendar) {
    return res.status(500).send({ success: false, message: '伺服器配置錯誤，無法連接到 Google 日曆' });
  }

  try {
    const { name, phone, service, duration: requestedDuration, appointmentTime, master } = req.body;

    // 驗證輸入
    if (!name || !phone || !service || !appointmentTime) {
      return res.status(400).send({ success: false, message: '缺少必要的欄位' });
    }
    if (!moment(appointmentTime, moment.ISO_8601, true).isValid()) {
      return res.status(400).send({ success: false, message: '時間格式錯誤' });
    }
    if (!SERVICES[service]) {
      return res.status(400).send({ success: false, message: '無效的服務類型' });
    }

    const serviceConfig = SERVICES[service];
    const components = serviceConfig.components || [service];
    const totalDuration = requestedDuration || serviceConfig.duration; // 使用請求提供的時長或預設時長
    const startTime = moment.tz(appointmentTime, 'Asia/Taipei');
    const endTime = startTime.clone().add(totalDuration, 'minutes');

    // 檢查可用性
    const availability = await checkAvailability(service, startTime.toISOString(), endTime.toISOString(), master);
    if (!availability.isAvailable) {
      return res.status(409).send({ success: false, message: availability.message });
    }

    // 分拆事件
    const events = [];
    let currentTime = startTime.clone();
    for (const comp of components) {
      const compDuration = SERVICES[comp].duration;
      const event = {
        summary: `${comp} 預約：${name}`,
        description: `電話：${phone}${master ? `\n師傅：${master}` : ''}\n原始服務：${service}`,
        start: { dateTime: currentTime.toISOString(), timeZone: 'Asia/Taipei' },
        end: { dateTime: currentTime.clone().add(compDuration, 'minutes').toISOString(), timeZone: 'Asia/Taipei' },
        extendedProperties: master ? { private: { master } } : undefined,
      };
      events.push(event);
      currentTime.add(compDuration, 'minutes');
    }

    // 插入事件
    const eventIds = [];
    for (const event of events) {
      const response = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        resource: event,
      });
      eventIds.push(response.data.id);
    }

    res.status(200).send({ success: true, message: '預約成功！', eventIds });
  } catch (error) {
    console.error('❌ 創建事件失敗:', error.message);
    res.status(500).send({ success: false, message: '創建事件失敗，請稍後再試！' });
  }
});

// 啟動伺服器
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  keepAlive();
});
