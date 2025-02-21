const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const moment = require('moment-timezone');
const fetch = require('node-fetch');
require('dotenv').config();

const server = express();
server.use(cors({ origin: 'https://extraordinary-mermaid-aeffc9.netlify.app' }));
server.use(bodyParser.json());

// 環境變數設置
const CALENDAR_ID = process.env.CALENDAR_ID;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID; // 新增試算表 ID
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!SERVICE_ACCOUNT_JSON || !CALENDAR_ID || !SPREADSHEET_ID) {
  console.error('❌ 環境變數缺失：');
  if (!SERVICE_ACCOUNT_JSON) console.error('  - GOOGLE_SERVICE_ACCOUNT_JSON 未設置');
  if (!CALENDAR_ID) console.error('  - CALENDAR_ID 未設置');
  if (!SPREADSHEET_ID) console.error('  - SPREADSHEET_ID 未設置');
}

// Google API 認證（同時支援 Calendar 和 Sheets）
let auth;
try {
  const serviceAccount = JSON.parse(SERVICE_ACCOUNT_JSON);
  auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/spreadsheets', // 新增 Sheets API 範圍
    ],
  });
} catch (error) {
  console.error('❌ 解析 Service Account JSON 失敗:', error.message);
}

const calendar = auth ? google.calendar({ version: 'v3', auth }) : null;
const sheets = auth ? google.sheets({ version: 'v4', auth }) : null;

// 服務配置
const SERVICES = {
  '全身按摩': { maxCapacity: 3, resource: 'body', duration: 60 },
  '半身按摩': { maxCapacity: 3, resource: 'body', duration: 30 },
  '腳底按摩': { maxCapacity: 2, resource: 'foot', duration: 40 },
  '腳底+全身': { components: ['腳底按摩', '全身按摩'], duration: 100 },
  '腳底+半身': { components: ['腳底按摩', '半身按摩'], duration: 70 },
};

// 資源容量
const RESOURCE_CAPACITY = {
  'body': 3,
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

// 檢查資源和師傅可用性（保持不變）
async function checkAvailability(service, startTime, endTime, master) {
  const serviceConfig = SERVICES[service];
  if (!serviceConfig) {
    return { isAvailable: false, message: '無效的服務類型' };
  }

  const components = serviceConfig.components || [service];
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

// 寫入試算表函數
async function appendToSpreadsheet({ name, phone, service, duration, appointmentTime, master }) {
  try {
    const date = moment(appointmentTime).tz('Asia/Taipei').format('YYYY-MM-DD');
    const time = moment(appointmentTime).tz('Asia/Taipei').format('HH:mm');
    
    const values = [
      [
        date,        // 日期
        name,        // 姓名
        phone,       // 電話
        service,     // 服務項目
        duration,    // 時長
        time,        // 預約時間
        master || '', // 師傅（若無則空）
      ],
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:G', // 假設使用 Sheet1，調整為你的工作表名稱
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values },
    });

    console.log(`✅ 預約資料已写入試算表: ${name}`);
  } catch (error) {
    console.error('❌ 寫入試算表失敗:', error.message);
  }
}

// 預約 API
server.post('/booking', async (req, res) => {
  if (!calendar || !sheets) {
    return res.status(500).send({ success: false, message: '伺服器配置錯誤，無法連接到 Google 服務' });
  }

  try {
    const { name, phone, service, duration: requestedDuration, appointmentTime, master } = req.body;

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
    const totalDuration = requestedDuration || serviceConfig.duration;
    const startTime = moment.tz(appointmentTime, 'Asia/Taipei');
    const endTime = startTime.clone().add(totalDuration, 'minutes');

    const availability = await checkAvailability(service, startTime.toISOString(), endTime.toISOString(), master);
    if (!availability.isAvailable) {
      return res.status(409).send({ success: false, message: availability.message });
    }

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

    const eventIds = [];
    for (const event of events) {
      const response = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        resource: event,
      });
      eventIds.push(response.data.id);
    }

    // 將預約資訊寫入試算表
    await appendToSpreadsheet({
      name,
      phone,
      service,
      duration: totalDuration,
      appointmentTime,
      master,
    });

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
