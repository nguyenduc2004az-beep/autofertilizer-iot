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
        
        const [recent] = await connection.query(`
            SELECT * FROM lich_su_tron 
            ORDER BY thoi_gian_tron DESC LIMIT 5
        `);
        console.log('--- RECENT MIXING SESSIONS ---');
        console.log(recent);
        
        await connection.end();
    } catch (e) {
        console.error('Database query failed:', e.message);
    }
}

main();
