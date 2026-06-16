const mysql = require('mysql2/promise');

const DB_CONFIG = {
    host:     process.env.MYSQLHOST     || 'localhost',
    port:     process.env.MYSQLPORT     || 3306,
    user:     process.env.MYSQLUSER     || 'root',
    password: process.env.MYSQLPASSWORD || '',
    database: process.env.MYSQLDATABASE || 'csdl_phoi_tron_phan'
};

async function main() {
    try {
        const connection = await mysql.createConnection(DB_CONFIG);
        console.log('Connected to MySQL.');

        const [rows] = await connection.query(`
            SELECT id, thoi_gian, chu_ky, cam_bien, the_tich_ml, xung, luu_luong_tb_lpm, thoi_gian_chay_s, ghi_chu 
            FROM lich_su_hieu_chinh 
            ORDER BY thoi_gian DESC, id DESC LIMIT 15
        `);
        console.log('--- LATEST 15 CALIBRATIONS ---');
        for (const row of rows) {
            const timeStr = row.thoi_gian ? row.thoi_gian.toISOString() : 'N/A';
            console.log('ID: ' + row.id + ' | Time: ' + timeStr + ' | Cycle: ' + row.chu_ky + ' | Sensor: ' + row.cam_bien + ' | Vol: ' + row.the_tich_ml + ' mL | Pulses: ' + row.xung + ' | Flow: ' + row.luu_luong_tb_lpm + ' LPM | Sec: ' + row.thoi_gian_chay_s + ' | Note: ' + row.ghi_chu);
        }

        const [rows2] = await connection.query(`
            SELECT ma_lich_su, thoi_gian_tron, ten_cong_thuc_da_dung, che_do_tron, thuc_te_bon1_ml, thuc_te_bon2_ml, thuc_te_bon3_ml, tong_the_tich_ml, thoi_gian_chay_s, trang_thai 
            FROM lich_su_tron 
            ORDER BY thoi_gian_tron DESC LIMIT 5
        `);
        console.log('--- LATEST 5 MIXING SESSIONS ---');
        for (const row of rows2) {
            const timeStr = row.thoi_gian_tron ? row.thoi_gian_tron.toISOString() : 'N/A';
            console.log('ID: ' + row.ma_lich_su + ' | Time: ' + timeStr + ' | Name: ' + row.ten_cong_thuc_da_dung + ' | Mode: ' + row.che_do_tron + ' | N: ' + row.thuc_te_bon1_ml + ' | P: ' + row.thuc_te_bon2_ml + ' | K: ' + row.thuc_te_bon3_ml + ' | Total: ' + row.tong_the_tich_ml + ' | Sec: ' + row.thoi_gian_chay_s + ' | Status: ' + row.trang_thai);
        }

        await connection.end();
    } catch (e) {
        console.error('Database query failed:', e.message);
    }
}

main();
