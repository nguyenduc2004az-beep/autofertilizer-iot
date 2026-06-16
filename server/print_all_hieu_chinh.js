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
            ORDER BY thoi_gian DESC, id DESC
        `);
        console.log('--- ALL CALIBRATIONS ---');
        for (const row of rows) {
            const timeStr = row.thoi_gian ? row.thoi_gian.toISOString() : 'N/A';
            console.log('ID: ' + row.id + ' | Time: ' + timeStr + ' | Cycle: ' + row.chu_ky + ' | Sensor: ' + row.cam_bien + ' | Vol: ' + row.the_tich_ml + ' mL | Pulses: ' + row.xung + ' | Flow: ' + row.luu_luong_tb_lpm + ' LPM | Sec: ' + row.thoi_gian_chay_s + ' | Note: ' + row.ghi_chu);
        }

        await connection.end();
    } catch (e) {
        console.error('Database query failed:', e.message);
    }
}

main();
