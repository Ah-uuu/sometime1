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
  process.exit(1);
}

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
  process.exit(1);
}

const calendar = google.calendar({ version: 'v3', auth });
const sheets = google.sheets({ version: 'v4', auth });

// 服務配置
const SERVICES = {
  '半身按摩_30': { maxCapacity: 3, resource: 'body', duration: 30 },
  '半身按摩_60': { maxCapacity: 3, resource: 'body', duration: 60 },
  '全身按摩_60': { maxCapacity: 3, resource: 'body', duration: 60 },
  '全身按摩_90': { maxCapacity: 3, resource: 'body', duration: 90 },
  '全身按摩_120': { maxCapacity: 3, resource: 'body', duration: 120 },
  '全身按摩_150': { maxCapacity: 3, resource: 'body', duration: 150 },
  '腳底按摩_40': { maxCapacity: 2, resource: 'foot', duration: 40 },
  '腳底按摩_70': { maxCapacity: 2, resource: 'foot', duration: 70 },
  '腳底+半身_70': { maxCapacity: 2, resource: ['foot', 'body'], duration: 70, components: ['腳底按摩', '半身按摩'] },
  '腳底+全身_100': { maxCapacity: 2, resource: ['foot', 'body'], duration: 100, components: ['腳底按摩', '全身按摩'] },
  '腳底+全身_130': { maxCapacity: 2, resource: ['foot', 'body'], duration: 130, components: ['腳底按摩', '全身按摩'] },
};

// 資源容量
const RESOURCE_CAPACITY = {
  'body': 3,
  'foot': 2,
};

// 師傅與顏色的映射
const MASTER_COLORS_ENV = process.env.MASTER_COLORS;
let MASTER_COLORS = {};
try {
  if (MASTER_COLORS_ENV) {
    MASTER_COLORS = JSON.parse(MASTER_COLORS_ENV);
  } else {
    MASTER_COLORS = {
      '阿U 1號': '10',
      '小周 2號': '3',
      'Alan 7號': '6',
      'Vincent 8號': '8',
      '魚丸 12號': '7',
      '小力 30號': '9',
      '': '5',
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
    '': '5',
  };
}

// 營業時間
const BUSINESS_HOURS = {
  1: { start: 12, end: 22 },
  2: { start: 12, end: 22 },
  3: { start: 12, end: 22 },
  4: { start: 12, end: 22 },
  5: { start: 13, end: 23 },
  6: { start: 13, end: 23 },
  0: { start: 13, end: 23 },
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
  const dayOfWeek = momentTime.day();
  const hour = momentTime.hour();
  const endTime = momentTime.clone().add(duration, 'minutes');
  const endHour = endTime.hour();

  const { start, end } = BUSINESS_HOURS[dayOfWeek];
  
  if (hour < start || endHour > end) {
    return { isValid: false, message: '請預約營業時間內（週一到週四 12:00~22:00，週五到週日 13:00~23:00）' };
  }
  return { isValid: true };
}

// 查找指定日期的最快可用時段（整間店）
async function findNextAvailableTime(service, targetDate) {
  const serviceConfig = SERVICES[service];
  if (!serviceConfig) return null;

  const today = targetDate.clone().startOf('day');
  const searchEnd = targetDate.clone().endOf('day');
  const components = serviceConfig.components || [service];
  const now = moment.tz('Asia/Taipei');

  let currentTime = today.clone().isBefore(now) ? now.clone() : today.clone();
  if (currentTime.minute() % 5 !== 0) {
    currentTime.add(5 - (currentTime.minute() % 5), 'minutes');
  }

  while (currentTime.isBefore(searchEnd)) {
    const checkStart = currentTime.clone().toISOString();
    const checkEnd = currentTime.clone().add(serviceConfig.duration, 'minutes').toISOString();

    const businessCheck = checkBusinessHours(checkStart, serviceConfig.duration);
    if (!businessCheck.isValid) {
      currentTime.add(5, 'minutes');
      continue;
    }

    const resourceAvailability = await checkResourceAvailability(service, checkStart, checkEnd);
    if (resourceAvailability.isAvailable) {
      return checkStart;
    }

    currentTime.add(5, 'minutes');
  }

  return null;
}

// 查找指定師傅的最快可用時段（優化版）
async function findTherapistNextAvailableTime(master, targetDate, service) {
  const serviceConfig = SERVICES[service];
  if (!serviceConfig) return null;

  const today = targetDate.clone().startOf('day');
  const searchEnd = targetDate.clone().endOf('day');
  const now = moment.tz('Asia/Taipei');

  let currentTime = today.clone().isBefore(now) ? now.clone() : today.clone();
  if (currentTime.minute() % 10 !== 0) {
    currentTime.add(10 - (currentTime.minute() % 10), 'minutes'); // 改為每 10 分鐘檢查一次
  }

  while (currentTime.isBefore(searchEnd)) {
    const checkStart = currentTime.clone().toISOString();
    const checkEnd = currentTime.clone().add(serviceConfig.duration, 'minutes').toISOString();

    // 檢查營業時間
    const businessCheck = checkBusinessHours(checkStart, serviceConfig.duration);
    if (!businessCheck.isValid) {
      currentTime.add(10, 'minutes');
      continue;
    }

    // 檢查資源可用性
    const resourceAvailability = await checkResourceAvailability(service, checkStart, checkEnd);
    if (!resourceAvailability.isAvailable) {
      currentTime.add(10, 'minutes');
      continue;
    }

    // 檢查師傅可用性
    const therapistAvailability = await checkTherapistAvailability(master, checkStart, checkEnd);
    if (therapistAvailability.isAvailable) {
      return checkStart;
    }

    currentTime.add(10, 'minutes'); // 每 10 分鐘檢查一次
  }

  return null;
}

// 檢查資源可用性
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

        const overlappingEvents = serviceEvents.filter(event => {
          const eventStart = moment.tz(event.start.dateTime || event.start.date, 'Asia/Taipei');
          const eventEnd = moment.tz(event.end.dateTime || event.end.date, 'Asia/Taipei');
          const checkStartMoment = moment.tz(startTime, 'Asia/Taipei');
          const checkEndMoment = moment.tz(endTime, 'Asia/Taipei');

          return eventStart.isBefore(checkEndMoment) && eventEnd.isAfter(checkStartMoment) &&
                 !(eventEnd.isSameOrBefore(checkStartMoment));
        });

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

// 檢查師傅可用性
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

// 檢查預約時段
async function checkAvailability(service, startTime, endTime, master) {
  const serviceConfig = SERVICES[service];
  if (!serviceConfig) {
    return { isAvailable: false, message: '無效的服務類型' };
  }

  const now = moment.tz('Asia/Taipei');
  if (moment.tz(startTime, 'Asia/Taipei').isBefore(now)) {
    return { isAvailable: false, message: '無法預約過去的時間，請選擇未來時段' };
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

          return eventStart.isBefore(checkEndMoment) && eventEnd.isAfter(checkStartMoment) &&
                 !(eventEnd.isSameOrBefore(checkStartMoment));
        });

        if (overlappingEvents.length >= maxCapacity) {
          let message = `${comp} 在該時段已達最大容客量 (${maxCapacity} 人)`;
          return {
            isAvailable: false,
            message: message + '，請點擊「當日可預約時段」查看可用時間',
            nextAvailableTime: null,
          };
        }
      }
    }

    if (master) {
      const therapistAvailability = await checkTherapistAvailability(master, startTime, endTime);
      if (!therapistAvailability.isAvailable) {
        // 計算師傅的最快可用時段
        const targetDate = moment.tz(startTime, 'Asia/Taipei');
        const nextAvailableTime = await findTherapistNextAvailableTime(master, targetDate, service);
        let message = `師傅 ${master} 在該時段已有預約`;
        if (nextAvailableTime) {
          const formattedTime = moment.tz(nextAvailableTime, 'Asia/Taipei').format('YYYY-MM-DD HH:mm:ss');
          message += `\n${master} 最快可用時段：${formattedTime}`;
        } else {
          message += `\n${master} 當日無其他可用時段`;
        }
        return {
          isAvailable: false,
          message: message,
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

// 查詢指定日期最快可預約時段 API（整間店）
server.get('/available-times', async (req, res) => {
  try {
    const { service, date } = req.query;
    if (!service || !SERVICES[service]) {
      return res.status(400).send({ success: false, message: '無效的服務類型' });
    }
    const targetDate = moment.tz(date, 'Asia/Taipei');
    if (!targetDate.isValid()) {
      return res.status(400).send({ success: false, message: '無效的日期格式' });
    }

    const nextAvailableTime = await findNextAvailableTime(service, targetDate);
    if (nextAvailableTime) {
      res.status(200).send({
        success: true,
        nextAvailableTime: moment.tz(nextAvailableTime, 'Asia/Taipei').format('YYYY-MM-DD HH:mm:ss'),
      });
    } else {
      res.status(200).send({ success: false, message: '指定日期無可用時段' });
    }
  } catch (error) {
    console.error('❌ 查詢可用時段失敗:', error.message);
    res.status(500).send({ success: false, message: `查詢可用時段失敗，請稍後再試！ 錯誤詳情: ${error.message}` });
  }
});

// 寫入試算表函數
async function appendToSpreadsheet({ name, phone, service, duration, appointmentTime, master }) {
  try {
    const date = moment(appointmentTime).tz('Asia/Taipei').format('YYYY-MM-DD');
    const time = moment(appointmentTime).tz('Asia/Taipei').format('HH:mm');
    
    const sheetName = date;
    
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
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: sheetName,
                  gridProperties: { rowCount: 100, columnCount: 10 },
                },
              },
            },
          ],
        },
      });
      console.log(`✅ 為日期 ${sheetName} 創建新工作表`);
    }

    const values = [
      [
        date,
        name,
        phone,
        service,
        duration,
        time,
        master || '',
        '',
        '',
        '',
      ],
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:J`,
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

// 預約 API
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

    if (!SERVICES[service]) {
      return res.status(400).send({ success: false, message: '無效的服務類型或時長' });
    }

    const serviceConfig = SERVICES[service];
    const duration = serviceConfig.duration;
    const startTime = moment.tz(appointmentTime, 'Asia/Taipei').toISOString();
    const endTime = moment.tz(appointmentTime, 'Asia/Taipei').add(duration, 'minutes').toISOString();

    const businessCheck = checkBusinessHours(startTime, duration);
    if (!businessCheck.isValid) {
      return res.status(400).send({ 
        success: false, 
        message: businessCheck.message + '，請點擊「當日可預約時段」查看可用時間',
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
      const compDuration = service.includes('+') 
        ? (comp === '腳底按摩' ? 40 : duration - 40)
        : SERVICES[comp].duration;

      let colorId = undefined;
      if (master && MASTER_COLORS[master]) {
        colorId = MASTER_COLORS[master];
      } else if (!master) {
        colorId = MASTER_COLORS[''];
      }

      const event = {
        summary: `${comp} 預約：${name}`,
        description: `電話：${phone}${master ? `\n師傅：${master}` : ''}\n原始服務：${service}\n總時長：${duration} 分鐘`,
        start: { dateTime: currentTime.toISOString(), timeZone: 'Asia/Taipei' },
        end: { dateTime: currentTime.clone().add(compDuration, 'minutes').toISOString(), timeZone: 'Asia/Taipei' },
        extendedProperties: master ? { private: { master } } : undefined,
        colorId: colorId,
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

    await appendToSpreadsheet({
      name,
      phone,
      service: service.split('_')[0],
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
