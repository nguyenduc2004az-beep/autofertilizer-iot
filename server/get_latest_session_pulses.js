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

        // Get the latest mixing session details
        const [sessions] = await connection.query(`
            SELECT * FROM lich_su_tron 
            ORDER BY thoi_gian_tron DESC LIMIT 5
        `);
        console.log('--- LATEST MIXING SESSIONS ---');
        console.log(JSON.stringify(sessions, null, 2));

        // Get the latest calibration history entries
        const [calibs] = await connection.query(`
            SELECT * FROM lich_su_hieu_chinh 
            ORDER BY thoi_gian DESC LIMIT 20
        `);
        console.log('--- LATEST CALIBRATIONS ---');
        console.log(JSON.stringify(calibs, null, 2));

        await connection.end();
    } catch (e) {
        console.error('Database query failed:', e.message);
    }
}

main();
