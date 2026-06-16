const mysql = require('mysql2/promise');
async function run() {
    const pool = mysql.createPool({
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'csdl_phoi_tron_phan'
    });
    
    await pool.query('DELETE FROM cong_thuc');
    console.log('Da xoa tat ca cong thuc cu.');
    
    // Insert new current dynamic recipe based on user's current logic
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const id = Date.now().toString();
    const query = `
        INSERT INTO cong_thuc (ma_cong_thuc, ten_cong_thuc, the_tich_bon1_ml, the_tich_bon2_ml, the_tich_bon3_ml, mo_ta, ngay_tao)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    const values = [
        id, "Cà chua - 2400 cây (2L/cây)", 480, 480, 480, 
        "Tỉ lệ 1/100 tự động tính toán", timestamp
    ];
    await pool.query(query, values);
    
    console.log('Da luu cong thuc hien tai.');
    await pool.end();
}
run();
