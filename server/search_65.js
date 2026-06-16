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
            SELECT * FROM lich_su_hieu_chinh 
            WHERE thoi_gian_chay_s = 65 OR thoi_gian_chay_s = 60 OR thoi_gian_chay_s = 5
            ORDER BY thoi_gian DESC
        `);
        console.log('--- MATCHING CALIBRATIONS ---');
        console.log(JSON.stringify(rows, null, 2));

        const [recent_calibs] = await connection.query(`
            SELECT DISTINCT chu_ky, thoi_gian_chay_s, thoi_gian 
            FROM lich_su_hieu_chinh 
            ORDER BY thoi_gian DESC LIMIT 10
        `);
        console.log('--- RECENT CALIB CYCLES ---');
        console.log(JSON.stringify(recent_calibs, null, 2));

        await connection.end();
    } catch (e) {
        console.error('Database query failed:', e.message);
    }
}

main();
