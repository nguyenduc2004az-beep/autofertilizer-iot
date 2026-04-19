/**
 * ╔════════════════════════════════════════════════════════════╗
 * ║   HỆ THỐNG PHỐI TRỘN PHÂN TỰ ĐỘNG - NODE.JS SERVER       ║
 * ║                                                            ║
 * ║   Chức năng:                                               ║
 * ║     - MQTT client kết nối Mosquitto broker                 ║
 * ║     - Express REST API                                     ║
 * ║     - Socket.io real-time push tới trình duyệt            ║
 * ║     - Database: JSON file (db.json) - không cần native     ║
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
const fs       = require('fs');

// ================================================================
// CẤU HÌNH — Đọc từ biến môi trường (Railway) hoặc dùng giá trị mặc định (localhost)
// ================================================================
const PORT   = process.env.PORT || 3000;

// MQTT Broker:
//   - Local:   mqtt://127.0.0.1:1883  (Mosquitto)
//   - Railway: mqtt://broker.hivemq.com:1883 (HiveMQ public broker)
const MQTT_URL = process.env.MQTT_URL || 'mqtt://127.0.0.1:1883';

// MQTT Topic prefix — đặt giá trị riêng để tránh xung đột trên broker dùng chung
// VD: MQTT_TOPIC_PREFIX=autofert_khoa2026
const TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX || 'autofert';
const TOPIC_CMD    = `${TOPIC_PREFIX}/cmd`;
const TOPIC_STATUS = `${TOPIC_PREFIX}/status`;

const DB_PATH = path.join(__dirname, 'db.json');

console.log(`[CONFIG] PORT=${PORT} | MQTT=${MQTT_URL} | TOPICS=${TOPIC_PREFIX}/*`);

// ================================================================
// DATABASE JSON - Đọc/Ghi file db.json
// ================================================================
function loadDB() {
    if (!fs.existsSync(DB_PATH)) {
        const initial = {
            sessions: [],
            recipes: [
                { id: '1', name: 'NPK 20-20-20',       N_ml: 2000, P_ml: 2000, K_ml: 2000, description: 'Công thức cân bằng',   created_at: new Date().toISOString() },
                { id: '2', name: 'Bón gốc (N nhiều)',  N_ml: 3000, P_ml: 1500, K_ml: 1500, description: 'Tăng sinh trưởng',     created_at: new Date().toISOString() },
                { id: '3', name: 'Ra hoa (P-K cao)',   N_ml: 1000, P_ml: 2500, K_ml: 2500, description: 'Kích thích ra hoa',    created_at: new Date().toISOString() }
            ]
        };
        saveDB(initial);
        console.log('[DB] Tạo db.json mới với dữ liệu mẫu');
        return initial;
    }
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (e) {
        console.error('[DB] Lỗi đọc db.json:', e.message);
        return { sessions: [], recipes: [] };
    }
}

function saveDB(data) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('[DB] Lỗi ghi db.json:', e.message);
    }
}

// Khởi tạo DB
let db = loadDB();
console.log(`[DB] ✓ Database: ${DB_PATH} | Sessions: ${db.sessions.length} | Recipes: ${db.recipes.length}`);

// ================================================================
// TRẠNG THÁI HỆ THỐNG (in-memory)
// ================================================================
let deviceOnline       = false;
let lastDeviceStatus   = null;
let currentSession     = null;
let deviceTimeoutTimer = null;

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
mqttClient.on('message', (topic, message) => {
    if (topic !== TOPIC_STATUS) return;

    let data;
    try {
        data = JSON.parse(message.toString());
    } catch (e) {
        console.error('[MQTT] JSON parse lỗi:', e.message);
        return;
    }

    lastDeviceStatus = data;

    // Cập nhật trạng thái online của ESP32
    if (!deviceOnline) {
        deviceOnline = true;
        console.log('[ESP32] ✓ Thiết bị online');
    }
    clearTimeout(deviceTimeoutTimer);
    deviceTimeoutTimer = setTimeout(() => {
        deviceOnline = false;
        io.emit('device_online', false);
        console.log('[ESP32] ✗ Thiết bị offline (timeout)');
    }, 5000);

    // Phát real-time tới tất cả browser đang kết nối
    io.emit('device_status', { ...data, online: true });

    // Kiểm tra nếu phiên vừa hoàn thành (phase=4, running=false)
    if (currentSession && !data.running && data.phase === 4) {
        const sess = currentSession;
        const record = {
            id:          Date.now(),
            timestamp:   new Date().toISOString(),
            recipe_name: sess.recipe_name,
            mode:        sess.mode || 'sequential',
            ratio_n:     sess.ratio?.N || 0,
            ratio_p:     sess.ratio?.P || 0,
            ratio_k:     sess.ratio?.K || 0,
            N_ml:        Math.round(data.valves?.N?.volume_ml || 0),
            P_ml:        Math.round(data.valves?.P?.volume_ml || 0),
            K_ml:        Math.round(data.valves?.K?.volume_ml || 0),
            total_ml:    Math.round(data.total_volume_ml || 0),
            duration_s:  Math.round((Date.now() - sess.start_time) / 1000),
            status:      'completed',
            wifi_rssi:   data.wifi_rssi || 0
        };

        // Lưu vào JSON
        db = loadDB();
        db.sessions.unshift(record);  // Thêm vào đầu (mới nhất trước)
        if (db.sessions.length > 200) db.sessions = db.sessions.slice(0, 200); // Giới hạn 200 records
        saveDB(db);

        io.emit('session_completed', record);
        io.emit('history_updated');
        console.log(`[DB] Đã lưu phiên: "${record.recipe_name}" | ${record.total_ml} mL | ${record.duration_s}s`);
        currentSession = null;
    }
});

// ================================================================
// REST API
// ================================================================

// GET /api/status - Trạng thái hệ thống
app.get('/api/status', (req, res) => {
    res.json({
        device_online:   deviceOnline,
        last_status:     lastDeviceStatus,
        current_session: currentSession,
        server_time:     new Date().toISOString()
    });
});

// POST /api/start - Bắt đầu pha trộn
app.post('/api/start', (req, res) => {
    const body = req.body;
    const mode = body.mode || 'seq';

    let mqttCmd, sessionInfo;

    if (mode === 'sim') {
        // ============================================================
        // CHẾ ĐỘ ĐỒNG THỜI với ĐIỀU KHIỂN TỈ LỆ
        // ============================================================
        const ratioN = parseFloat(body.ratio_N) || 0;
        const ratioP = parseFloat(body.ratio_P) || 0;
        const ratioK = parseFloat(body.ratio_K) || 0;
        const total_liter = parseFloat(body.total_vol_l) || 0;
        const total_lpm   = parseFloat(body.total_lpm)   || 0;

        if (ratioN + ratioP + ratioK <= 0)
            return res.status(400).json({ error: 'Tổng tỉ lệ phải > 0' });
        if (total_liter <= 0)
            return res.status(400).json({ error: 'Tổng thể tích phải > 0' });
        if (total_lpm <= 0)
            return res.status(400).json({ error: 'Lưu lượng tổng phải > 0' });

        const totalParts = ratioN + ratioP + ratioK;

        const calc = (ratio) => ({
            pct:        (ratio / totalParts) * 100,
            target_ml:  Math.round((ratio / totalParts) * total_liter * 1000),
            target_lpm: parseFloat(((ratio / totalParts) * total_lpm).toFixed(3))
        });

        const cN = calc(ratioN);
        const cP = calc(ratioP);
        const cK = calc(ratioK);

        const Q_MAX = 4.0;
        const toInitOpen = (lpm) => Math.min(100, Math.round((lpm / Q_MAX) * 100));

        mqttCmd = {
            cmd: 'start_sim',
            recipe: {
                N: { target_ml: cN.target_ml, target_lpm: cN.target_lpm, init_open: toInitOpen(cN.target_lpm) },
                P: { target_ml: cP.target_ml, target_lpm: cP.target_lpm, init_open: toInitOpen(cP.target_lpm) },
                K: { target_ml: cK.target_ml, target_lpm: cK.target_lpm, init_open: toInitOpen(cK.target_lpm) }
            }
        };

        sessionInfo = {
            recipe_name: body.recipe_name || `Tỉ lệ ${ratioN}:${ratioP}:${ratioK}`,
            mode: 'simultaneous',
            start_time: Date.now(),
            ratio: { N: ratioN, P: ratioP, K: ratioK },
            total_liter, total_lpm,
            calc: { N: cN, P: cP, K: cK }
        };

        console.log(`[SIM] ${sessionInfo.recipe_name} | N:${cN.target_ml}mL | P:${cP.target_ml}mL | K:${cK.target_ml}mL`);
    } else {
        // ============================================================
        // CHẾ ĐỘ TUẦN TỰ (N → P → K)
        // ============================================================
        const nMl = parseFloat(body.N_ml) || 0;
        const pMl = parseFloat(body.P_ml) || 0;
        const kMl = parseFloat(body.K_ml) || 0;

        if (nMl <= 0 && pMl <= 0 && kMl <= 0)
            return res.status(400).json({ error: 'Cần nhập ít nhất 1 lượng phân > 0' });

        mqttCmd = {
            cmd: 'start_seq',
            recipe: {
                N: { target_ml: nMl, speed_percent: parseInt(body.N_speed) || 60 },
                P: { target_ml: pMl, speed_percent: parseInt(body.P_speed) || 60 },
                K: { target_ml: kMl, speed_percent: parseInt(body.K_speed) || 60 }
            }
        };

        sessionInfo = {
            recipe_name: body.recipe_name || 'Chưa đặt tên',
            mode: 'sequential',
            start_time: Date.now(),
            N_ml: nMl, P_ml: pMl, K_ml: kMl
        };
    }

    // Gửi lệnh MQTT
    mqttClient.publish(TOPIC_CMD, JSON.stringify(mqttCmd), { qos: 1 }, (err) => {
        if (err) return res.status(500).json({ error: 'Lỗi MQTT: ' + err.message });
        currentSession = sessionInfo;
        console.log(`[START] ${sessionInfo.recipe_name} - chế độ: ${sessionInfo.mode}`);
        io.emit('session_started', sessionInfo);
        res.json({ success: true, session: sessionInfo, command: mqttCmd });
    });
});

// POST /api/stop - Dừng khẩn cấp
app.post('/api/stop', (req, res) => {
    mqttClient.publish(TOPIC_CMD, JSON.stringify({ cmd: 'stop' }), { qos: 1 }, (err) => {
        if (err) return res.status(500).json({ error: err.message });

        if (currentSession) {
            const sess = currentSession;
            const record = {
                id:          Date.now(),
                timestamp:   new Date().toISOString(),
                recipe_name: sess.recipe_name + ' [HỦY]',
                mode:        sess.mode || 'sequential',
                ratio_n: sess.ratio?.N || 0,
                ratio_p: sess.ratio?.P || 0,
                ratio_k: sess.ratio?.K || 0,
                N_ml:        Math.round(lastDeviceStatus?.valves?.N?.volume_ml || 0),
                P_ml:        Math.round(lastDeviceStatus?.valves?.P?.volume_ml || 0),
                K_ml:        Math.round(lastDeviceStatus?.valves?.K?.volume_ml || 0),
                total_ml:    Math.round(lastDeviceStatus?.total_volume_ml || 0),
                duration_s:  Math.round((Date.now() - sess.start_time) / 1000),
                status:      'cancelled',
                wifi_rssi:   lastDeviceStatus?.wifi_rssi || 0
            };
            db = loadDB();
            db.sessions.unshift(record);
            saveDB(db);
            io.emit('history_updated');
            currentSession = null;
        }

        console.log('[STOP] Lệnh dừng khẩn cấp đã gửi');
        io.emit('session_stopped');
        res.json({ success: true });
    });
});

// POST /api/home - Đưa van về vị trí gốc
app.post('/api/home', (req, res) => {
    mqttClient.publish(TOPIC_CMD, JSON.stringify({ cmd: 'home' }), { qos: 1 });
    res.json({ success: true });
});

// GET /api/history - Lịch sử pha trộn
app.get('/api/history', (req, res) => {
    db = loadDB();
    const limit = parseInt(req.query.limit) || 50;
    res.json(db.sessions.slice(0, limit));
});

// DELETE /api/history - Xóa toàn bộ lịch sử
app.delete('/api/history', (req, res) => {
    db = loadDB();
    db.sessions = [];
    saveDB(db);
    io.emit('history_updated');
    console.log('[DB] Đã xóa toàn bộ lịch sử');
    res.json({ success: true });
});

// GET /api/recipes - Danh sách công thức
app.get('/api/recipes', (req, res) => {
    db = loadDB();
    res.json(db.recipes);
});

// POST /api/recipes - Thêm công thức mới
app.post('/api/recipes', (req, res) => {
    const { name, N_ml, P_ml, K_ml, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Thiếu tên công thức' });

    const recipe = {
        id:          Date.now().toString(),
        name,
        N_ml:        parseFloat(N_ml)  || 0,
        P_ml:        parseFloat(P_ml)  || 0,
        K_ml:        parseFloat(K_ml)  || 0,
        description: description || '',
        created_at:  new Date().toISOString()
    };

    db = loadDB();
    db.recipes.push(recipe);
    saveDB(db);
    console.log(`[DB] Công thức mới: "${recipe.name}"`);
    res.json(recipe);
});

// DELETE /api/recipes/:id - Xóa công thức
app.delete('/api/recipes/:id', (req, res) => {
    db = loadDB();
    const idx = db.recipes.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy công thức' });
    db.recipes.splice(idx, 1);
    saveDB(db);
    console.log(`[DB] Đã xóa công thức id=${req.params.id}`);
    res.json({ success: true });
});

// GET /api/db-stats - Thống kê DB
app.get('/api/db-stats', (req, res) => {
    db = loadDB();
    const completed = db.sessions.filter(s => s.status === 'completed');
    const totalMl   = completed.reduce((sum, s) => sum + (s.total_ml || 0), 0);
    res.json({
        db_file:        DB_PATH,
        sessions_count: db.sessions.length,
        recipes_count:  db.recipes.length,
        total_ml_mixed: Math.round(totalMl),
        last_session:   db.sessions[0] || null
    });
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
    console.log(`║   DB: ${DB_PATH.padEnd(50)}║`);
    console.log('╚══════════════════════════════════════════════════════════╝\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[Server] Đang tắt...');
    mqttClient.end();
    server.close(() => {
        console.log('[Server] Đã tắt.');
        process.exit(0);
    });
});
