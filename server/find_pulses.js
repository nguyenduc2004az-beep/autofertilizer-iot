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

        // Search for pulses or volumes around 455, 799, 593
        const [rows] = await connection.query(`
            SELECT * FROM lich_su_hieu_chinh 
            WHERE xung IN (455, 799, 593) 
               OR the_tich_ml IN (455, 799, 593)
            ORDER BY thoi_gian DESC
        `);
        console.log('--- EXACT MATCHES ---');
        console.log(rows);

        // Let's search for any run with duration_s between 5 and 70
        const [rows_time] = await connection.query(`
            SELECT * FROM lich_su_hieu_chinh 
            WHERE thoi_gian_chay_s BETWEEN 5 AND 70
            ORDER BY thoi_gian DESC LIMIT 50
        `);
        console.log('--- RUNS WITH DURATION 5s to 70s ---');
        console.log(rows_time.map(r => ({
            id: r.id,
            chu_ky: r.chu_ky,
            cam_bien: r.cam_bien,
            the_tich_ml: r.the_tich_ml,
            xung: r.xung,
            luu_luong: r.luu_luong_tb_lpm,
            giay: r.thoi_gian_chay_s
        })));

        await connection.end();
    } catch (e) {
        console.error('Database query failed:', e.message);
    }
}

main();
