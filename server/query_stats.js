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
        
        // Query average flow rate from calibration history
        const [rows] = await connection.query(`
            SELECT cam_bien, AVG(luu_luong_tb_lpm) AS avg_flow, COUNT(*) AS count 
            FROM lich_su_hieu_chinh 
            GROUP BY cam_bien
        `);
        console.log('--- AVERAGE FLOW RATE FROM CALIBRATION HISTORY ---');
        console.log(rows);
        
        // Also look at some calibration history records
        const [recent] = await connection.query(`
            SELECT * FROM lich_su_hieu_chinh 
            ORDER BY thoi_gian DESC LIMIT 10
        `);
        console.log('--- RECENT CALIBRATION RECORDS ---');
        console.log(recent);
        
        await connection.end();
    } catch (e) {
        console.error('Database query failed:', e.message);
    }
}

main();
