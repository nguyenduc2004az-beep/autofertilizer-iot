/**
 * Script: generate_next_cycles.js
 * Chức năng:
 *   1. Lấy giá trị của 4 lần đo/phối trộn gần nhất từ cơ sở dữ liệu (MySQL).
 *   2. Tạo 5 chu kỳ kế sau với giá trị không đồng nhất (thêm nhiễu/biến thiên ngẫu nhiên) dựa trên giá trị nền tảng đó.
 *   3. Ghi dữ liệu giả lập mới vào cả 2 bảng: lich_su_hieu_chinh (hiệu chuẩn) và lich_su_tron (phối trộn).
 *   4. Đồng thời đồng bộ các kết quả mới vào file db.json (để server.js đồng bộ lại nếu cần).
 *   5. Phát tín hiệu Socket.io (nếu server đang chạy) để UI tải lại lịch sử theo thời gian thực.
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const ioClient = require('socket.io-client');

const DB_CONFIG = {
    host:     process.env.MYSQLHOST     || 'localhost',
    port:     process.env.MYSQLPORT     || 3306,
    user:     process.env.MYSQLUSER     || 'root',
    password: process.env.MYSQLPASSWORD || '',
    database: process.env.MYSQLDATABASE || 'csdl_phoi_tron_phan'
};

const DB_JSON_PATH = path.join(__dirname, 'db.json');

// Danh sách các hệ số biến thiên không đồng nhất cho 5 chu kỳ kế tiếp (dao động từ -15% đến +15%)
const VARIATION_FACTORS = [0.92, 1.07, 0.88, 1.15, 0.96];

function formatMysqlDatetime(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function main() {
    let connection;
    try {
        console.log('[INIT] Đang kết nối tới MySQL...');
        connection = await mysql.createConnection(DB_CONFIG);
        console.log('[INIT] Kết nối MySQL thành công.');

        // =====================================================================
        // PHẦN 1: XỬ LÝ BẢNG HIỆU CHUẨN (lich_su_hieu_chinh)
        // =====================================================================
        console.log('\n--- XỬ LÝ LỊCH SỬ HIỆU CHUẨN ---');
        
        // 1.1. Lấy 4 chu kỳ hiệu chuẩn gần nhất
        const [recentCyclesRows] = await connection.query(`
            SELECT DISTINCT chu_ky, thoi_gian 
            FROM lich_su_hieu_chinh 
            ORDER BY thoi_gian DESC, id DESC 
            LIMIT 4
        `);

        if (recentCyclesRows.length === 0) {
            console.log('[HIỆU CHUẨN] Không tìm thấy dữ liệu cũ. Sử dụng giá trị mặc định để làm nền tảng.');
        } else {
            console.log(`[HIỆU CHUẨN] Tìm thấy ${recentCyclesRows.length} chu kỳ gần nhất:`, recentCyclesRows.map(r => r.chu_ky));
        }

        const recentCycles = recentCyclesRows.map(r => r.chu_ky);
        
        // 1.2. Lấy dữ liệu chi tiết của 4 chu kỳ đó
        let baseCalibMap = {
            'N': { the_tich_ml: 100, xung: 500, thoi_gian_chay_s: 15, count: 0 },
            'P': { the_tich_ml: 100, xung: 500, thoi_gian_chay_s: 15, count: 0 },
            'K': { the_tich_ml: 100, xung: 500, thoi_gian_chay_s: 15, count: 0 },
            'Main': { the_tich_ml: 20000, xung: 500, thoi_gian_chay_s: 15, count: 0 }
        };

        if (recentCycles.length > 0) {
            const [detailRows] = await connection.query(`
                SELECT cam_bien, the_tich_ml, xung, thoi_gian_chay_s 
                FROM lich_su_hieu_chinh 
                WHERE chu_ky IN (?)
            `, [recentCycles]);

            // Reset map về 0 để tính trung bình thực tế
            for (const sensor in baseCalibMap) {
                baseCalibMap[sensor] = { the_tich_ml: 0, xung: 0, thoi_gian_chay_s: 0, count: 0 };
            }

            detailRows.forEach(row => {
                const s = row.cam_bien;
                if (baseCalibMap[s]) {
                    baseCalibMap[s].the_tich_ml += row.the_tich_ml;
                    baseCalibMap[s].xung += row.xung;
                    baseCalibMap[s].thoi_gian_chay_s += row.thoi_gian_chay_s;
                    baseCalibMap[s].count += 1;
                }
            });

            // Tính trung bình cộng
            for (const s in baseCalibMap) {
                const sensorData = baseCalibMap[s];
                if (sensorData.count > 0) {
                    sensorData.the_tich_ml = sensorData.the_tich_ml / sensorData.count;
                    sensorData.xung = sensorData.xung / sensorData.count;
                    sensorData.thoi_gian_chay_s = Math.round(sensorData.thoi_gian_chay_s / sensorData.count);
                } else {
                    // Fallback nếu thiếu cảm biến nào đó
                    baseCalibMap[s] = s === 'Main' 
                        ? { the_tich_ml: 20000, xung: 500, thoi_gian_chay_s: 15 } 
                        : { the_tich_ml: 100, xung: 500, thoi_gian_chay_s: 15 };
                }
            }
        }

        console.log('[HIỆU CHUẨN] Giá trị nền tảng (Trung bình 4 lần đo gần nhất):');
        console.table(baseCalibMap);

        // 1.3. Tạo 5 chu kỳ hiệu chuẩn kế sau với giá trị không đồng nhất
        console.log('[HIỆU CHUẨN] Bắt đầu tạo 5 chu kỳ kế tiếp...');
        const generatedCalibs = [];
        for (let i = 0; i < 5; i++) {
            const factor = VARIATION_FACTORS[i];
            const cycleId = 'C_GEN' + Math.floor(100000 + Math.random() * 900000);
            // Giả lập thời gian cách nhau 1 giờ về tương lai
            const timeVal = new Date(Date.now() + (i + 1) * 3600 * 1000);
            const timeStr = formatMysqlDatetime(timeVal);

            console.log(`\n  -> Chu kỳ ${i+1}: Mã ${cycleId} | Factor: ${factor} | Time: ${timeStr}`);
            
            const sensors = ['N', 'P', 'K', 'Main'];
            for (const s of sensors) {
                const base = baseCalibMap[s];
                // Tính thể tích và xung có dao động biến thiên
                const vol = parseFloat((base.the_tich_ml * factor).toFixed(1));
                const pulses = Math.round(base.xung * factor);
                const duration = base.thoi_gian_chay_s;
                // Q (L/phút) = (Thể tích mL * 0.06) / Thời gian giây
                const flow = parseFloat(((vol * 0.06) / duration).toFixed(3));
                const note = `Giả lập chu kỳ kế sau ${i+1} (Dựa trên 4 lần đo gần nhất)`;

                const query = `
                    INSERT INTO lich_su_hieu_chinh (thoi_gian, chu_ky, cam_bien, the_tich_ml, xung, luu_luong_tb_lpm, thoi_gian_chay_s, ghi_chu)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `;
                const values = [timeStr, cycleId, s, vol, pulses, flow, duration, note];
                await connection.query(query, values);
                console.log(`     Sensor ${s}: Vol=${vol} mL, Pulses=${pulses}, Flow=${flow} LPM, Duration=${duration}s`);
                
                generatedCalibs.push({
                    thoi_gian: timeStr,
                    chu_ky: cycleId,
                    cam_bien: s,
                    the_tich_ml: vol,
                    xung: pulses,
                    luu_luong_tb_lpm: flow,
                    thoi_gian_chay_s: duration,
                    ghi_chu: note
                });
            }
        }


        // =====================================================================
        // PHẦN 2: XỬ LÝ LỊCH SỬ PHỐI TRỘN (lich_su_tron)
        // =====================================================================
        console.log('\n--- XỬ LÝ LỊCH SỬ PHỐI TRỘN ---');

        // 2.1. Lấy 4 lần phối trộn gần nhất
        const [recentSessions] = await connection.query(`
            SELECT * FROM lich_su_tron 
            ORDER BY thoi_gian_tron DESC 
            LIMIT 4
        `);

        let baseSession = {
            recipe_name: 'Công thức giả lập cà chua',
            mode: 'simultaneous',
            ratio_n: 25, ratio_p: 25, ratio_k: 50,
            N_ml: 1000, P_ml: 1000, K_ml: 2000,
            total_ml: 100000,
            duration_s: 180,
            wifi_rssi: -55
        };

        if (recentSessions.length > 0) {
            console.log(`[PHỐI TRỘN] Tìm thấy ${recentSessions.length} phiên trộn gần nhất.`);
            let avgN = 0, avgP = 0, avgK = 0, avgTotal = 0, avgDuration = 0, avgRssi = 0;
            recentSessions.forEach(r => {
                avgN += r.thuc_te_bon1_ml;
                avgP += r.thuc_te_bon2_ml;
                avgK += r.thuc_te_bon3_ml;
                avgTotal += r.tong_the_tich_ml;
                avgDuration += r.thoi_gian_chay_s;
                avgRssi += r.wifi_rssi;
            });
            const len = recentSessions.length;
            baseSession = {
                recipe_name: recentSessions[0].ten_cong_thuc_da_dung,
                mode: recentSessions[0].che_do_tron,
                ratio_n: recentSessions[0].ti_le_bon1,
                ratio_p: recentSessions[0].ti_le_bon2,
                ratio_k: recentSessions[0].ti_le_bon3,
                N_ml: Math.round(avgN / len),
                P_ml: Math.round(avgP / len),
                K_ml: Math.round(avgK / len),
                total_ml: Math.round(avgTotal / len),
                duration_s: Math.round(avgDuration / len),
                wifi_rssi: Math.round(avgRssi / len)
            };
        }

        console.log('[PHỐI TRỘN] Giá trị nền tảng (Trung bình 4 phiên gần nhất):');
        console.table(baseSession);

        // 2.2. Tạo 5 chu kỳ phối trộn kế sau với giá trị không đồng nhất
        console.log('[PHỐI TRỘN] Bắt đầu tạo 5 phiên kế tiếp...');
        const generatedSessions = [];
        for (let i = 0; i < 5; i++) {
            const factor = VARIATION_FACTORS[i];
            const sessionTime = new Date(Date.now() + (i + 1) * 3600 * 1000);
            const timeStr = formatMysqlDatetime(sessionTime);
            const maLichSu = Date.now() + i * 100 + Math.floor(Math.random() * 99);

            const n_ml = Math.round(baseSession.N_ml * factor);
            const p_ml = Math.round(baseSession.P_ml * factor);
            const k_ml = Math.round(baseSession.K_ml * factor);
            const total_ml = Math.round(baseSession.total_ml * factor);
            const duration = Math.round(baseSession.duration_s * factor);
            const wifi_rssi = baseSession.wifi_rssi + (Math.floor(Math.random() * 5) - 2); // Dao động RSSI nhẹ

            const recipeName = `${baseSession.recipe_name} [Giai đoạn kế sau ${i+1}]`;

            const query = `
                INSERT INTO lich_su_tron 
                (ma_lich_su, thoi_gian_tron, ten_cong_thuc_da_dung, che_do_tron, ti_le_bon1, ti_le_bon2, ti_le_bon3, thuc_te_bon1_ml, thuc_te_bon2_ml, thuc_te_bon3_ml, tong_the_tich_ml, thoi_gian_chay_s, trang_thai, wifi_rssi)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)
            `;
            const values = [
                maLichSu, timeStr, recipeName, baseSession.mode, 
                baseSession.ratio_n, baseSession.ratio_p, baseSession.ratio_k,
                n_ml, p_ml, k_ml, total_ml, duration, wifi_rssi
            ];
            await connection.query(query, values);
            console.log(`  -> Phiên ${i+1}: ID ${maLichSu} | N=${n_ml} mL, P=${p_ml} mL, K=${k_ml} mL, Total=${total_ml} mL, Sec=${duration}s`);
            
            generatedSessions.push({
                id: maLichSu,
                timestamp: sessionTime.toISOString(),
                recipe_name: recipeName,
                mode: baseSession.mode,
                ratio_n: baseSession.ratio_n,
                ratio_p: baseSession.ratio_p,
                ratio_k: baseSession.ratio_k,
                N_ml: n_ml,
                P_ml: p_ml,
                K_ml: k_ml,
                total_ml: total_ml,
                duration_s: duration,
                status: 'completed',
                wifi_rssi: wifi_rssi
            });
        }


        // =====================================================================
        // PHẦN 3: ĐỒNG BỘ VÀ O FILE db.json VÀ PHÁT SOCKET.IO REAL-TIME
        // =====================================================================
        console.log('\n--- ĐỒNG BỘ VÀ PHÁT TÍN HIỆU ---');
        
        // 3.1. Đồng bộ lịch sử phối trộn vào db.json
        if (fs.existsSync(DB_JSON_PATH)) {
            try {
                const dbJson = JSON.parse(fs.readFileSync(DB_JSON_PATH, 'utf8'));
                if (!dbJson.sessions) dbJson.sessions = [];
                
                // Cho các phiên mới sinh lên đầu mảng
                generatedSessions.forEach(s => {
                    dbJson.sessions.unshift(s);
                });
                
                fs.writeFileSync(DB_JSON_PATH, JSON.stringify(dbJson, null, 2), 'utf8');
                console.log('[DB.JSON] Đã lưu 5 phiên phối trộn mới vào file db.json thành công.');
            } catch (err) {
                console.warn('[DB.JSON] Lỗi cập nhật file db.json:', err.message);
            }
        }

        // 3.2. Kết nối tới Socket.io Server nội bộ để kích hoạt cập nhật giao diện
        console.log('[SOCKET] Đang kết nối tới Socket.io server (http://localhost:3000)...');
        const socket = ioClient('http://localhost:3000', {
            timeout: 3000,
            reconnectionAttempts: 1
        });

        socket.on('connect', () => {
            console.log('[SOCKET] Đã kết nối thành công. Đang gửi các sự kiện làm mới lịch sử...');
            socket.emit('calibration_history_updated');
            socket.emit('history_updated');
            console.log('[SOCKET] Đã phát tín hiệu làm mới.');
            setTimeout(() => {
                socket.disconnect();
                cleanup();
            }, 1000);
        });

        socket.on('connect_error', () => {
            console.warn('[SOCKET] Không thể kết nối tới Socket.io Server (Server có thể đang tắt). Ghi dữ liệu Database hoàn tất.');
            cleanup();
        });

    } catch (e) {
        console.error('[FAIL] Đã xảy ra lỗi khi thực thi script:', e.message);
        if (connection) {
            await connection.end();
        }
        process.exit(1);
    }

    async function cleanup() {
        if (connection) {
            await connection.end();
            console.log('[DONE] Đã đóng kết nối cơ sở dữ liệu.');
        }
        console.log('[SUCCESS] Hoàn thành tất cả các bước. 5 chu kỳ kế sau đã được tạo thành công.');
        process.exit(0);
    }
}

main();
