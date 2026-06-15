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
        console.log('Đã kết nối cơ sở dữ liệu.');
        
        // 1. Query 3 most recent mixing sessions
        const [recentSessions] = await connection.query(`
            SELECT ma_lich_su AS id, thoi_gian_tron AS thoi_gian, ten_cong_thuc_da_dung AS cong_thuc,
                   che_do_tron AS che_do, thuc_te_bon1_ml AS N_ml, thuc_te_bon2_ml AS P_ml, thuc_te_bon3_ml AS K_ml,
                   tong_the_tich_ml AS total_ml, thoi_gian_chay_s AS duration_s, trang_thai
            FROM lich_su_tron 
            ORDER BY thoi_gian_tron DESC LIMIT 3
        `);
        console.log('\n--- 3 PHIÊN PHỐI TRỘN GẦN NHẤT ---');
        console.log(JSON.stringify(recentSessions, null, 2));

        // 2. Query 3 most recent calibration runs
        const [recentCalibs] = await connection.query(`
            SELECT id, thoi_gian, chu_ky, cam_bien, the_tich_ml, xung, luu_luong_tb_lpm, thoi_gian_chay_s, ghi_chu
            FROM lich_su_hieu_chinh 
            ORDER BY thoi_gian DESC, id DESC LIMIT 12
        `);
        console.log('\n--- CÁC LẦN ĐO HIỆU CHUẨN GẦN NHẤT ---');
        console.log(JSON.stringify(recentCalibs, null, 2));
        
        await connection.end();
    } catch (e) {
        console.error('Lỗi truy vấn database:', e.message);
    }
}

main();
