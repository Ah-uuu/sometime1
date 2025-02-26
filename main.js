const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const moment = require('moment-timezone');
const fetch = require('node-fetch');
require('dotenv').config();

const server = express();
server.use(cors({ origin: 'https://booking-sometime-0.onrender.com' }));
server.use(bodyParser.json());

// 環境變數設置
const CALENDAR_ID = process.env.CALENDAR_ID;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!SERVICE_ACCOUNT_JSON || !CALENDAR_ID || !SPREADSHEET_ID) {
  console.error('❌ 環境變數缺失：');
  if (!SERVICE_ACCOUNT_JSON) console.error('  - GOOGLE_SERVICE_ACCOUNT_JSON 未設置');
  if (!CALENDAR_ID) console.error('  - CALENDAR_ID 未設置');
  if (!SPREADSHEET_ID) console.error('  - SPREADSHEET_ID 未設置');
  process.exit(1); // 終止程序，避免無效運行
}

// Google API 認證
let auth;
try {
  const serviceAccount = JSON.parse(SERVICE_ACCOUNT_JSON);
  auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
} catch (error) {
  console.error('❌ 解析 Service Account JSON 失敗:', error.message);
  process.exit(1); // 終止程序，避免無效運行
}

const calendar = google.calendar({ version: 'v3', auth });
const sheets = google.sheets({ version: 'v4', auth });

// 服務配置（使用完整的 service 格式）
const SERVICES = {
  '半身按摩_30': {
    maxCapacity: 3,
    resource: 'body',
    duration: 30,
  },
  '半身按摩_60': {
    maxCapacity: 3,
    resource: 'body',
    duration: 60,
  },
  '全身按摩_60': {
    maxCapacity: 3,
    resource: 'body',
    duration: 60,
  },
  '全身按摩_90': {
    maxCapacity: 3,
    resource: 'body',
    duration: 90,
  },
  '全身按摩_120': {
    maxCapacity: 3,
    resource: 'body',
    duration: 120,
  },
  '全身按摩_150': {
    maxCapacity: 3,
    resource: 'body',
    duration: 150,
  },
  '腳底按摩_40': {
    maxCapacity: 2,
    resource: 'foot',
    duration: 40,
  },
  '腳底按摩_70': {
    maxCapacity: 2,
    resource: 'foot',
    duration: 70,
  },
  '腳底+半身_70': {
    maxCapacity: 2,
    resource: ['foot', 'body'],
    duration: 70,
    components: ['腳底按摩', '半身按摩'],
  },
  '腳底+全身_100': {
    maxCapacity: 2,
    resource: ['foot', 'body'],
    duration: 100,
    components: ['腳底按摩', '全身按摩'],
  },
  '腳底+全身_130': {
    maxCapacity: 2,
    resource: ['foot', 'body'],
    duration: 130,
    components: ['腳底按摩', '全身按摩'],
  },
};

// 資源容量
const RESOURCE_CAPACITY = {
  'body': 3,
  'foot': 2,
};

// 師傅與顏色的映射（colorId 範圍 1~11）
const MASTER_COLORS_ENV = process.env.MASTER_COLORS;
let MASTER_COLORS = {};

try {
  if (MASTER_COLORS_ENV) {
    MASTER_COLORS = JSON.parse(MASTER_COLORS_ENV);
  } else {
    MASTER_COLORS = {
      '阿U 1號': '10',    // 羅勒綠 → colorId: 10 (Basil)
      '小周 2號': '3',     // 葡萄紫 → colorId: 3 (Grape)
      'Alan 7號': '6',     // 橘橙色 → colorId: 6 (Tangerine)
      'Vincent 8號': '8',  // 石墨黑 → colorId: 8 (Graphite)
      '魚丸 12號': '7',    // 孔雀藍 → colorId: 7 (Peacock)
      '小力 30號': '9',    // 藍莓色 → colorId: 9 (Blueberry)
      '': '5',             // 不指定 → 香蕉黃 → colorId: 5 (Banana)
    };
  }
} catch (error) {
  console.error('❌ 解析 MASTER_COLORS 環境變數失敗:', error.message);
  MASTER_COLORS = {
    '阿U 1號': '10',
    '小周 2號': '3',
    'Alan 7號': '6',
    'Vincent 8號': '8',
    '魚丸 12號': '7',
    '小力 30號': '9',
    '': '5', // 不指定
  };
}

// 營業時間
const BUSINESS_HOURS = {
  1: { start: 12, end: 22 }, // 週一 (12:00~22:00)
  2: { start: 12, end: 22 }, // 週二
  3: { start: 12, end: 22 }, // 週三
  4: { start: 12, end: 22 }, // 週四
  5: { start: 13, end: 23 }, // 週五 (13:00~23:00)
  6: { start: 13, end: 23 }, // 週六
  0: { start: 13, end: 23 }, // 週日
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

// 檢查營業時間
function checkBusinessHours(appointmentTime, duration) {
  const momentTime = moment.tz(appointmentTime, 'Asia/Taipei');
  const dayOfWeek = momentTime.day(); // 0 (Sunday) 到 6 (Saturday)
  const hour = momentTime.hour();
  const endTime = momentTime.clone().add(duration, 'minutes');
  const endHour = endTime.hour();

  const { start, end } = BUSINESS_HOURS[dayOfWeek];
  
  if (hour < start || endHour > end) {
    return { isValid: false, message: '請預約營業時間內（週一到週四 12:00~22:00，週五到週日 13:00~23:00）' };
  }
  return { isValid: true };
}

// 查找當天最快可用時段（僅檢查場地，忽略師傅）
async function findNextAvailableTime(service) {
  const serviceConfig = SERVICES[service];
  if (!serviceConfig) return null;

  const today = moment.tz('Asia/Taipei').startOf('day');
  const searchEnd = moment.tz(today).endOf('day'); // 當天結束時間
  const components = serviceConfig.components || [service];

  let currentTime = today.clone();
  while (currentTime.isBefore(searchEnd)) {
    const checkStart = currentTime.clone().toISOString();
    const checkEnd = currentTime.clone().add(serviceConfig.duration, 'minutes').toISOString();

    // 檢查營業時間
    const businessCheck = checkBusinessHours(checkStart, serviceConfig.duration);
    if (!businessCheck.isValid) {
      currentTime.add(1, 'minutes'); // 檢查間隔為 1 分鐘
      continue;
    }

    // 僅檢查場地的可用性（忽略師傅）
    const resourceAvailability = await checkResourceAvailability(service, checkStart, checkEnd);
    if (resourceAvailability.isAvailable) {
      return checkStart;
    }

    currentTime.add(1, 'minutes'); // 每 1 分鐘檢查一次
  }

  return null; // 當天無可用時段
}

// 檢查資源（床位/腳位）可用性（精確處理結束時間）
async function checkResourceAvailability(service, startTime, endTime) {
  const serviceConfig = SERVICES[service];
  const components = serviceConfig.components || [service];

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
      const resource = Array.isArray(SERVICES[comp].resource) ? SERVICES[comp].resource : [SERVICES[comp].resource];
      for (const res of resource) {
        const maxCapacity = RESOURCE_CAPACITY[res];
        const serviceEvents = events.filter(event => {
          const eventService = event.summary.split(' 預約：')[0];
          if (!SERVICES[eventService]) return false;
          const eventResource = Array.isArray(SERVICES[eventService].resource) ? SERVICES[eventService].resource : [SERVICES[eventService].resource];
          return eventResource.includes(res);
        });

        // 檢查事件是否完全覆蓋目標時段，但允許結束時間後立即預約
        const overlappingEvents = serviceEvents.filter(event => {
          const eventStart = moment.tz(event.start.dateTime || event.start.date, 'Asia/Taipei');
          const eventEnd = moment.tz(event.end.dateTime || event.end.date, 'Asia/Taipei');
          const checkStartMoment = moment.tz(startTime, 'Asia/Taipei');
          const checkEndMoment = moment.tz(endTime, 'Asia/Taipei');

          // 僅當事件完全覆蓋檢查時間範圍時視為衝突
          return eventStart.isBefore(checkEndMoment) && eventEnd.isAfter(checkStartMoment) &&
                 !(eventEnd.isSameOrBefore(checkStartMoment)); // 確保結束時間不早於檢查開始時間
        });

        console.log(`Resource ${res}, Checking time ${moment.tz(startTime, 'Asia/Taipei').format('YYYY-MM-DD HH:mm:ss')} to ${moment.tz(endTime, 'Asia/Taipei').format('YYYY-MM-DD HH:mm:ss')}, Overlapping events:`, overlappingEvents);

        if (overlappingEvents.length >= maxCapacity) {
          return { isAvailable: false };
        }
      }
    }

    return { isAvailable: true };
  } catch (error) {
    console.error('❌ 檢查資源可用性失敗:', error.message);
    throw error;
  }
}

// 檢查師傅可用性（僅用於提示）
async function checkTherapistAvailability(master, startTime, endTime) {
  try {
    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startTime,
      timeMax: endTime,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];
    const masterEvents = events.filter(event => event.extendedProperties?.private?.master === master);

    return { isAvailable: masterEvents.length === 0 };
  } catch (error) {
    console.error('❌ 檢查師傅可用性失敗:', error.message);
    throw error;
  }
}

// 檢查預約時段（僅檢查場地和師傅限制，不回傳時間）
async function checkAvailability(service, startTime, endTime, master) {
  const serviceConfig = SERVICES[service];
  if (!serviceConfig) {
    return { isAvailable: false, message: '無效的服務類型' };
  }

  const components = serviceConfig.components || [service];

  try {
    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startTime,
      timeMax: endTime,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];

    // 檢查場地（資源）可用性
    for (const comp of components) {
      const resource = Array.isArray(serviceConfig.resource) ? serviceConfig.resource : [serviceConfig.resource];
      for (const res of resource) {
        const maxCapacity = RESOURCE_CAPACITY[res];
        const serviceEvents = events.filter(event => {
          const eventService = event.summary.split(' 預約：')[0];
          if (!SERVICES[eventService]) return false;
          const eventResource = Array.isArray(SERVICES[eventService].resource) ? SERVICES[eventService].resource : [SERVICES[eventService].resource];
          return eventResource.includes(res);
        });

        const overlappingEvents = serviceEvents.filter(event => {
          const eventStart = moment.tz(event.start.dateTime || event.start.date, 'Asia/Taipei');
          const eventEnd = moment.tz(event.end.dateTime || event.end.date, 'Asia/Taipei');
          const checkStartMoment = moment.tz(startTime, 'Asia/Taipei');
          const checkEndMoment = moment.tz(endTime, 'Asia/Taipei');

          // 僅當事件完全覆蓋檢查時間範圍時視為衝突
          return eventStart.isBefore(checkEndMoment) && eventEnd.isAfter(checkStartMoment) &&
                 !(eventEnd.isSameOrBefore(checkStartMoment)); // 確保結束時間不早於檢查開始時間
        });

        if (overlappingEvents.length >= maxCapacity) {
          let message = `${comp} 在該時段已達最大容客量 (${maxCapacity} 人)`;
          return {
            isAvailable: false,
            message: message + '，請點擊「今日可預約時段」查看可用時間',
            nextAvailableTime: null,
          };
        }
      }
    }

    // 檢查師傅可用性（僅用於提示）
    if (master) {
      const therapistAvailability = await checkTherapistAvailability(master, startTime, endTime);
      if (!therapistAvailability.isAvailable) {
        return {
          isAvailable: false,
          message: `師傅 ${master} 在該時段已有預約，請點擊「今日可預約時段」查看可用時間`,
          nextAvailableTime: null,
        };
      }
    }

    return { isAvailable: true };
  } catch (error) {
    console.error('❌ 檢查可用性失敗:', error.message);
    throw error;
  }
}

// 新增 API：查詢當天最快可預約時段
server.get('/available-times', async (req, res) => {
  try {
    const { service } = req.query;
    if (!service || !SERVICES[service]) {
      return res.status(400).send({ success: false, message: '無效的服務類型' });
    }

    const nextAvailableTime = await findNextAvailableTime(service);
    if (nextAvailableTime) {
      res.status(200).send({
        success: true,
        nextAvailableTime: moment.tz(nextAvailableTime, 'Asia/Taipei').format('YYYY-MM-DD HH:mm:ss'),
      });
    } else {
      res.status(200).send({ success: false, message: '當天無可用時段' });
    }
  } catch (error) {
    console.error('❌ 查詢可用時段失敗:', error.message);
    res.status(500).send({ success: false, message: `查詢可用時段失敗，請稍後再試！ 錯誤詳情: ${error.message}` });
  }
});

// 寫入試算表函數（按日期分頁）
async function appendToSpreadsheet({ name, phone, service, duration, appointmentTime, master }) {
  try {
    const date = moment(appointmentTime).tz('Asia/Taipei').format('YYYY-MM-DD');
    const time = moment(appointmentTime).tz('Asia/Taipei').format('HH:mm');
    
    // 構建目標工作表名稱（例如 "2025-02-23"）
    const sheetName = date;
    
    // 檢查工作表是否存在，若不存在則創建
    let sheetsResponse;
    try {
      sheetsResponse = await sheets.spreadsheets.get({
        spreadsheetId: SPREADSHEET_ID,
      });
    } catch (error) {
      console.error('❌ 獲取試算表資訊失敗:', error.message);
      throw error;
    }

    const sheetExists = sheetsResponse.data.sheets.some(sheet => sheet.properties.title === sheetName);
    if (!sheetExists) {
      // 創建新工作表
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: sheetName,
                  gridProperties: {
                    rowCount: 100, // 設置初始行數
                    columnCount: 10, // 設置初始列數（對應 A:J）
                  },
                },
              },
            },
          ],
        },
      });
      console.log(`✅ 為日期 ${sheetName} 創建新工作表`);
    }

    // 寫入數據到對應的工作表
    const values = [
      [
        date,        // A: 日期
        name,        // B: 姓名
        phone,       // C: 電話
        service,     // D: 項目（不含時長）
        duration,    // E: 時長
        time,        // F: 預約時間
        master || '', // G: 師傅
        '',          // H: 總額（留空）
        '',          // I: 備註（留空）
        '',          // J: 編號（留空）
      ],
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:J`, // 寫入對應日期的工作表
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values },
    });

    console.log(`✅ 預約資料已写入試算表日期分頁 ${sheetName}: ${name}`);
  } catch (error) {
    console.error('❌ 寫入試算表失敗:', error.message);
    throw error;
  }
}

// 預約 API（僅檢查場地和師傅限制）
server.post('/booking', async (req, res) => {
  if (!calendar || !sheets) {
    return res.status(500).send({ success: false, message: '伺服器配置錯誤，無法連接到 Google 服務' });
  }

  try {
    const { name, phone, service, appointmentTime, master } = req.body;

    if (!name || !phone || !service || !appointmentTime) {
      return res.status(400).send({ success: false, message: '缺少必要的欄位' });
    }
    if (!moment(appointmentTime, moment.ISO_8601, true).isValid()) {
      return res.status(400).send({ success: false, message: '時間格式錯誤' });
    }

    // 直接使用完整的 service 格式（例如 "半身按摩_30"）作為鍵
    if (!SERVICES[service]) {
      return res.status(400).send({ success: false, message: '無效的服務類型或時長' });
    }

    const serviceConfig = SERVICES[service];
    const duration = serviceConfig.duration;
    const startTime = moment.tz(appointmentTime, 'Asia/Taipei').toISOString();
    const endTime = moment.tz(appointmentTime, 'Asia/Taipei').add(duration, 'minutes').toISOString();

    // 檢查營業時間
    const businessCheck = checkBusinessHours(startTime, duration);
    if (!businessCheck.isValid) {
      return res.status(400).send({ 
        success: false, 
        message: businessCheck.message + '，請點擊「今日可預約時段」查看可用時間',
        nextAvailableTime: null, 
      });
    }

    const availability = await checkAvailability(service, startTime, endTime, master);
    if (!availability.isAvailable) {
      return res.status(409).send({ 
        success: false, 
        message: availability.message,
        nextAvailableTime: null, 
      });
    }

    const events = [];
    let currentTime = moment.tz(appointmentTime, 'Asia/Taipei');
    const components = serviceConfig.components || [service];
    for (const comp of components) {
      // 處理複合服務時長：腳底固定 40 分鐘，其餘分配
      const compDuration = service.includes('+') 
        ? (comp === '腳底按摩' ? 40 : duration - 40) // 腳底固定 40 分鐘，其餘分配
        : SERVICES[comp].duration; // 單一服務用固定時長

      // 根據師傅設置顏色（若有指定師傅）
      let colorId = undefined;
      if (master && MASTER_COLORS[master]) {
        colorId = MASTER_COLORS[master]; // 使用師傅對應的顏色
      } else if (!master) { // 不指定師傅，使用預設顏色（香蕉黃）
        colorId = MASTER_COLORS[''];
      }

      const event = {
        summary: `${comp} 預約：${name}`,
        description: `電話：${phone}${master ? `\n師傅：${master}` : ''}\n原始服務：${service}\n總時長：${duration} 分鐘`,
        start: { dateTime: currentTime.toISOString(), timeZone: 'Asia/Taipei' },
        end: { dateTime: currentTime.clone().add(compDuration, 'minutes').toISOString(), timeZone: 'Asia/Taipei' },
        extendedProperties: master ? { private: { master } } : undefined,
        colorId: colorId, // 添加顏色 ID（若有指定師傅或不指定）
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

    // 將預約資訊寫入試算表（按日期分頁）
    await appendToSpreadsheet({
      name,
      phone,
      service: service.split('_')[0], // 只寫入服務名稱
      duration,
      appointmentTime: startTime,
      master,
    });

    res.status(200).send({ success: true, message: '預約成功！', eventIds });
  } catch (error) {
    console.error('❌ 創建事件失敗:', error.message);
    res.status(500).send({ success: false, message: `創建事件失敗，請稍後再試！ 錯誤詳情: ${error.message}` });
  }
});

// 啟動伺服器
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  keepAlive();
});
