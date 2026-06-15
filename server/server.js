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

        // 5b. Tạo bảng lich_su_hieu_chinh (Phiên bản chu kỳ tự động lưu thể tích, xung, tốc độ trung bình)
        try {
            const [columns] = await pool.query('SHOW COLUMNS FROM lich_su_hieu_chinh');
            const colNames = columns.map(c => c.Field.toLowerCase());
            if (!colNames.includes('xung')) {
                console.log('[DB] Phát hiện cấu trúc cũ của bảng lich_su_hieu_chinh. Đang tự động nâng cấp sang phiên bản chu kỳ...');
                await pool.query('DROP TABLE IF EXISTS lich_su_hieu_chinh');
            }
        } catch (e) {
            // Bảng chưa tồn tại, bỏ qua lỗi để tạo mới bên dưới
        }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS lich_su_hieu_chinh (
                id INT AUTO_INCREMENT PRIMARY KEY,
                thoi_gian DATETIME NOT NULL,
                chu_ky VARCHAR(50) NOT NULL,
                cam_bien VARCHAR(50) NOT NULL,
                the_tich_ml FLOAT NOT NULL,
                xung INT NOT NULL,
                luu_luong_tb_lpm FLOAT NOT NULL,
                thoi_gian_chay_s INT NOT NULL,
                ghi_chu TEXT
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
            const isFlowTimeout = (data.error === 'FLOW_TIMEOUT');
            
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
                mode:        sess.mode || 'sequential',
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

app.post('/api/start', (req, res) => {
    const body = req.body;

    let mqttCmd, sessionInfo;

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
        const ratioN = parseFloat(body.ratio_N) !== undefined ? parseFloat(body.ratio_N) : nMl;
        const ratioP = parseFloat(body.ratio_P) !== undefined ? parseFloat(body.ratio_P) : pMl;
        const ratioK = parseFloat(body.ratio_K) !== undefined ? parseFloat(body.ratio_K) : kMl;
        
        let total_liter = parseFloat(body.total_vol_l) || 0;
        if (total_liter <= 0) {
            total_liter = (nMl + pMl + kMl) / 1000;
        }
        
        let total_water_l = parseFloat(body.total_water_l) || 0;
        if (total_water_l <= 0) {
            total_water_l = (nMl + pMl + kMl) / 10.0; // Tỉ lệ 1/100 chuẩn
        }

        if (ratioN + ratioP + ratioK <= 0)
            return res.status(400).json({ error: 'Tổng tỉ lệ phải > 0' });

        const totalParts = ratioN + ratioP + ratioK;

        const calc = (ratio, directMl) => ({
            pct:        (ratio / totalParts) * 100,
            target_ml:  directMl > 0 ? Math.round(directMl) : Math.round((ratio / totalParts) * total_liter * 1000)
        });

        const cN = calc(ratioN, nMl);
        const cP = calc(ratioP, pMl);
        const cK = calc(ratioK, kMl);

        mqttCmd = {
            cmd: 'start_sim',
            total_water_l: total_water_l,
            recipe: {
                N: { target_ml: Math.round(cN.target_ml * (cN.target_ml >= 50 ? aiCalibration.N : 1.0)) },
                P: { target_ml: Math.round(cP.target_ml * (cP.target_ml >= 50 ? aiCalibration.P : 1.0)) },
                K: { target_ml: Math.round(cK.target_ml * (cK.target_ml >= 50 ? aiCalibration.K : 1.0)) }
            }
        };

        sessionInfo = {
            recipe_name: body.recipe_name || `Tỉ lệ ${ratioN}:${ratioP}:${ratioK} (Volume-Based)`,
            mode: 'volume-based',
            start_time: Date.now(),
            ratio: { N: ratioN, P: ratioP, K: ratioK },
            total_liter, total_water_l,
            calc: { N: cN, P: cP, K: cK }
        };

        console.log(`[VOLUME-BASED] Bắt đầu chu trình Mục tiêu Nước: ${total_water_l}L | ${sessionInfo.recipe_name}`);
        
        // --- GIAO QUYỀN ĐIỀU KHIỂN CHO ESP32 ---
        // Server chỉ việc gửi lệnh, việc bật bơm, tự ngắt theo lít nước sẽ do ESP32 lo hoàn toàn!
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
                mode:        sess.mode || 'sequential',
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

app.get('/api/ai-calibration', (req, res) => {
    res.json(aiCalibration);
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
// QUẢN LÝ LỊCH SỬ HIỆU CHUẨN CẢM BIẾN & CHẠY THỬ
// ================================================================

let calibrationRun = {
    active: false,
    startTime: null,
    startValues: { N: 0, P: 0, K: 0, Main: 0 },
    cycleId: null,
    timer: null
};

app.post('/api/calibration/start-run', (req, res) => {
    if (calibrationRun.active) {
        return res.status(400).json({ error: 'Đang có một chu kỳ hiệu chuẩn chạy thử hoạt động' });
    }
    
    if (calibrationRun.timer) {
        clearTimeout(calibrationRun.timer);
    }
    
    // Bật van điện từ chính trước
    mqttClient.publish(TOPIC_CMD, JSON.stringify({ cmd: 'manual', device: 'main_valve', state: 1 }), { qos: 1 });
    
    calibrationRun.active = true;
    calibrationRun.startTime = Date.now() + 5000; // Bơm sẽ bật sau 5 giây
    calibrationRun.cycleId = 'C' + Date.now().toString().slice(-6);
    calibrationRun.startValues = {
        N: lastDeviceStatus?.valves?.N?.volume_ml || 0,
        P: lastDeviceStatus?.valves?.P?.volume_ml || 0,
        K: lastDeviceStatus?.valves?.K?.volume_ml || 0,
        Main: lastDeviceStatus?.main_volume_ml || lastDeviceStatus?.total_volume_ml || 0
    };
    calibrationRun.startPulses = {
        N: lastDeviceStatus?.valves?.N?.pulses || 0,
        P: lastDeviceStatus?.valves?.P?.pulses || 0,
        K: lastDeviceStatus?.valves?.K?.pulses || 0,
        Main: lastDeviceStatus?.main_pulses || 0
    };
    
    console.log(`[CALIBRATION] Đang mở van chính, chờ 5 giây trước khi kích hoạt bơm...`);
    
    calibrationRun.timer = setTimeout(() => {
        mqttClient.publish(TOPIC_CMD, JSON.stringify({ cmd: 'manual', device: 'pump', state: 1 }), { qos: 1 });
        console.log(`[CALIBRATION] Đã kích hoạt bơm cho chu kỳ: ${calibrationRun.cycleId}`);
        
        // Tự động tắt bơm sau 15s chạy thực tế (phòng trường hợp client không gọi stop-run)
        calibrationRun.timer = setTimeout(() => {
            mqttClient.publish(TOPIC_CMD, JSON.stringify({ cmd: 'manual', device: 'pump', state: 0 }), { qos: 1 });
            mqttClient.publish(TOPIC_CMD, JSON.stringify({ cmd: 'manual', device: 'main_valve', state: 0 }), { qos: 1 });
            console.log(`[CALIBRATION] Đã TỰ ĐỘNG tắt bơm và van sau đúng 15s cho chu kỳ: ${calibrationRun.cycleId}`);
            calibrationRun.timer = null;
        }, 15000);
    }, 5000);
    
    res.json({ success: true, cycleId: calibrationRun.cycleId });
});

app.post('/api/calibration/stop-run', async (req, res) => {
    if (calibrationRun.timer) {
        clearTimeout(calibrationRun.timer);
        calibrationRun.timer = null;
    }
    
    // Tắt bơm và van chính ngay lập tức
    mqttClient.publish(TOPIC_CMD, JSON.stringify({ cmd: 'manual', device: 'pump', state: 0 }), { qos: 1 });
    mqttClient.publish(TOPIC_CMD, JSON.stringify({ cmd: 'manual', device: 'main_valve', state: 0 }), { qos: 1 });
    
    if (calibrationRun.active) {
        calibrationRun.active = false;
        const endTime = Date.now();
        const duration_s = Math.max(1, Math.round((endTime - calibrationRun.startTime) / 1000));
        
        const endValues = {
            N: lastDeviceStatus?.valves?.N?.volume_ml || 0,
            P: lastDeviceStatus?.valves?.P?.volume_ml || 0,
            K: lastDeviceStatus?.valves?.K?.volume_ml || 0,
            Main: lastDeviceStatus?.main_volume_ml || lastDeviceStatus?.total_volume_ml || 0
        };
        
        const endPulses = {
            N: lastDeviceStatus?.valves?.N?.pulses || 0,
            P: lastDeviceStatus?.valves?.P?.pulses || 0,
            K: lastDeviceStatus?.valves?.K?.pulses || 0,
            Main: lastDeviceStatus?.main_pulses || 0
        };
        
        const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const cycleId = calibrationRun.cycleId;
        
        const diffN = Math.max(0, endValues.N - calibrationRun.startValues.N);
        const diffP = Math.max(0, endValues.P - calibrationRun.startValues.P);
        const diffK = Math.max(0, endValues.K - calibrationRun.startValues.K);
        const diffMain = Math.max(0, endValues.Main - calibrationRun.startValues.Main);

        const results = {
            N: { volume_ml: diffN, pulses: Math.max(0, endPulses.N - (calibrationRun.startPulses?.N || 0)) || Math.round(diffN / 0.170) },
            P: { volume_ml: diffP, pulses: Math.max(0, endPulses.P - (calibrationRun.startPulses?.P || 0)) || Math.round(diffP / 0.170) },
            K: { volume_ml: diffK, pulses: Math.max(0, endPulses.K - (calibrationRun.startPulses?.K || 0)) || Math.round(diffK / 0.170) },
            Main: { volume_ml: diffMain, pulses: Math.max(0, endPulses.Main - (calibrationRun.startPulses?.Main || 0)) || Math.round(diffMain / 37.037) }
        };
        
        const sensors = ['N', 'P', 'K', 'Main'];
        for (const s of sensors) {
            const diff_vol = results[s].volume_ml;
            const pulses = results[s].pulses;
            const avg_flow_lpm = parseFloat(((diff_vol * 0.06) / duration_s).toFixed(3));
            
            try {
                const query = `
                    INSERT INTO lich_su_hieu_chinh (thoi_gian, chu_ky, cam_bien, the_tich_ml, xung, luu_luong_tb_lpm, thoi_gian_chay_s, ghi_chu)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `;
                const values = [
                    timestamp, cycleId, s, diff_vol, pulses, avg_flow_lpm, duration_s, 'Tự động ghi nhận chạy thử'
                ];
                if (pool) {
                    await pool.query(query, values);
                }
            } catch (dbErr) {
                console.error(`[CALIBRATION] Lỗi lưu kết quả cảm biến ${s}:`, dbErr.message);
            }
        }
        
        console.log(`[CALIBRATION] Đã hoàn thành chu kỳ chạy thử hiệu chuẩn: ${cycleId} (${duration_s}s)`);
        io.emit('calibration_history_updated');
        
        res.json({
            success: true,
            cycleId,
            duration_s,
            results
        });
    } else {
        res.json({ success: true, message: 'Không có chu kỳ hiệu chuẩn nào đang hoạt động.' });
    }
});

app.post('/api/calibration/update-firmware', (req, res) => {
    const { sensor, factor } = req.body;
    if (!sensor || factor === undefined) {
        return res.status(400).json({ error: 'Thiếu thông số cảm biến hoặc hệ số mới.' });
    }
    
    const fs = require('fs');
    const inoPath = path.join(__dirname, '../esp32/fertilizer_system/fertilizer_system.ino');
    
    try {
        if (!fs.existsSync(inoPath)) {
            console.error('[CALIBRATION] Không tìm thấy file firmware ESP32 tại:', inoPath);
            return res.status(500).json({ error: 'Không tìm thấy file mã nguồn ESP32 trên máy chủ.' });
        }
        
        let content = fs.readFileSync(inoPath, 'utf8');
        let regex;
        let replacement;
        const formattedFactor = parseFloat(factor).toFixed(4);
        
        if (sensor === 'N') {
            regex = /#define\s+ML_PER_PULSE_N\s+[\d.]+f/;
            replacement = `#define ML_PER_PULSE_N      ${formattedFactor}f`;
        } else if (sensor === 'P') {
            regex = /#define\s+ML_PER_PULSE_P\s+[\d.]+f/;
            replacement = `#define ML_PER_PULSE_P      ${formattedFactor}f`;
        } else if (sensor === 'K') {
            regex = /#define\s+ML_PER_PULSE_K\s+[\d.]+f/;
            replacement = `#define ML_PER_PULSE_K      ${formattedFactor}f`;
        } else if (sensor === 'Main') {
            regex = /#define\s+ML_PER_PULSE_MAIN\s+[\d.]+f/;
            replacement = `#define ML_PER_PULSE_MAIN   ${formattedFactor}f`;
        }
        
        if (regex && content.match(regex)) {
            content = content.replace(regex, replacement);
            fs.writeFileSync(inoPath, content, 'utf8');
            console.log(`[CALIBRATION] Đã cập nhật hệ số ${sensor} thành ${formattedFactor}f trong file firmware.`);
            res.json({ success: true, factor: formattedFactor });
        } else {
            res.status(404).json({ error: `Không tìm thấy dòng định nghĩa hệ số cho cảm biến ${sensor} trong code.` });
        }
    } catch (err) {
        console.error('[CALIBRATION] Lỗi ghi file firmware:', err.message);
        res.status(500).json({ error: 'Lỗi máy chủ khi cập nhật file code: ' + err.message });
    }
});

app.get('/api/calibration/history', async (req, res) => {
    try {
        const query = `
            SELECT id, thoi_gian AS timestamp, chu_ky AS cycle, cam_bien AS sensor, 
                   the_tich_ml AS volume_ml, xung AS pulses, 
                   luu_luong_tb_lpm AS flow_lpm, thoi_gian_chay_s AS duration_s, ghi_chu AS notes
            FROM lich_su_hieu_chinh
            ORDER BY thoi_gian DESC, id DESC
        `;
        const [rows] = await pool.query(query);
        res.json(rows);
    } catch (e) {
        console.error('[DB] Lỗi GET /calibration/history:', e.message);
        res.status(500).json({ error: 'Lỗi Database' });
    }
});

app.post('/api/calibration/save', async (req, res) => {
    try {
        const { sensor, actual_ml, pulses, notes } = req.body;
        const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const query = `
            INSERT INTO lich_su_hieu_chinh (thoi_gian, chu_ky, cam_bien, the_tich_ml, xung, luu_luong_tb_lpm, thoi_gian_chay_s, ghi_chu)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const values = [
            timestamp, 
            'Manual', 
            sensor || 'N', 
            parseFloat(actual_ml) || 0, 
            parseInt(pulses) || 0, 
            0, 
            0, 
            notes || 'Ghi nhận thủ công'
        ];
        const [result] = await pool.query(query, values);
        res.json({ success: true, id: result.insertId });
    } catch (e) {
        console.error('[DB] Lỗi POST /calibration/save:', e.message);
        res.status(500).json({ error: 'Lỗi Database' });
    }
});

app.delete('/api/calibration/history/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM lich_su_hieu_chinh WHERE id = ?', [req.params.id]);
        console.log(`[DB] Đã xóa lịch sử hiệu chuẩn id=${req.params.id}`);
        res.json({ success: true });
    } catch (e) {
        console.error('[DB] Lỗi DELETE /calibration/history/:id:', e.message);
        res.status(500).json({ error: 'Lỗi Database' });
    }
});


app.get('/api/recipes', async (req, res) => {
    try {
        const query = `
            SELECT ma_cong_thuc AS id, ten_cong_thuc AS name, 
                   the_tich_bon1_ml AS N_ml, the_tich_bon2_ml AS P_ml, the_tich_bon3_ml AS K_ml, 
                   mo_ta AS description, ngay_tao AS created_at 
            FROM cong_thuc
        `;
        const [rows] = await pool.query(query);
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
        const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const recipe = {
            id,
            name,
            N_ml: parseFloat(N_ml) || 0,
            P_ml: parseFloat(P_ml) || 0,
            K_ml: parseFloat(K_ml) || 0,
            description: description || '',
            created_at: timestamp
        };

        const query = `
            INSERT INTO cong_thuc (ma_cong_thuc, ten_cong_thuc, the_tich_bon1_ml, the_tich_bon2_ml, the_tich_bon3_ml, mo_ta, ngay_tao)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        const values = [
            recipe.id, recipe.name, recipe.N_ml, recipe.P_ml, recipe.K_ml, 
            recipe.description, recipe.created_at
        ];
        
        await pool.query(query, values);
        console.log(`[DB] Công thức mới: "${recipe.name}"`);
        res.json(recipe);
    } catch (e) {
        console.error('[DB] Lỗi POST /recipes:', e.message);
        res.status(500).json({ error: 'Lỗi Database' });
    }
});

app.delete('/api/recipes/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM cong_thuc WHERE ma_cong_thuc = ?', [req.params.id]);
        console.log(`[DB] Đã xóa công thức id=${req.params.id}`);
        res.json({ success: true });
    } catch (e) {
        console.error('[DB] Lỗi DELETE /recipes/:id:', e.message);
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

app.get('/api/db-stats', async (req, res) => {
    try {
        const [sessionsCount] = await pool.query('SELECT COUNT(*) as count FROM lich_su_tron');
        const [recipesCount] = await pool.query('SELECT COUNT(*) as count FROM cong_thuc');
        const [totalMlRow] = await pool.query('SELECT SUM(tong_the_tich_ml) as sum FROM lich_su_tron WHERE trang_thai = "completed"');
        const [lastSessionRow] = await pool.query(`
            SELECT ma_lich_su AS id, thoi_gian_tron AS timestamp, ten_cong_thuc_da_dung AS recipe_name, 
                   che_do_tron AS mode, ti_le_bon1 AS ratio_n, ti_le_bon2 AS ratio_p, ti_le_bon3 AS ratio_k, 
                   thuc_te_bon1_ml AS N_ml, thuc_te_bon2_ml AS P_ml, thuc_te_bon3_ml AS K_ml, 
                   tong_the_tich_ml AS total_ml, thoi_gian_chay_s AS duration_s, trang_thai AS status, 
                   wifi_rssi 
            FROM lich_su_tron 
            ORDER BY thoi_gian_tron DESC 
            LIMIT 1
        `);

        res.json({
            db_file:        'MySQL (csdl_phoi_tron_phan)',
            sessions_count: sessionsCount[0].count,
            recipes_count:  recipesCount[0].count,
            total_ml_mixed: Math.round(totalMlRow[0].sum || 0),
            last_session:   lastSessionRow[0] || null
        });
    } catch (e) {
        console.error('[DB] Lỗi GET /db-stats:', e.message);
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

            if (shouldRun && !currentSession) {
                console.log(`[CRON] Kích hoạt lịch hẹn: ${s.mo_ta}`);
                
                let mqttCmd = {};
                let sessionInfo = {};
                
                if ((s.n_ml > 0) || (s.p_ml > 0) || (s.k_ml > 0)) {
                    const totalParts = (s.n_ml || 0) + (s.p_ml || 0) + (s.k_ml || 0);
                    const durationMin = s.thoi_gian_tuoi_phut || 1.0;
                    const totalDosingFlowLpm = totalParts / (durationMin * 1000);
                    const total_lpm = totalDosingFlowLpm > 0.05 ? totalDosingFlowLpm : 3.0;

                    const cN_lpm = parseFloat((((s.n_ml || 0) / totalParts) * total_lpm).toFixed(3));
                    const cP_lpm = parseFloat((((s.p_ml || 0) / totalParts) * total_lpm).toFixed(3));
                    const cK_lpm = parseFloat((((s.k_ml || 0) / totalParts) * total_lpm).toFixed(3));

                    const Q_MAX = 4.0;
                    const toInitOpen = (lpm) => Math.min(100, Math.round((lpm / Q_MAX) * 100));

                    mqttCmd = {
                        cmd: 'start_sim',
                        recipe: {
                            N: { target_ml: Math.round((s.n_ml || 0) * ((s.n_ml || 0) >= 50 ? aiCalibration.N : 1.0)), target_lpm: cN_lpm, init_open: toInitOpen(cN_lpm) },
                            P: { target_ml: Math.round((s.p_ml || 0) * ((s.p_ml || 0) >= 50 ? aiCalibration.P : 1.0)), target_lpm: cP_lpm, init_open: toInitOpen(cP_lpm) },
                            K: { target_ml: Math.round((s.k_ml || 0) * ((s.k_ml || 0) >= 50 ? aiCalibration.K : 1.0)), target_lpm: cK_lpm, init_open: toInitOpen(cK_lpm) }
                        }
                    };
                    sessionInfo = {
                        recipe_name: `Hẹn giờ (${s.n_ml}-${s.p_ml}-${s.k_ml} mL)`,
                        mode: 'simultaneous',
                        start_time: Date.now(),
                        ratio: { N: s.n_ml || 0, P: s.p_ml || 0, K: s.k_ml || 0 },
                        total_liter: totalParts / 1000,
                        total_lpm: total_lpm,
                        calc: {
                            N: { target_ml: s.n_ml || 0, target_lpm: cN_lpm },
                            P: { target_ml: s.p_ml || 0, target_lpm: cP_lpm },
                            K: { target_ml: s.k_ml || 0, target_lpm: cK_lpm }
                        }
                    };
                } else {
                    const durationMin = s.thoi_gian_tuoi_phut || 1.0;
                    const total_water_l = 75.0 * durationMin;
                    
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
                        recipe_name: 'Chỉ tưới nước (Hẹn giờ)',
                        mode: 'volume-based',
                        start_time: Date.now(),
                        N_ml: 0, P_ml: 0, K_ml: 0,
                        total_water_l,
                        duration_sec: Math.round(durationMin * 60)
                    };
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
