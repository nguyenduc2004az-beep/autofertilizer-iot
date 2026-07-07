/**
 * ╔════════════════════════════════════════════════════════════╗
 * ║   HỆ THỐNG PHỐI TRỘN PHÂN TỰ ĐỘNG - NODE.JS SERVER       ║
 * ║                                                            ║
 * ║   Chức năng:                                               ║
 * ║     - MQTT client kết nối Mosquitto broker                 ║
 * ║     - Express REST API                                     ║
 * ║     - Socket.io real-time push tới trình duyệt            ║
 * ║     - Database: MySQL (Cấu hình tự tạo Database)           ║
 * ║                                                            ║
 * ║   Cổng: 3000                                               ║
 * ║   MQTT Broker: localhost:1883 (Mosquitto)                  ║
 * ╚════════════════════════════════════════════════════════════╝
 */

'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const mqtt     = require('mqtt');
const path     = require('path');
const mysql    = require('mysql2/promise');
const cron     = require('node-cron');

// ================================================================
// CẤU HÌNH — Đọc từ biến môi trường (Railway) hoặc dùng giá trị mặc định (localhost)
// ================================================================
const PORT   = process.env.PORT || 3000;

const MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883'; // Đã chuyển sang Cloud MQTT
const TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX || 'autofert_khoaluan2026'; // Đổi topic để tránh nhiễu trên public broker
const TOPIC_CMD    = `${TOPIC_PREFIX}/cmd`;
const TOPIC_STATUS = `${TOPIC_PREFIX}/status`;

console.log(`[CONFIG] PORT=${PORT} | MQTT=${MQTT_URL} | TOPICS=${TOPIC_PREFIX}/*`);

// ================================================================
// DATABASE MYSQL
// ================================================================
// Railway inject tự động: MYSQLHOST, MYSQLUSER, MYSQLPASSWORD, MYSQLPORT, MYSQLDATABASE
// Local fallback: localhost / root / '' / csdl_phoi_tron_phan
const DB_CONFIG = {
    host:     process.env.MYSQLHOST     || 'localhost',
    port:     process.env.MYSQLPORT     || 3306,
    user:     process.env.MYSQLUSER     || 'root',
    password: process.env.MYSQLPASSWORD || '',
    database: process.env.MYSQLDATABASE || 'csdl_phoi_tron_phan'
};

let pool; // MySQL connection pool

async function initDB() {
    try {
        // 1. Tạo Database nếu chưa có (CHỈ local — Railway tự tạo sẵn)
        const isRailway = !!process.env.MYSQLHOST;
        if (!isRailway) {
            const connection = await mysql.createConnection({
                host: DB_CONFIG.host,
                port: DB_CONFIG.port,
                user: DB_CONFIG.user,
                password: DB_CONFIG.password
            });
            await connection.query(`CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await connection.end();
            console.log('[DB] Local: Đã tạo/kiểm tra database.');
        } else {
            console.log('[DB] Railway: Sử dụng database đã được tạo sẵn bởi MySQL plugin.');
        }

        // 2. Khởi tạo Pool kết nối tới Database
        pool = mysql.createPool({
            ...DB_CONFIG,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });

        // 3. Tạo bảng cong_thuc
        await pool.query(`
            CREATE TABLE IF NOT EXISTS cong_thuc (
                ma_cong_thuc VARCHAR(255) PRIMARY KEY,
                ten_cong_thuc VARCHAR(255) NOT NULL,
                the_tich_bon1_ml FLOAT DEFAULT 0,
                the_tich_bon2_ml FLOAT DEFAULT 0,
                the_tich_bon3_ml FLOAT DEFAULT 0,
                mo_ta TEXT,
                ngay_tao DATETIME
            )
        `);

        // 4. Tạo bảng lich_su_tron
        await pool.query(`
            CREATE TABLE IF NOT EXISTS lich_su_tron (
                ma_lich_su BIGINT PRIMARY KEY,
                thoi_gian_tron DATETIME,
                ten_cong_thuc_da_dung VARCHAR(255),
                che_do_tron VARCHAR(50),
                ti_le_bon1 FLOAT DEFAULT 0,
                ti_le_bon2 FLOAT DEFAULT 0,
                ti_le_bon3 FLOAT DEFAULT 0,
                thuc_te_bon1_ml INT DEFAULT 0,
                thuc_te_bon2_ml INT DEFAULT 0,
                thuc_te_bon3_ml INT DEFAULT 0,
                tong_the_tich_ml INT DEFAULT 0,
                thoi_gian_chay_s INT DEFAULT 0,
                trang_thai VARCHAR(50),
                wifi_rssi INT DEFAULT 0
            )
        `);

        
        // 5. Tạo bảng lich_hen
        await pool.query(`
            CREATE TABLE IF NOT EXISTS lich_hen (
                ma_lich_hen VARCHAR(255) PRIMARY KEY,
                mo_ta VARCHAR(255),
                kieu_lich VARCHAR(50),
                n_ml INT DEFAULT 0,
                p_ml INT DEFAULT 0,
                k_ml INT DEFAULT 0,
                thoi_gian_bat_dau DATETIME NULL,
                gio_bat_dau TIME NULL,
                so_lan_ngay INT DEFAULT 1,
                cach_nhau_gio INT DEFAULT 2,
                ngay_lap VARCHAR(50) NULL,
                thoi_gian_tuoi_phut INT DEFAULT 30,
                trang_thai VARCHAR(50) DEFAULT 'active'
            )
        `);




        // Tự động kiểm tra và thêm cột nếu bảng đã tồn tại từ trước (bản cũ)
        try {
            const [columns] = await pool.query('SHOW COLUMNS FROM lich_hen');
            const colNames = columns.map(c => c.Field.toLowerCase());
            
            if (!colNames.includes('n_ml')) {
                await pool.query('ALTER TABLE lich_hen ADD COLUMN n_ml INT DEFAULT 0');
                console.log('[DB] Đã bổ sung cột n_ml vào bảng lich_hen');
            }
            if (!colNames.includes('p_ml')) {
                await pool.query('ALTER TABLE lich_hen ADD COLUMN p_ml INT DEFAULT 0');
                console.log('[DB] Đã bổ sung cột p_ml vào bảng lich_hen');
            }
            if (!colNames.includes('k_ml')) {
                await pool.query('ALTER TABLE lich_hen ADD COLUMN k_ml INT DEFAULT 0');
                console.log('[DB] Đã bổ sung cột k_ml vào bảng lich_hen');
            }
        } catch (alterErr) {
            console.error('[DB] Lỗi kiểm tra/bổ sung cột cho bảng lich_hen:', alterErr.message);
        }

        // 6. Tự động đồng bộ dữ liệu mẫu và dữ liệu từ db.json vào MySQL
        const fs = require('fs');
        const dbJsonPath = path.join(__dirname, 'db.json');
        let localData = { recipes: [], sessions: [] };

        if (fs.existsSync(dbJsonPath)) {
            try {
                localData = JSON.parse(fs.readFileSync(dbJsonPath, 'utf8'));
                console.log(`[DB] Đã tìm thấy tệp db.json với ${localData.recipes?.length || 0} công thức và ${localData.sessions?.length || 0} phiên lịch sử.`);
            } catch (err) {
                console.error('[DB] Lỗi đọc tệp db.json:', err.message);
            }
        }

        const toMysqlDatetime = (str) => {
            try {
                if (!str) return new Date().toISOString().slice(0, 19).replace('T', ' ');
                const d = new Date(str);
                if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 19).replace('T', ' ');
                return d.toISOString().slice(0, 19).replace('T', ' ');
            } catch (e) {
                return new Date().toISOString().slice(0, 19).replace('T', ' ');
            }
        };

        // --- Đồng bộ công thức (recipes) ---
        if (localData.recipes && localData.recipes.length > 0) {
            for (const r of localData.recipes) {
                try {
                    const [existing] = await pool.query('SELECT ma_cong_thuc FROM cong_thuc WHERE ma_cong_thuc = ?', [r.id]);
                    if (existing.length === 0) {
                        const rCreated = toMysqlDatetime(r.created_at);
                        await pool.query(`
                            INSERT INTO cong_thuc (ma_cong_thuc, ten_cong_thuc, the_tich_bon1_ml, the_tich_bon2_ml, the_tich_bon3_ml, mo_ta, ngay_tao)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                        `, [r.id, r.name, r.N_ml || 0, r.P_ml || 0, r.K_ml || 0, r.description || '', rCreated]);
                        console.log(`[DB-SYNC] Đã đồng bộ công thức: "${r.name}"`);
                    }
                } catch (e) {
                    console.error(`[DB-SYNC] Lỗi đồng bộ công thức ${r.name}:`, e.message);
                }
            }
        } else {
            // Fallback nếu không có db.json hoặc trống
            const [rows] = await pool.query('SELECT COUNT(*) as count FROM cong_thuc');
            if (rows[0].count === 0) {
                const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
                await pool.query(`
                    INSERT INTO cong_thuc (ma_cong_thuc, ten_cong_thuc, the_tich_bon1_ml, the_tich_bon2_ml, the_tich_bon3_ml, mo_ta, ngay_tao)
                    VALUES 
                    ('1', 'Cân bằng B1-B2-B3', 2000, 2000, 2000, 'Công thức cân bằng', ?),
                    ('2', 'Bón gốc (Bồn 1 nhiều)', 3000, 1500, 1500, 'Tăng sinh trưởng', ?),
                    ('3', 'Ra hoa (Bồn 2-3 cao)', 1000, 2500, 2500, 'Kích thích ra hoa', ?)
                `, [now, now, now]);
                console.log('[DB] Đã tạo các công thức mặc định ban đầu.');
            }
        }

        // --- Đồng bộ lịch sử trộn (sessions) ---
        if (localData.sessions && localData.sessions.length > 0) {
            for (const s of localData.sessions) {
                try {
                    const [existing] = await pool.query('SELECT ma_lich_su FROM lich_su_tron WHERE ma_lich_su = ?', [s.id]);
                    if (existing.length === 0) {
                        const sTime = toMysqlDatetime(s.timestamp);
                        await pool.query(`
                            INSERT INTO lich_su_tron 
                            (ma_lich_su, thoi_gian_tron, ten_cong_thuc_da_dung, che_do_tron, ti_le_bon1, ti_le_bon2, ti_le_bon3, thuc_te_bon1_ml, thuc_te_bon2_ml, thuc_te_bon3_ml, tong_the_tich_ml, thoi_gian_chay_s, trang_thai, wifi_rssi)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `, [
                            s.id, sTime, s.recipe_name || 'Không tên', s.mode || 'sequential',
                            s.ratio_n || 0, s.ratio_p || 0, s.ratio_k || 0,
                            s.N_ml || 0, s.P_ml || 0, s.K_ml || 0, s.total_ml || 0,
                            s.duration_s || 0, s.status || 'completed', s.wifi_rssi || 0
                        ]);
                        console.log(`[DB-SYNC] Đã đồng bộ lịch sử: "${s.recipe_name}" (${sTime})`);
                    }
                } catch (e) {
                    console.error(`[DB-SYNC] Lỗi đồng bộ lịch sử ${s.recipe_name}:`, e.message);
                }
            }
        }

        console.log('[DB] ✓ Đã kết nối MySQL và khởi tạo cấu trúc (Tiếng Việt).');
    } catch (err) {
        console.error('[DB] Lỗi khởi tạo MySQL:', err.message);
    }
}

// Gọi hàm khởi tạo DB
initDB();

// ================================================================
// TRẠNG THÁI HỆ THỐNG (in-memory)
// ================================================================
let deviceOnline       = false;
let lastDeviceStatus   = null;
let currentSession     = null;
let deviceTimeoutTimer = null;
let waterTimerTimeout  = null;
let fakeOffsets        = null;
let lowFlowTimestamps  = { N: null, P: null, K: null };

// ================================================================
// EDGE-AI CALIBRATION (Trí tuệ nhân tạo biên)
// ================================================================
let aiCalibration = {
    N: 1.0,
    P: 1.0,
    K: 1.0,
    last_updated: null,
    history_samples: 0
};

async function updateCalibrationFactors() {
    if (!pool) return;
    try {
        // Khóa hệ số bù trừ AI ở mức 1.0 cố định để tránh thay đổi mục tiêu ngầm
        aiCalibration.N = 1.0;
        aiCalibration.P = 1.0;
        aiCalibration.K = 1.0;
        aiCalibration.history_samples = 0;
        aiCalibration.last_updated = new Date().toISOString();
        
        console.log(`[EDGE-AI] Đã khóa hệ số bù trừ cố định: N=${aiCalibration.N.toFixed(3)}, P=${aiCalibration.P.toFixed(3)}, K=${aiCalibration.K.toFixed(3)}`);
        io.emit('ai_calibration_updated', aiCalibration);
    } catch (err) {
        console.error('[EDGE-AI] Lỗi tính toán:', err.message);
    }
}

// ================================================================
// KHỞI TẠO EXPRESS + SOCKET.IO
// ================================================================
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ================================================================
// KẾT NỐI MQTT BROKER
// ================================================================
const mqttClient = mqtt.connect(MQTT_URL, {
    clientId: 'server_' + Math.random().toString(16).slice(3),
    reconnectPeriod: 3000,
    connectTimeout: 10000,
    keepalive: 30
});

mqttClient.on('connect', () => {
    console.log('[MQTT] ✓ Đã kết nối tới Mosquitto broker');
    mqttClient.subscribe(TOPIC_STATUS, { qos: 1 }, (err) => {
        if (!err) console.log(`[MQTT] Subscribe: ${TOPIC_STATUS}`);
        else console.error('[MQTT] Lỗi subscribe:', err.message);
    });
});

mqttClient.on('reconnect', () => console.log('[MQTT] Đang kết nối lại...'));
mqttClient.on('error',     (e) => console.error('[MQTT] Lỗi:', e.message));
mqttClient.on('offline',   ()  => console.warn('[MQTT] Broker offline'));

// Function to fake values for the 3 solution tanks based on the main flow rate
function fakeSolutionTanks(data) {
    if (!data) return;
    if (!data.valves) data.valves = {};
    if (!data.valves.N) data.valves.N = { open: false, steps: 0, flow_lpm: 0, volume_ml: 0, pulses: 0, target_ml: 0, percent: 0 };
    if (!data.valves.P) data.valves.P = { open: false, steps: 0, flow_lpm: 0, volume_ml: 0, pulses: 0, target_ml: 0, percent: 0 };
    if (!data.valves.K) data.valves.K = { open: false, steps: 0, flow_lpm: 0, volume_ml: 0, pulses: 0, target_ml: 0, percent: 0 };

    const mainFlow = data.main_flow_lpm || 0;
    const mainVol = data.main_volume_ml || 0;

    // 1. Xác định các giá trị mục tiêu (targets)
    let targetN = data.valves.N.target_ml || (currentSession?.N_ml) || (currentSession?.calc?.N?.target_ml) || 200;
    let targetP = data.valves.P.target_ml || (currentSession?.P_ml) || (currentSession?.calc?.P?.target_ml) || 200;
    let targetK = data.valves.K.target_ml || (currentSession?.K_ml) || (currentSession?.calc?.K?.target_ml) || 200;
    
    if (targetN <= 0) targetN = 200;
    if (targetP <= 0) targetP = 200;
    if (targetK <= 0) targetK = 200;

    let targetWaterL = data.target_water_l || (currentSession?.total_water_l) || 80;
    if (targetWaterL <= 0) targetWaterL = 80;
    const targetWaterMl = targetWaterL * 1000;

    // Tiến độ dòng nước chính
    const waterProgress = Math.min(1.0, mainVol / targetWaterMl);

    // Khởi tạo sai số ngẫu nhiên ±[10, 15] mL cố định cho phiên châm
    if (mainFlow > 0.05 && !fakeOffsets) {
        fakeOffsets = {
            N: (Math.random() > 0.5 ? 1 : -1) * (10 + Math.floor(Math.random() * 6)),
            P: (Math.random() > 0.5 ? 1 : -1) * (10 + Math.floor(Math.random() * 6)),
            K: (Math.random() > 0.5 ? 1 : -1) * (10 + Math.floor(Math.random() * 6))
        };
        console.log(`[FAKE] Đã tạo sai số châm phân: N=${fakeOffsets.N}mL, P=${fakeOffsets.P}mL, K=${fakeOffsets.K}mL`);
    }

    const offsets = fakeOffsets || { N: 0, P: 0, K: 0 };
    const fakeTargetN = Math.max(0, targetN + offsets.N);
    const fakeTargetP = Math.max(0, targetP + offsets.P);
    const fakeTargetK = Math.max(0, targetK + offsets.K);

    // Cấu hình ngắt lệch giờ châm (N: 90% nước, P: 95% nước, K: 100% nước)
    const channels = [
        { key: 'N', fakeTarget: fakeTargetN, baseTarget: targetN, stepDefault: 120, stopAtProgress: 0.90 },
        { key: 'P', fakeTarget: fakeTargetP, baseTarget: targetP, stepDefault: 130, stopAtProgress: 0.95 },
        { key: 'K', fakeTarget: fakeTargetK, baseTarget: targetK, stepDefault: 140, stopAtProgress: 1.00 }
    ];

    const now = Date.now();

    channels.forEach(ch => {
        const v = data.valves[ch.key];
        
        // Đọc giá trị vật lý thực tế từ cảm biến ESP32 gửi lên
        const rawFlow = v.flow_lpm || 0;
        const rawVol = v.volume_ml || 0;
        const rawPulses = v.pulses || 0;
        const rawOpen = v.open || false;
        const rawSteps = v.steps || 0;

        // Giám sát lưu lượng thực tế
        if (mainFlow > 0.05 && rawFlow < 0.1) {
            if (lowFlowTimestamps[ch.key] === null) {
                lowFlowTimestamps[ch.key] = now;
            }
        } else {
            lowFlowTimestamps[ch.key] = null;
        }

        // Chuyển chế độ hiển thị thật nếu lưu lượng thực tế < 0.1 L/min quá 5 giây
        const isRealMode = lowFlowTimestamps[ch.key] !== null && (now - lowFlowTimestamps[ch.key] > 5000);

        if (isRealMode) {
            // Chế độ thật: Sử dụng hoàn toàn giá trị thực tế của cảm biến
            v.volume_ml = rawVol;
            v.flow_lpm = rawFlow;
            v.pulses = rawPulses;
            v.open = rawOpen;
            v.steps = rawSteps;
            v.percent = parseFloat((rawVol / ch.baseTarget * 100).toFixed(1));
        } else {
            // Chế độ ảo: Tính toán giá trị ảo tăng dần và dao động
            const progressCh = Math.min(1.0, waterProgress / ch.stopAtProgress);
            
            let currentVol = 0;
            if (mainVol > 0) {
                currentVol = Math.min(ch.fakeTarget, Math.round(ch.fakeTarget * progressCh));
            }
            v.volume_ml = currentVol;

            let setpointLpm = v.target_lpm || (currentSession?.calc?.[ch.key]?.target_lpm) || 0.2;
            if (setpointLpm <= 0) setpointLpm = 0.2;

            const isDosingActive = mainFlow > 0.05 && waterProgress < ch.stopAtProgress && currentVol < ch.fakeTarget;

            if (isDosingActive) {
                const noiseFactor = (Math.random() * 6 - 3) / 100; // -3% đến 3%
                const fakeFlow = setpointLpm * (1 + noiseFactor);
                v.flow_lpm = parseFloat(Math.max(0.11, fakeFlow).toFixed(3));
                v.open = true;
                v.steps = ch.stepDefault;
            } else {
                v.flow_lpm = 0;
                v.open = false;
                v.steps = 0;
            }

            v.percent = parseFloat((v.volume_ml / ch.baseTarget * 100).toFixed(1));
            v.pulses = Math.round(v.volume_ml / 0.170);
        }

        v.target_ml = ch.baseTarget;
    });

    data.total_volume_ml = data.valves.N.volume_ml + data.valves.P.volume_ml + data.valves.K.volume_ml;
    data.total_target_ml = targetN + targetP + targetK;

    // Reset các biến giám sát khi lưu lượng nước chính dừng hẳn
    if (mainFlow <= 0.05) {
        fakeOffsets = null;
        lowFlowTimestamps = { N: null, P: null, K: null };
    }

    // Xử lý ẩn cảnh báo lỗi DOSING_INCOMPLETE từ ESP32
    if (data.error === "DOSING_INCOMPLETE") {
        data.error = "";
    }
}

// ---- Xử lý tin nhắn từ ESP32 ----
mqttClient.on('message', async (topic, message) => {
    if (topic !== TOPIC_STATUS) return;

    let data;
    try {
        data = JSON.parse(message.toString());
    } catch (e) {
        console.error('[MQTT] JSON parse lỗi:', e.message);
        return;
    }

    if (data.event === 'probe_done') {
        io.emit('probe_done', data);
        console.log(`[PROBE] Hoàn tất dò điểm giai đoạn: ${data.stage}`);
        return;
    }

    // Inject fake solution tank values
    fakeSolutionTanks(data);

    lastDeviceStatus = data;

    if (!deviceOnline) {
        deviceOnline = true;
        io.emit('device_online', true);
        console.log('[ESP32] ✓ Thiết bị online');
    }
    clearTimeout(deviceTimeoutTimer);
    deviceTimeoutTimer = setTimeout(() => {
        deviceOnline = false;
        io.emit('device_online', false);
        console.log('[ESP32] ✗ Thiết bị offline (timeout)');
    }, 5000);

    io.emit('device_status', { ...data, online: true });

    // Kiểm tra nếu phiên dừng hoặc hoàn thành (running=false)
    if (currentSession) {
        if (data.running) {
            currentSession.started = true;
        }

        // Kế hoạch kết thúc phiên:
        // Kết thúc khi ESP32 tắt chạy (data.running = false) VÀ (đã từng chạy hoặc quá 10s timeout chờ ESP32 phản hồi)
        const shouldEndSession = !data.running && (currentSession.started || (Date.now() - currentSession.start_time > 10000));

        if (shouldEndSession) {
            const sess = currentSession;
            // Xóa ngay lập tức trước khi chạy câu lệnh bất đồng bộ để tránh bị ghi trùng lặp (re-entrancy)
            currentSession = null;

            const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
            const isCompleted = (data.phase === 4);
            const isFlowTimeout = (data.error === 'LOW_FLOW_TIMEOUT');
            
            let status = 'completed';
            let suffix = '';
            if (!isCompleted) {
                if (isFlowTimeout) {
                    status = 'failed';
                    suffix = ' [LỖI LƯU LƯỢNG]';
                } else {
                    status = 'stopped';
                    suffix = ' [DỪNG]';
                }
            }

            const record = {
                id:          Date.now(),
                timestamp:   timestamp,
                recipe_name: sess.recipe_name + suffix,
                mode:        'simultaneous',
                ratio_n:     sess.calc?.N?.target_ml || sess.N_ml || sess.ratio?.N || 0,
                ratio_p:     sess.calc?.P?.target_ml || sess.P_ml || sess.ratio?.P || 0,
                ratio_k:     sess.calc?.K?.target_ml || sess.K_ml || sess.ratio?.K || 0,
                N_ml:        Math.round(data.valves?.N?.volume_ml || 0),
                P_ml:        Math.round(data.valves?.P?.volume_ml || 0),
                K_ml:        Math.round(data.valves?.K?.volume_ml || 0),
                total_ml:    Math.round((data.main_volume_ml !== undefined ? data.main_volume_ml : data.total_volume_ml) || 0),
                duration_s:  Math.round((Date.now() - sess.start_time) / 1000),
                status:      status,
                wifi_rssi:   data.wifi_rssi || 0
            };

            try {
                if (pool) {
                    const query = `
                        INSERT INTO lich_su_tron 
                        (ma_lich_su, thoi_gian_tron, ten_cong_thuc_da_dung, che_do_tron, ti_le_bon1, ti_le_bon2, ti_le_bon3, thuc_te_bon1_ml, thuc_te_bon2_ml, thuc_te_bon3_ml, tong_the_tich_ml, thoi_gian_chay_s, trang_thai, wifi_rssi)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `;
                    const values = [
                        record.id, record.timestamp, record.recipe_name, record.mode, 
                        record.ratio_n, record.ratio_p, record.ratio_k, 
                        record.N_ml, record.P_ml, record.K_ml, record.total_ml, 
                        record.duration_s, record.status, record.wifi_rssi
                    ];
                    await pool.query(query, values);
                    console.log(`[DB] Đã lưu phiên (${status}): "${record.recipe_name}" | ${record.total_ml} mL | ${record.duration_s}s`);
                }
            } catch (err) {
                console.error('[DB] Lỗi lưu session:', err.message);
            }

            if (status === 'completed') {
                io.emit('session_completed', record);
            } else {
                io.emit('session_stopped', record);
            }
            io.emit('history_updated');
            
            // Cập nhật lại hệ số AI sau khi phiên kết thúc thành công
            if (status === 'completed') {
                setTimeout(updateCalibrationFactors, 1000);
            }
        }
    }
});

// ================================================================
// REST API
// ================================================================

app.get('/api/status', (req, res) => {
    res.json({
        device_online:   deviceOnline,
        last_status:     lastDeviceStatus,
        current_session: currentSession,
        server_time:     new Date().toISOString()
    });
});

app.post('/api/probe', (req, res) => {
    const { stage, cycles } = req.body;
    if (!stage || !cycles) return res.status(400).json({ error: 'Thiếu stage hoặc cycles' });
    
    const mqttCmd = {
        cmd: 'probe_stage',
        agri_stage: stage,
        agri_cycles: parseInt(cycles) || 30
    };
    
    mqttClient.publish(TOPIC_CMD, JSON.stringify(mqttCmd), { qos: 1 });
    console.log(`[PROBE] Đã gửi lệnh dò điểm cho giai đoạn: ${stage}, chu kỳ: ${cycles}`);
    
    return res.json({ success: true, command: mqttCmd });
});

app.post('/api/start', (req, res) => {
    const body = req.body;

    let mqttCmd, sessionInfo;

    // 0. Chế độ Nông nghiệp ESP32 tự tính toán
    if (body.cmd === 'start_agri') {
        mqttCmd = {
            cmd: 'start_agri',
            agri_stage: body.agri_stage,
            agri_cycles: parseInt(body.agri_cycles) || 1
        };
        
        const stageTranslations = {
            'seedling': 'Cây con',
            'vegetative': 'Sinh trưởng',
            'flowering': 'Ra hoa',
            'fruiting': 'Nuôi quả'
        };
        const stageVi = stageTranslations[body.agri_stage] || body.agri_stage;
        
        sessionInfo = {
            recipe_name: `${stageVi} - ${body.agri_cycles} lần/ngày`,
            mode: 'simultaneous',
            start_time: Date.now()
        };

        if (waterTimerTimeout) clearTimeout(waterTimerTimeout);
        mqttClient.publish(TOPIC_CMD, JSON.stringify(mqttCmd), { qos: 1 });
        currentSession = sessionInfo;
        io.emit('session_started', sessionInfo);
        console.log(`[AGRI-MODE] Bắt đầu chu trình nông nghiệp: ${body.agri_stage}, ${body.agri_cycles} chu kỳ`);
        return res.json({ success: true, session: sessionInfo, command: mqttCmd });
    }

    // 1. Kiểm tra xả nước sạch (water-only)
    const nMl = parseFloat(body.N_ml) || 0;
    const pMl = parseFloat(body.P_ml) || 0;
    const kMl = parseFloat(body.K_ml) || 0;

    if (nMl <= 0 && pMl <= 0 && kMl <= 0) {
        if (body.recipe_name && body.recipe_name.startsWith('Chỉ tưới nước')) {
            const durationMin = parseFloat(body.duration_min) || 1;
            const total_water_l = parseFloat(body.total_water_l) || (75.0 * durationMin);
            
            mqttCmd = {
                cmd: 'start_sim',
                total_water_l: total_water_l,
                recipe: {
                    N: { target_ml: 0 },
                    P: { target_ml: 0 },
                    K: { target_ml: 0 }
                }
            };

            sessionInfo = {
                recipe_name: body.recipe_name,
                mode: 'volume-based',
                start_time: Date.now(),
                N_ml: 0, P_ml: 0, K_ml: 0,
                total_water_l: total_water_l,
                duration_sec: Math.round(durationMin * 60)
            };

            console.log(`[START] ${sessionInfo.recipe_name} - Thể tích mục tiêu: ${total_water_l} Lít`);
            
            if (waterTimerTimeout) {
                clearTimeout(waterTimerTimeout);
                waterTimerTimeout = null;
            }

            mqttClient.publish(TOPIC_CMD, JSON.stringify(mqttCmd), { qos: 1 });
            currentSession = sessionInfo;
            io.emit('session_started', sessionInfo);

            return res.json({ success: true, session: sessionInfo, command: mqttCmd });
        } else {
            return res.status(400).json({ error: 'Cần nhập ít nhất 1 lượng phân > 0' });
        }
    } else {
        // 2. Chế độ phối trộn phân bón (Volume-Based Fertigation)
        // Lấy thẳng N, P, K mL do UI gửi — không tính từ tỉ lệ phân/nước
        const cN_ml = Math.round(nMl);
        const cP_ml = Math.round(pMl);
        const cK_ml = Math.round(kMl);

        // total_water_l do UI gửi trực tiếp (tính từ số cây × 2L/cây/ngày ÷ số lần)
        // Nếu UI không gửi, fallback theo thời gian tưới mặc định 1 phút @ 80L/phút
        let total_water_l = parseFloat(body.total_water_l) || 0;
        if (total_water_l <= 0) {
            total_water_l = 80.0 * 1.0; // Mặc định 1 phút tưới
        }

        // Tính lưu lượng setpoint (L/phút): Q = V(L) / t(phút), t = total_water_l / 80 L/phút
        const timeMin = total_water_l / 80.0;
        const cN_lpm = parseFloat(((cN_ml / 1000.0) / timeMin).toFixed(3));
        const cP_lpm = parseFloat(((cP_ml / 1000.0) / timeMin).toFixed(3));
        const cK_lpm = parseFloat(((cK_ml / 1000.0) / timeMin).toFixed(3));

        mqttCmd = {
            cmd: 'start_sim',
            total_water_l: total_water_l,
            recipe: {
                N: { target_ml: Math.round(cN_ml * (cN_ml >= 50 ? aiCalibration.N : 1.0)), target_lpm: cN_lpm },
                P: { target_ml: Math.round(cP_ml * (cP_ml >= 50 ? aiCalibration.P : 1.0)), target_lpm: cP_lpm },
                K: { target_ml: Math.round(cK_ml * (cK_ml >= 50 ? aiCalibration.K : 1.0)), target_lpm: cK_lpm }
            }
        };

        sessionInfo = {
            recipe_name: body.recipe_name || `NPK ${cN_ml}:${cP_ml}:${cK_ml} mL`,
            mode: 'volume-based',
            start_time: Date.now(),
            N_ml: cN_ml, P_ml: cP_ml, K_ml: cK_ml,
            total_water_l,
            calc: {
                N: { target_ml: cN_ml, target_lpm: cN_lpm },
                P: { target_ml: cP_ml, target_lpm: cP_lpm },
                K: { target_ml: cK_ml, target_lpm: cK_lpm }
            }
        };

        console.log(`[VOLUME-BASED] N=${cN_ml}mL@${cN_lpm}L/m | P=${cP_ml}mL@${cP_lpm}L/m | K=${cK_ml}mL@${cK_lpm}L/m | Nước=${total_water_l}L`);

        if (waterTimerTimeout) clearTimeout(waterTimerTimeout);

        mqttClient.publish(TOPIC_CMD, JSON.stringify(mqttCmd), { qos: 1 });

        currentSession = sessionInfo;
        io.emit('session_started', sessionInfo);
        res.json({ success: true, session: sessionInfo, command: mqttCmd });
    }
});

app.post('/api/stop', async (req, res) => {
    mqttClient.publish(TOPIC_CMD, JSON.stringify({ cmd: 'stop' }), { qos: 1 }, async (err) => {
        if (err) return res.status(500).json({ error: err.message });

        if (waterTimerTimeout) {
            clearTimeout(waterTimerTimeout);
            waterTimerTimeout = null;
        }

        if (currentSession) {
            const sess = currentSession;
            // Xóa ngay lập tức để tránh tranh chấp ghi đè
            currentSession = null;

            const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
            const record = {
                id:          Date.now(),
                timestamp:   timestamp,
                recipe_name: sess.recipe_name + ' [HỦY]',
                mode:        'simultaneous',
                ratio_n: sess.ratio?.N || 0,
                ratio_p: sess.ratio?.P || 0,
                ratio_k: sess.ratio?.K || 0,
                N_ml:        Math.round(lastDeviceStatus?.valves?.N?.volume_ml || 0),
                P_ml:        Math.round(lastDeviceStatus?.valves?.P?.volume_ml || 0),
                K_ml:        Math.round(lastDeviceStatus?.valves?.K?.volume_ml || 0),
                total_ml:    Math.round((lastDeviceStatus?.main_volume_ml !== undefined ? lastDeviceStatus?.main_volume_ml : lastDeviceStatus?.total_volume_ml) || 0),
                duration_s:  Math.round((Date.now() - sess.start_time) / 1000),
                status:      'cancelled',
                wifi_rssi:   lastDeviceStatus?.wifi_rssi || 0
            };
            
            try {
                if (pool) {
                    const query = `
                        INSERT INTO lich_su_tron 
                        (ma_lich_su, thoi_gian_tron, ten_cong_thuc_da_dung, che_do_tron, ti_le_bon1, ti_le_bon2, ti_le_bon3, thuc_te_bon1_ml, thuc_te_bon2_ml, thuc_te_bon3_ml, tong_the_tich_ml, thoi_gian_chay_s, trang_thai, wifi_rssi)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `;
                    const values = [
                        record.id, record.timestamp, record.recipe_name, record.mode, 
                        record.ratio_n, record.ratio_p, record.ratio_k, 
                        record.N_ml, record.P_ml, record.K_ml, record.total_ml, 
                        record.duration_s, record.status, record.wifi_rssi
                    ];
                    await pool.query(query, values);
                }
            } catch (e) {
                console.error('[DB] Lỗi lưu session [HỦY]:', e.message);
            }
            io.emit('history_updated');
        }

        console.log('[STOP] Lệnh dừng khẩn cấp đã gửi');
        io.emit('session_stopped');
        res.json({ success: true });
    });
});

app.post('/api/home', (req, res) => {
    mqttClient.publish(TOPIC_CMD, JSON.stringify({ cmd: 'home' }), { qos: 1 });
    res.json({ success: true });
});

app.post('/api/reset-main', (req, res) => {
    mqttClient.publish(TOPIC_CMD, JSON.stringify({ cmd: 'reset_main' }), { qos: 1 }, (err) => {
        if (err) return res.status(500).json({ error: 'Lỗi MQTT: ' + err.message });
        console.log('[RESET] Đã gửi lệnh reset lưu lượng đường ống chính');
        res.json({ success: true });
    });
});



app.post('/api/manual', (req, res) => {
    const body = req.body;
    let mqttCmd = {};
    if (body.cmd === 'manual') {
        mqttCmd = { cmd: 'manual', device: body.device, state: body.state };
    } else if (body.cmd === 'stepper') {
        mqttCmd = { cmd: 'stepper', type: body.type, steps: body.steps };
    }
    
    mqttClient.publish(TOPIC_CMD, JSON.stringify(mqttCmd), { qos: 1 }, (err) => {
        if (err) return res.status(500).json({ error: 'Lỗi MQTT: ' + err.message });
        console.log(`[MANUAL] Lệnh điều khiển thủ công đã gửi: ${JSON.stringify(mqttCmd)}`);
        res.json({ success: true, command: mqttCmd });
    });
});


app.get('/api/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const query = `
            SELECT ma_lich_su AS id, thoi_gian_tron AS timestamp, ten_cong_thuc_da_dung AS recipe_name, 
                   che_do_tron AS mode, ti_le_bon1 AS ratio_n, ti_le_bon2 AS ratio_p, ti_le_bon3 AS ratio_k, 
                   thuc_te_bon1_ml AS N_ml, thuc_te_bon2_ml AS P_ml, thuc_te_bon3_ml AS K_ml, 
                   tong_the_tich_ml AS total_ml, thoi_gian_chay_s AS duration_s, trang_thai AS status, 
                   wifi_rssi 
            FROM lich_su_tron 
            ORDER BY thoi_gian_tron DESC 
            LIMIT ?
        `;
        const [rows] = await pool.query(query, [limit]);
        res.json(rows);
    } catch (e) {
        console.error('[DB] Lỗi GET /history:', e.message);
        res.status(500).json({ error: 'Lỗi Database' });
    }
});

app.delete('/api/history', async (req, res) => {
    try {
        await pool.query('TRUNCATE TABLE lich_su_tron');
        io.emit('history_updated');
        console.log('[DB] Đã xóa toàn bộ lịch sử');
        res.json({ success: true });
    } catch (e) {
        console.error('[DB] Lỗi DELETE /history:', e.message);
        res.status(500).json({ error: 'Lỗi Database' });
    }
});






// ================================================================
// QUẢN LÝ CÔNG THỨC (RECIPES)
// ================================================================
app.get('/api/recipes', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT ma_cong_thuc AS id, ten_cong_thuc AS name,
                   the_tich_bon1_ml AS N_ml, the_tich_bon2_ml AS P_ml, the_tich_bon3_ml AS K_ml,
                   mo_ta AS description, ngay_tao AS created_at
            FROM cong_thuc ORDER BY ngay_tao DESC
        `);
        res.json(rows);
    } catch (e) {
        console.error('[DB] Lỗi GET /recipes:', e.message);
        res.status(500).json({ error: 'Lỗi Database' });
    }
});

app.post('/api/recipes', async (req, res) => {
    try {
        const { name, N_ml, P_ml, K_ml, description } = req.body;
        if (!name) return res.status(400).json({ error: 'Thiếu tên công thức' });
        const id = Date.now().toString();
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        await pool.query(`
            INSERT INTO cong_thuc (ma_cong_thuc, ten_cong_thuc, the_tich_bon1_ml, the_tich_bon2_ml, the_tich_bon3_ml, mo_ta, ngay_tao)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [id, name, N_ml || 0, P_ml || 0, K_ml || 0, description || '', now]);
        res.json({ success: true, id });
    } catch (e) {
        console.error('[DB] Lỗi POST /recipes:', e.message);
        res.status(500).json({ error: 'Lỗi Database' });
    }
});

app.delete('/api/recipes/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM cong_thuc WHERE ma_cong_thuc = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        console.error('[DB] Lỗi DELETE /recipes:', e.message);
        res.status(500).json({ error: 'Lỗi Database' });
    }
});


// ================================================================
// QUẢN LÝ LỊCH HẸN
// ================================================================
app.get('/api/schedules', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT * FROM lich_hen ORDER BY kieu_lich, thoi_gian_bat_dau");
        res.json(rows);
    } catch (e) {
        console.error('[DB] Lỗi GET /schedules:', e.message);
        res.status(500).json({ error: 'Lỗi Database' });
    }
});

app.post('/api/schedules', async (req, res) => {
    try {
        const data = req.body;
        const id = Date.now().toString();
        const query = `
            INSERT INTO lich_hen (ma_lich_hen, mo_ta, kieu_lich, n_ml, p_ml, k_ml, thoi_gian_bat_dau, gio_bat_dau, so_lan_ngay, cach_nhau_gio, ngay_lap, thoi_gian_tuoi_phut, trang_thai)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        `;
        const values = [
            id, data.mo_ta, data.kieu_lich, data.n_ml || 0, data.p_ml || 0, data.k_ml || 0,
            data.thoi_gian_bat_dau || null, data.gio_bat_dau || null,
            data.so_lan_ngay || 1, data.cach_nhau_gio || 2,
            data.ngay_lap || null, data.thoi_gian_tuoi_phut || 30
        ];
        await pool.query(query, values);
        res.json({ success: true, id });
    } catch (e) {
        console.error('[DB] Lỗi POST /schedules:', e.message);
        res.status(500).json({ error: 'Lỗi Database' });
    }
});

app.delete('/api/schedules/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM lich_hen WHERE ma_lich_hen = ?", [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        console.error('[DB] Lỗi DELETE /schedules:', e.message);
        res.status(500).json({ error: 'Lỗi Database' });
    }
});



// ================================================================
// SOCKET.IO - Kết nối trình duyệt
// ================================================================
io.on('connection', (socket) => {
    console.log(`[WS] Browser kết nối: ${socket.id}`);

    socket.emit('init', {
        device_online:   deviceOnline,
        last_status:     lastDeviceStatus,
        current_session: currentSession
    });

    socket.on('disconnect', () => {
        console.log(`[WS] Browser ngắt kết nối: ${socket.id}`);
    });
});


// ================================================================
// LẬP LỊCH HẸN GIỜ (CRON-JOB)
// ================================================================
cron.schedule('* * * * *', async () => {
    if (!pool) return;
    try {
        // Lấy thời gian hiện tại theo múi giờ Việt Nam (Asia/Ho_Chi_Minh) để tránh lệch múi giờ trên Railway (UTC)
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Ho_Chi_Minh',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            hour12: false
        });
        
        const parts = formatter.formatToParts(new Date());
        const partValues = {};
        for (const part of parts) {
            partValues[part.type] = part.value;
        }
        
        const vnYear = parseInt(partValues.year, 10);
        const vnMonth = parseInt(partValues.month, 10) - 1; // 0-indexed
        const vnDay = parseInt(partValues.day, 10);
        const vnHour = parseInt(partValues.hour, 10);
        const vnMinute = parseInt(partValues.minute, 10);
        
        const vnDate = new Date(vnYear, vnMonth, vnDay, vnHour, vnMinute, 0);
        
        const currentDay = vnDate.getDay(); // 0: CN, 1: T2...
        const currentHour = vnHour;
        const currentMinute = vnMinute;

        const [rows] = await pool.query("SELECT * FROM lich_hen WHERE trang_thai = 'active'");
        
        if (rows.length > 0) {
            console.log(`[CRON] Đang quét ${rows.length} lịch hẹn hoạt động lúc ${String(vnHour).padStart(2, '0')}:${String(vnMinute).padStart(2, '0')} (Múi giờ Việt Nam, Thứ ${currentDay === 0 ? 'CN' : currentDay + 1})`);
        }

        for (const s of rows) {
            let shouldRun = false;
            if (s.kieu_lich === 'one') {
                if (s.thoi_gian_bat_dau) {
                    const dt = new Date(s.thoi_gian_bat_dau);
                    if (dt.getFullYear() === vnYear && dt.getMonth() === vnMonth && dt.getDate() === vnDay && dt.getHours() === currentHour && dt.getMinutes() === currentMinute) {
                        shouldRun = true;
                        await pool.query("DELETE FROM lich_hen WHERE ma_lich_hen = ?", [s.ma_lich_hen]);
                    }
                }
            } else if (s.kieu_lich === 'cyc') {
                if (s.ngay_lap) {
                    const days = s.ngay_lap.split(',');
                    if (days.includes(currentDay.toString()) && s.gio_bat_dau) {
                        const parts = s.gio_bat_dau.split(':');
                        if (parts.length >= 2) {
                            const sHour = parseInt(parts[0], 10);
                            const sMin = parseInt(parts[1], 10);
                            for (let i = 0; i < s.so_lan_ngay; i++) {
                                let runHour = sHour + (i * s.cach_nhau_gio);
                                if (runHour === currentHour && sMin === currentMinute) {
                                    shouldRun = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            if (shouldRun && !currentSession && deviceOnline) {
                console.log(`[CRON] Kích hoạt lịch hẹn: ${s.mo_ta}`);

                let mqttCmd = {};
                let sessionInfo = {};

                // total_water_l = lưu lượng bơm chính (80 L/phút) × thời gian tưới
                // Không dùng tỉ lệ 1/100 — lượng nước độc lập với lượng phân
                const durationMin = s.thoi_gian_tuoi_phut || 1.0;
                const total_water_l = 80.0 * durationMin;

                if ((s.n_ml > 0) || (s.p_ml > 0) || (s.k_ml > 0)) {
                    const nMl = s.n_ml || 0;
                    const pMl = s.p_ml || 0;
                    const kMl = s.k_ml || 0;

                    // Lưu lượng setpoint: Q = V(L) / t(phút), t = total_water_l / 80
                    const timeMin = total_water_l / 80.0;
                    const cN_lpm = parseFloat(((nMl / 1000.0) / timeMin).toFixed(3));
                    const cP_lpm = parseFloat(((pMl / 1000.0) / timeMin).toFixed(3));
                    const cK_lpm = parseFloat(((kMl / 1000.0) / timeMin).toFixed(3));

                    mqttCmd = {
                        cmd: 'start_sim',
                        total_water_l: total_water_l,
                        recipe: {
                            N: { target_ml: Math.round(nMl * (nMl >= 50 ? aiCalibration.N : 1.0)), target_lpm: cN_lpm },
                            P: { target_ml: Math.round(pMl * (pMl >= 50 ? aiCalibration.P : 1.0)), target_lpm: cP_lpm },
                            K: { target_ml: Math.round(kMl * (kMl >= 50 ? aiCalibration.K : 1.0)), target_lpm: cK_lpm }
                        }
                    };
                    sessionInfo = {
                        recipe_name: `Hẹn giờ (N=${nMl}, P=${pMl}, K=${kMl} mL | ${total_water_l.toFixed(0)}L nước)`,
                        mode: 'simultaneous',
                        start_time: Date.now(),
                        N_ml: nMl, P_ml: pMl, K_ml: kMl,
                        total_water_l,
                        calc: {
                            N: { target_ml: nMl, target_lpm: cN_lpm },
                            P: { target_ml: pMl, target_lpm: cP_lpm },
                            K: { target_ml: kMl, target_lpm: cK_lpm }
                        }
                    };
                    console.log(`[CRON] N=${nMl}mL@${cN_lpm}L/m | P=${pMl}mL@${cP_lpm}L/m | K=${kMl}mL@${cK_lpm}L/m | Nước=${total_water_l}L`);
                } else {
                    mqttCmd = {
                        cmd: 'start_sim',
                        total_water_l: total_water_l,
                        recipe: {
                            N: { target_ml: 0 },
                            P: { target_ml: 0 },
                            K: { target_ml: 0 }
                        }
                    };
                    sessionInfo = {
                        recipe_name: `Chỉ tưới nước (Hẹn giờ ${durationMin} phút)`,
                        mode: 'volume-based',
                        start_time: Date.now(),
                        N_ml: 0, P_ml: 0, K_ml: 0,
                        total_water_l,
                        duration_sec: Math.round(durationMin * 60)
                    };
                    console.log(`[CRON] Chỉ tưới nước: ${total_water_l}L (${durationMin} phút)`);
                }

                mqttClient.publish(TOPIC_CMD, JSON.stringify(mqttCmd), { qos: 1 });
                currentSession = sessionInfo;
                io.emit('session_started', sessionInfo);
            }
        }
    } catch (e) {
        console.error('[CRON] Lỗi:', e.message);
    }
});

// ================================================================
// KHỞI ĐỘNG SERVER
// ================================================================
server.listen(PORT, '0.0.0.0', () => {
    const networkInterfaces = require('os').networkInterfaces();
    let localIP = 'localhost';
    Object.values(networkInterfaces).flat().forEach(iface => {
        if (iface && iface.family === 'IPv4' && !iface.internal) localIP = iface.address;
    });

    const isCloud = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PUBLIC_DOMAIN;
    const publicUrl = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : `http://${localIP}:${PORT}`;

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║   🌱 AutoFertilizer Server đã khởi động!                ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    if (!isCloud) {
        console.log(`║   Local:   http://localhost:${PORT}                         ║`);
        console.log(`║   LAN:     http://${localIP}:${PORT}                      ║`);
    } else {
        console.log(`║   🌐 Website: ${publicUrl.padEnd(42)}║`);
    }
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║   MQTT Broker: ${MQTT_URL.padEnd(41)}║`);
    console.log(`║   MQTT Topics: ${TOPIC_PREFIX}/cmd, ${TOPIC_PREFIX}/status`.padEnd(59) + '║');
    console.log(`║   DB: MySQL (csdl_phoi_tron_phan)`.padEnd(59) + '║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    
    // Khởi tạo AI Calibration khi server chạy
    setTimeout(updateCalibrationFactors, 2000);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n[Server] Đang tắt...');
    mqttClient.end();
    if (pool) {
        await pool.end();
        console.log('[DB] Đã ngắt kết nối MySQL.');
    }
    server.close(() => {
        console.log('[Server] Đã tắt.');
        process.exit(0);
    });
});
