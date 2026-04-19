const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'db.json');

let db = { sessions: [], recipes: [] };

try {
  if (fs.existsSync(dbPath)) {
    db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  }
} catch (e) {
  console.log("Error reading db.json", e);
}

// 1. Thêm 4 công thức cà chua
const newRecipes = [
  {
    id: "recipe_tomato_1",
    name: "Cà chua 1: Phục hồi (Tuần 1-2)",
    N_ml: 250, P_ml: 500, K_ml: 250, 
    description: "Kích thích rễ, nảy chồi (Tỷ lệ 1:2:1)",
    created_at: new Date().toISOString()
  },
  {
    id: "recipe_tomato_2",
    name: "Cà chua 2: Thân lá (Tuần 3-5)",
    N_ml: 400, P_ml: 200, K_ml: 400,
    description: "Phát triển bộ lá và đốt (Tỷ lệ 2:1:2)",
    created_at: new Date().toISOString()
  },
  {
    id: "recipe_tomato_3",
    name: "Cà chua 3: Ra hoa (Tuần 6-8)",
    N_ml: 220, P_ml: 330, K_ml: 450,
    description: "Phân hóa mầm hoa, đậu trái (Tỷ lệ 1:1.5:2)",
    created_at: new Date().toISOString()
  },
  {
    id: "recipe_tomato_4",
    name: "Cà chua 4: Nuôi trái (Tuần 9+)",
    N_ml: 200, P_ml: 200, K_ml: 600,
    description: "Lớn trái, lên màu, ngọt nước (Tỷ lệ 1:1:3)",
    created_at: new Date().toISOString()
  }
];

// Tránh trùng lặp nếu script chạy nhiều lần
newRecipes.forEach(nr => {
  if (!db.recipes.find(r => r.id === nr.id)) {
    db.recipes.push(nr);
  }
});

// 2. Thêm 4 lịch sử chạy mẫu (Lưu vô lịch sử)
const now = Date.now();
const oneDay = 24 * 60 * 60 * 1000;

const mockSessions = [
  {
    id: now - 3 * oneDay,
    timestamp: new Date(now - 3 * oneDay).toISOString(),
    recipe_name: "Cà chua 1: Phục hồi (Tuần 1-2)",
    mode: "simultaneous",
    ratio_n: 25, ratio_p: 50, ratio_k: 25,
    N_ml: 8000, P_ml: 16000, K_ml: 8000, // mL
    total_ml: 32000,
    duration_s: 480,
    status: "completed",
    wifi_rssi: -55
  },
  {
    id: now - 2 * oneDay,
    timestamp: new Date(now - 2 * oneDay).toISOString(),
    recipe_name: "Cà chua 2: Thân lá (Tuần 3-5)",
    mode: "simultaneous",
    ratio_n: 40, ratio_p: 20, ratio_k: 40,
    N_ml: 24000, P_ml: 12000, K_ml: 24000,
    total_ml: 60000,
    duration_s: 900,
    status: "completed",
    wifi_rssi: -58
  },
  {
    id: now - 1 * oneDay,
    timestamp: new Date(now - 1 * oneDay).toISOString(),
    recipe_name: "Cà chua 3: Ra hoa (Tuần 6-8)",
    mode: "simultaneous",
    ratio_n: 22, ratio_p: 33, ratio_k: 45,
    N_ml: 19800, P_ml: 29700, K_ml: 40500,
    total_ml: 90000,
    duration_s: 1350,
    status: "completed",
    wifi_rssi: -52
  },
  {
    id: now,
    timestamp: new Date(now).toISOString(),
    recipe_name: "Cà chua 4: Nuôi trái (Tuần 9+)",
    mode: "simultaneous",
    ratio_n: 20, ratio_p: 20, ratio_k: 60,
    N_ml: 30000, P_ml: 30000, K_ml: 90000,
    total_ml: 150000, // 150 Liters
    duration_s: 2250, // 37.5 minutes
    status: "completed",
    wifi_rssi: -50
  }
];

// Unshift (cho lên đầu) để nó xuất hiện mới nhất
mockSessions.reverse().forEach(s => {
  db.sessions.unshift(s);
});

// Ghi lại database
fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
console.log('Đã nhập thành công 4 công thức và sinh lịch sử hoàn tất!');
