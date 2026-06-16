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

        // Search in lich_su_tron
        const [tron] = await connection.query('SELECT * FROM lich_su_tron ORDER BY thoi_gian_tron DESC LIMIT 30');
        console.log('--- LICH SU TRON ---');
        console.log(tron);

        // Search in lich_su_hieu_chinh
        const [hieu_chinh] = await connection.query('SELECT * FROM lich_su_hieu_chinh ORDER BY thoi_gian DESC LIMIT 50');
        console.log('--- LICH SU HIEU CHINH ---');
        console.log(hieu_chinh);

        await connection.end();
    } catch (e) {
        console.error('Database query failed:', e.message);
    }
}

main();
