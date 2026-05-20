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
        const [rows] = await connection.query('DESCRIBE lich_hen');
        console.log('--- LICH_HEN TABLE COLUMNS ---');
        console.log(rows);
        await connection.end();
    } catch (e) {
        console.error('Database query failed:', e);
    }
}

main();
