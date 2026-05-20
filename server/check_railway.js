const https = require('https');
const http = require('http');

// Lấy URL từ tham số dòng lệnh hoặc môi trường
let targetUrl = process.argv[2] || process.env.RAILWAY_URL;

if (!targetUrl) {
    console.log('\x1b[33m%s\x1b[0m', '⚠️  Chưa cung cấp URL Railway để kiểm tra!');
    console.log('Cách dùng: node server/check_railway.js <URL_RAILWAY>');
    console.log('Ví dụ: node server/check_railway.js https://autofertilizer-iot-production.up.railway.app');
    console.log('\x1b[36m%s\x1b[0m', 'Đang sử dụng URL mặc định để demo...');
    targetUrl = 'https://autofertilizer-iot-production.up.railway.app'; // URL mẫu
}

// Chuẩn hóa URL
if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
}

console.log('\x1b[36m%s\x1b[0m', `=== HỆ THỐNG KIỂM TRA ĐỘ HOẠT ĐỘNG RAILWAY ===`);
console.log(`Kiểm tra mục tiêu: ${targetUrl}\n`);

function makeRequest(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    data: data
                });
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

async function runChecks() {
    try {
        console.log(`1. Đang kiểm tra giao diện Frontend tại: ${targetUrl}...`);
        const homeRes = await makeRequest(targetUrl);
        
        if (homeRes.statusCode === 200) {
            console.log('\x1b[32m%s\x1b[0m', '  ✓ Giao diện Frontend: Hoạt động (HTTP 200)');
            if (homeRes.data.includes('Login') || homeRes.data.includes('Đăng nhập') || homeRes.data.includes('autofertilizer')) {
                console.log('\x1b[32m%s\x1b[0m', '  ✓ Giao diện website: Hợp lệ (Đã tìm thấy form Đăng nhập)');
            } else {
                console.log('\x1b[33m%s\x1b[0m', '  ⚠️  Cảnh báo: Nội dung trang chủ có thể không đúng form.');
            }
        } else {
            console.log('\x1b[31m%s\x1b[0m', `  ✗ Giao diện Frontend: Lỗi (HTTP ${homeRes.statusCode})`);
        }
    } catch (e) {
        console.log('\x1b[31m%s\x1b[0m', `  ✗ Không thể kết nối Frontend: ${e.message}`);
    }

    console.log('\n2. Đang kiểm tra API kết nối Database tại: ' + targetUrl + '/api/recipes...');
    try {
        const apiRes = await makeRequest(targetUrl + '/api/recipes');
        if (apiRes.statusCode === 200) {
            console.log('\x1b[32m%s\x1b[0m', '  ✓ Kết nối API: Hoạt động (HTTP 200)');
            const recipes = JSON.parse(apiRes.data);
            if (Array.isArray(recipes)) {
                console.log('\x1b[32m%s\x1b[0m', `  ✓ Đồng bộ Database: Thành công (Tìm thấy ${recipes.length} công thức)`);
                // Hiển thị một số công thức tiêu biểu
                recipes.slice(0, 4).forEach(r => {
                    console.log(`    - ${r.name} (N:${r.N_ml} P:${r.P_ml} K:${r.K_ml})`);
                });
                if (recipes.length > 4) console.log(`    ... và ${recipes.length - 4} công thức khác.`);
            } else {
                console.log('\x1b[31m%s\x1b[0m', '  ✗ Phản hồi từ API không đúng định dạng JSON Array.');
            }
        } else {
            console.log('\x1b[31m%s\x1b[0m', `  ✗ Lỗi API/Database: HTTP ${apiRes.statusCode}`);
        }
    } catch (e) {
        console.log('\x1b[31m%s\x1b[0m', `  ✗ Không thể kết nối API: ${e.message}`);
    }

    console.log('\n=============================================');
}

runChecks();
