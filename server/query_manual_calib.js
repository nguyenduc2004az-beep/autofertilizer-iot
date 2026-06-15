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
        
        // Find distinct notes
        const [notes] = await connection.query('SELECT DISTINCT ghi_chu FROM lich_su_hieu_chinh');
        console.log('--- DISTINCT NOTES ---');
        console.log(notes);

        // Find non-automatic entries
        const [manual] = await connection.query(`
            SELECT * FROM lich_su_hieu_chinh 
            WHERE ghi_chu NOT LIKE '%Tự động%' 
            ORDER BY thoi_gian DESC LIMIT 20
        `);
        console.log('--- MANUAL CALIBRATION ENTRIES ---');
        console.log(manual);
        
        await connection.end();
    } catch (e) {
        console.error('Database query failed:', e.message);
    }
}

main();
